// A renter whose ticket is revoked is put out, and nothing more is relayed to or
// from it. The session-end notice does it at once, however the platform ends
// the session. A ticket revoked straight in the database, behind the server's
// back, is caught by the host registration check, a join and the slow
// reconcile; relayed frames never read the database.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { mintRenterSession } from "../access.js";
import type { SignalMessage } from "../protocol.js";
import { SESSION_COOKIE } from "../signin.js";
import { serverDatabase, type ServerDatabase } from "./db.js";
import { REPORT } from "./report.js";

const SERVER = fileURLToPath(new URL("../index.js", import.meta.url));
const SECRET = "test-room-secret-that-is-long-enough-to-pass";
const MACHINE_KEY = "test-machine-key";
const HASH = createHash("sha256").update(MACHINE_KEY).digest("hex");
const SESSION = "test-session-secret-that-is-long-enough-too";
/** A signed-in renter: booking and claiming need one. */
const RENTER_COOKIE = `${SESSION_COOKIE}=${mintRenterSession(SESSION, "76561198000000001", 3600)}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const servers: ChildProcess[] = [];
const databases: ServerDatabase[] = [];

after(async () => {
  await Promise.all(
    servers.map((server) => {
      if (server.exitCode !== null || server.signalCode !== null) return;
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill();
      return exited;
    }),
  );
  for (const database of databases) await database.close();
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

/** A server on a database of its own, with the ticket reconcile every `reconcileMs`. */
async function startServer(reconcileMs: number) {
  const port = freshPort();
  const database = await serverDatabase();
  databases.push(database);
  servers.push(
    spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT: String(port),
        ROOM_SECRET: SECRET,
        SESSION_SECRET: SESSION,
        MACHINE_KEYS: `pc-1:${HASH},pc-2:${HASH}`,
        DATABASE_URL: database.url,
        SWIFF_TICKET_RECONCILE_MS: String(reconcileMs),
      },
      stdio: "ignore",
    }),
  );
  const origin = `http://localhost:${port}`;
  // Up to 15 s: the server opens its database before it listens, slower under a full test run.
  for (let i = 0; i < 150; i++) {
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

  /** Offer `room`, book and claim it: the renter's join ticket and the session it is for. */
  const claimTicket = async (room: string): Promise<{ ticket: string; sessionId: string }> => {
    await call("PUT", `/api/machines/${room}/availability`, { available: true, ...REPORT }, MACHINE_KEY);
    const booking = await call("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    const claim = await call("POST", `/api/bookings/${booking.body.bookingId}/claim`);
    assert.equal(claim.status, 200);
    return { ticket: claim.body.ticket as string, sessionId: claim.body.sessionId as string };
  };

  /** End every open session in the database without telling the server: its tickets are revoked. */
  const revokeBehindTheServersBack = () =>
    database.exec(`UPDATE sessions SET ended_at = ${Date.now()} WHERE ended_at IS NULL`);

  /** Let every open session run out, without telling the server. */
  const runOutBehindTheServersBack = () =>
    database.exec(`UPDATE sessions SET expires_at = ${Date.now()} WHERE ended_at IS NULL`);

  /**
   * A socket that sends `first` once open and records what it hears and how it
   * closes. Told it is denied, it sends one more ice frame, "after", before the
   * server's hang-up reaches it.
   */
  const peer = (first: SignalMessage) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const received: SignalMessage[] = [];
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as SignalMessage;
      received.push(message);
      if (message.type === "denied") ws.send(JSON.stringify(AFTER));
    });
    ws.once("open", () => ws.send(JSON.stringify(first)));
    const closed = new Promise<number>((resolve) => ws.once("close", resolve));
    return { ws, received, closed };
  };

  return { call, claimTicket, revokeBehindTheServersBack, runOutBehindTheServersBack, peer };
}

const ICE = { type: "ice", candidate: { candidate: "before" } } as SignalMessage;
const AFTER = { type: "ice", candidate: { candidate: "after" } } as SignalMessage;
const iceFrames = (received: SignalMessage[]) =>
  received.filter((m) => m.type === "ice").map((m) => (m as { candidate: { candidate: string } }).candidate.candidate);

/** Up to 5 s for `check` to hold: registering and joining each wait on the database. */
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await wait(50);
};

/** A host in `room` and a renter seated on `ticket`, the renter's first frame relayed. */
async function seat(server: Awaited<ReturnType<typeof startServer>>, room: string, ticket: string) {
  const host = server.peer({ type: "register", hostId: room, key: MACHINE_KEY });
  await until(() => host.received.some((m) => m.type === "registered"));
  const renter = server.peer({ type: "join", ticket });
  await until(() => renter.received.length > 0);
  assert.equal(renter.received[0]?.type, "joined");
  renter.ws.send(JSON.stringify(ICE));
  await until(() => iceFrames(host.received).length > 0);
  assert.deepEqual(iceFrames(host.received), ["before"]);
  return { host, renter };
}

/** The renter was put out with bad-ticket, and nothing it sent once put out reached the host. */
async function putOut(
  host: ReturnType<Awaited<ReturnType<typeof startServer>>["peer"]>,
  renter: ReturnType<Awaited<ReturnType<typeof startServer>>["peer"]>,
) {
  assert.equal(await renter.closed, 4003);
  assert.deepEqual(renter.received.at(-1), { type: "denied", reason: "bad-ticket" });
  host.ws.send(JSON.stringify(AFTER));
  await wait(200);
  assert.deepEqual(iceFrames(host.received), ["before"], "nothing from the renter once put out");
  assert.deepEqual(iceFrames(renter.received), [], "nothing to the renter");
}

describe("revoked ticket through the platform", () => {
  it("puts the renter out at once when the host ends the session", { timeout: 60_000 }, async () => {
    const server = await startServer(60_000);
    const { ticket, sessionId } = await server.claimTicket("pc-1");
    const { host, renter } = await seat(server, "pc-1", ticket);
    assert.equal((await server.call("POST", `/api/sessions/${sessionId}/end`, {}, MACHINE_KEY)).status, 200);
    await putOut(host, renter);
    host.ws.close();
  });

  it("puts the renter out at once when the owner takes the machine back", { timeout: 60_000 }, async () => {
    const server = await startServer(60_000);
    const { ticket } = await server.claimTicket("pc-1");
    const { host, renter } = await seat(server, "pc-1", ticket);
    const back = await server.call("PUT", "/api/machines/pc-1/availability", { available: false }, MACHINE_KEY);
    assert.equal(back.status, 200);
    await putOut(host, renter);
    host.ws.close();
  });

  it("puts the renter out at once when the time runs out", { timeout: 60_000 }, async () => {
    const server = await startServer(60_000);
    const { ticket } = await server.claimTicket("pc-1");
    const { host, renter } = await seat(server, "pc-1", ticket);
    await server.runOutBehindTheServersBack();
    // Any call that settles what is due ends it, as the platform's timer would.
    const offered = await server.call(
      "PUT",
      "/api/machines/pc-1/availability",
      { available: true, ...REPORT },
      MACHINE_KEY,
    );
    assert.equal(offered.status, 200);
    await putOut(host, renter);
    host.ws.close();
  });
});

describe("revoked ticket without the session-end notice", () => {
  it(
    "relays without reading the database per frame, and nothing for the renter once a join finds it revoked",
    { timeout: 60_000 },
    async () => {
      const server = await startServer(60_000);
      const { ticket } = await server.claimTicket("pc-1");
      const { host, renter } = await seat(server, "pc-1", ticket);

      await server.revokeBehindTheServersBack();
      renter.ws.send(JSON.stringify({ type: "ice", candidate: { candidate: "unchecked" } }));
      await until(() => iceFrames(host.received).length > 1);
      assert.deepEqual(iceFrames(host.received), ["before", "unchecked"], "relayed from memory");

      const again = server.peer({ type: "join", ticket });
      assert.equal(await again.closed, 4003);
      assert.deepEqual(again.received[0], { type: "denied", reason: "bad-ticket" });
      assert.equal(await renter.closed, 4003);
      assert.deepEqual(renter.received.at(-1), { type: "denied", reason: "bad-ticket" });
      await wait(200);
      assert.deepEqual(iceFrames(host.received), ["before", "unchecked"], "nothing once revoked");
      host.ws.close();
    },
  );

  it(
    "puts a waiting renter out when the host registers, without telling the host it is there",
    { timeout: 60_000 },
    async () => {
      const server = await startServer(60_000);
      const { ticket } = await server.claimTicket("pc-1");
      const renter = server.peer({ type: "join", ticket });
      await until(() => renter.received.length > 0);
      assert.equal(renter.received[0]?.type, "joined");

      await server.revokeBehindTheServersBack();
      const host = server.peer({ type: "register", hostId: "pc-1", key: MACHINE_KEY });
      assert.equal(await renter.closed, 4003);
      assert.deepEqual(renter.received.at(-1), { type: "denied", reason: "bad-ticket" });
      await wait(100);
      assert.ok(!host.received.some((m) => m.type === "peer-joined"));
      host.ws.close();
    },
  );

  it("puts a silent renter out at the next reconcile", { timeout: 60_000 }, async () => {
    const server = await startServer(200);
    const { ticket } = await server.claimTicket("pc-2");
    const renter = server.peer({ type: "join", ticket });
    await until(() => renter.received.length > 0);
    assert.equal(renter.received[0]?.type, "joined");

    await server.revokeBehindTheServersBack();
    assert.equal(await renter.closed, 4003);
    assert.deepEqual(renter.received.at(-1), { type: "denied", reason: "bad-ticket" });
  });
});
