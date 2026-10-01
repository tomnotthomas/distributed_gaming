// A renter whose ticket is revoked is put out even when the session-end notice
// that normally does it never ran. The ticket is revoked here by ending the
// session straight in the database file, behind the server's back: only the
// relay check, the host registration check and the slow reconcile can see it.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { mintRenterSession } from "../access.js";
import type { SignalMessage } from "../protocol.js";
import { SESSION_COOKIE } from "../signin.js";
import { REPORT } from "./report.js";

const SERVER = fileURLToPath(new URL("../index.js", import.meta.url));
const SECRET = "test-room-secret-that-is-long-enough-to-pass";
const MACHINE_KEY = "test-machine-key";
const HASH = createHash("sha256").update(MACHINE_KEY).digest("hex");
const SESSION = "test-session-secret-that-is-long-enough-too";
/** A signed-in renter: booking and claiming need one. */
const RENTER_COOKIE = `${SESSION_COOKIE}=${mintRenterSession(SESSION, "76561198000000001", 3600)}`;
const DIR = mkdtempSync(join(tmpdir(), "swiff-revocation-"));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const servers: ChildProcess[] = [];

after(() => {
  for (const server of servers) server.kill();
  rmSync(DIR, { recursive: true, force: true });
});

/** Ports already given to a server here: each child server gets its own. */
const usedPorts = new Set<number>();

/** A random port in the test range that no server here has yet. */
function freshPort(): number {
  let port: number;
  do port = 9300 + Math.floor(Math.random() * 600);
  while (usedPorts.has(port));
  usedPorts.add(port);
  return port;
}

/** A server on its own database file, with the ticket reconcile every `reconcileMs`. */
async function startServer(name: string, reconcileMs: number) {
  const port = freshPort();
  const databasePath = join(DIR, `${name}.db`);
  servers.push(
    spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT: String(port),
        ROOM_SECRET: SECRET,
        SESSION_SECRET: SESSION,
        MACHINE_KEYS: `pc-1:${HASH},pc-2:${HASH}`,
        DATABASE_PATH: databasePath,
        SWIFF_TICKET_RECONCILE_MS: String(reconcileMs),
      },
      stdio: "ignore",
    }),
  );
  const origin = `http://localhost:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${origin}/api/bookings/none`);
      break;
    } catch {
      await wait(100);
    }
  }

  /** One JSON call: with the machine key as bearer when given one, else as the signed-in renter. */
  const call = async (method: string, path: string, body?: unknown, key?: string) => {
    const res = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : { cookie: RENTER_COOKIE }),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  /** Offer `room`, book and claim it: the renter's join ticket. */
  const claimTicket = async (room: string): Promise<string> => {
    await call("PUT", `/api/machines/${room}/availability`, { available: true, ...REPORT }, MACHINE_KEY);
    const booking = await call("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    const claim = await call("POST", `/api/bookings/${booking.body.bookingId}/claim`);
    assert.equal(claim.status, 200);
    return claim.body.ticket as string;
  };

  /** End every open session in the file without telling the server: its tickets are revoked. */
  const revokeBehindTheServersBack = () => {
    const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL").run(Date.now());
    db.close();
  };

  /** A socket that sends `first` once open and records what it hears and how it closes. */
  const peer = (first: SignalMessage) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const received: SignalMessage[] = [];
    ws.on("message", (raw) => received.push(JSON.parse(String(raw)) as SignalMessage));
    ws.once("open", () => ws.send(JSON.stringify(first)));
    const closed = new Promise<number>((resolve) => ws.once("close", resolve));
    return { ws, received, closed };
  };

  return { claimTicket, revokeBehindTheServersBack, peer };
}

describe("revoked ticket without the session-end notice", () => {
  it(
    "puts the renter out on its next relayed frame, and relays nothing for it",
    { timeout: 15_000 },
    async () => {
      const server = await startServer("relay", 60_000);
      const ticket = await server.claimTicket("pc-1");
      const host = server.peer({ type: "register", hostId: "pc-1", key: MACHINE_KEY });
      await wait(200);
      const renter = server.peer({ type: "join", ticket });
      await wait(200);
      assert.equal(renter.received[0]?.type, "joined");

      server.revokeBehindTheServersBack();
      renter.ws.send(JSON.stringify({ type: "ice", candidate: { candidate: "x" } }));
      assert.equal(await renter.closed, 4003);
      assert.deepEqual(renter.received.at(-1), { type: "denied", reason: "bad-ticket" });
      await wait(100);
      assert.ok(!host.received.some((m) => m.type === "ice"), "the frame never reached the host");
      host.ws.close();
    },
  );

  it(
    "puts a waiting renter out when the host registers, without telling the host it is there",
    { timeout: 15_000 },
    async () => {
      const server = await startServer("register", 60_000);
      const ticket = await server.claimTicket("pc-1");
      const renter = server.peer({ type: "join", ticket });
      await wait(200);
      assert.equal(renter.received[0]?.type, "joined");

      server.revokeBehindTheServersBack();
      const host = server.peer({ type: "register", hostId: "pc-1", key: MACHINE_KEY });
      assert.equal(await renter.closed, 4003);
      assert.deepEqual(renter.received.at(-1), { type: "denied", reason: "bad-ticket" });
      await wait(100);
      assert.ok(!host.received.some((m) => m.type === "peer-joined"));
      host.ws.close();
    },
  );

  it("puts a silent renter out at the next reconcile", { timeout: 15_000 }, async () => {
    const server = await startServer("reconcile", 200);
    const ticket = await server.claimTicket("pc-2");
    const renter = server.peer({ type: "join", ticket });
    await wait(150);
    assert.equal(renter.received[0]?.type, "joined");

    server.revokeBehindTheServersBack();
    assert.equal(await renter.closed, 4003);
    assert.deepEqual(renter.received.at(-1), { type: "denied", reason: "bad-ticket" });
  });
});
