// A server restart keeps live host sessions: the database file holds them, so
// a streamer whose key was granted before the restart still gets in after it,
// the machine key is still kept out, and ending the session still kills the key.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { sessionPath, type SessionGrant, type SignalMessage } from "../protocol.js";
import { REPORT } from "./report.js";

const SERVER = fileURLToPath(new URL("../index.js", import.meta.url));
const PORT = 8900 + Math.floor(Math.random() * 300);
const SECRET = "test-room-secret-that-is-long-enough-to-pass";
const MACHINE_KEY = "test-machine-key";
const HASH = createHash("sha256").update(MACHINE_KEY).digest("hex");
const DIR = mkdtempSync(join(tmpdir(), "swiff-restart-"));
const DATABASE_PATH = join(DIR, "swiff.db");

let server: ChildProcess | undefined;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start the server on the shared database file and wait until it answers. */
async function startServer(): Promise<void> {
  server = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ROOM_SECRET: SECRET,
      MACHINE_KEYS: `pc-1:${HASH}`,
      DATABASE_PATH,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://localhost:${PORT}/api/bookings/none`);
      return;
    } catch {
      await wait(100);
    }
  }
  throw new Error("server did not start");
}

/** Stop the server and wait until it has exited, so the next one can take the port. */
async function stopServer(): Promise<void> {
  if (!server) return;
  const exited = new Promise((resolve) => server!.once("exit", resolve));
  server.kill();
  await exited;
  server = undefined;
}

/** One JSON call, with the machine key as bearer when given one. */
async function call(method: string, path: string, body?: unknown, key?: string) {
  const res = await fetch(`http://localhost:${PORT}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

/** Register on pc-1 with `credential` and resolve with the first answer. */
function register(credential: { key: string } | { sessionKey: string }): Promise<SignalMessage> {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  return new Promise<SignalMessage>((resolve, reject) => {
    ws.once("open", () => ws.send(JSON.stringify({ type: "register", hostId: "pc-1", ...credential })));
    ws.once("message", (raw) => {
      resolve(JSON.parse(String(raw)) as SignalMessage);
      ws.close();
    });
    ws.once("error", reject);
  });
}

after(async () => {
  await stopServer();
  rmSync(DIR, { recursive: true, force: true });
});

describe("server restart", () => {
  it("keeps a live host session and its key across a restart", async () => {
    await startServer();
    await call("PUT", "/api/machines/pc-1/availability", { available: true, ...REPORT }, MACHINE_KEY);
    const booking = await call("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    const claim = await call("POST", `/api/bookings/${booking.body.bookingId}/claim`);
    assert.equal(claim.status, 200);
    const started = await call("POST", sessionPath("pc-1"), { sessionId: claim.body.sessionId }, MACHINE_KEY);
    // The status only: the body carries the session key.
    assert.equal(started.status, 201);
    const grant = started.body as SessionGrant;

    await stopServer();
    await startServer();

    assert.equal((await register({ sessionKey: grant.sessionKey })).type, "registered");
    assert.deepEqual(await register({ key: MACHINE_KEY }), { type: "denied", reason: "session-active" });
    assert.deepEqual(await call("POST", sessionPath("pc-1"), { sessionId: grant.sessionId }, MACHINE_KEY), {
      status: 409,
      body: { error: "session-active" },
    });

    assert.equal((await call("POST", `/api/sessions/${grant.sessionId}/end`, {}, MACHINE_KEY)).status, 200);
    assert.deepEqual(await register({ sessionKey: grant.sessionKey }), {
      type: "denied",
      reason: "bad-session-key",
    });
  });
});
