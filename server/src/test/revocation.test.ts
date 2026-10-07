// A renter whose ticket is revoked is put out, and nothing more is relayed to or
// from it. The session-end notice does it as the end commits, however the
// platform ends the session, so the very next frame is refused. A ticket
// revoked straight in the database, behind the server's back, is caught by the
// next relayed frame, which waits for the database to say, and by the host
// registration check, a join and the reconcile within a few seconds. A ticket
// that runs out while its join waits on the database joins nothing.

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import pg from "pg";
import { WebSocket } from "ws";
import { mintRenterSession, mintTicket } from "../access.js";
import type { SignalMessage } from "../protocol.js";
import { SESSION_COOKIE } from "../signin.js";
import { startServer as spawnServer, stopServer, until, wait, within } from "./child.js";
import { serverDatabase, type ServerDatabase } from "./db.js";
import { REPORT } from "./report.js";

const SECRET = "test-room-secret-that-is-long-enough-to-pass";
const MACHINE_KEY = "test-machine-key";
const HASH = createHash("sha256").update(MACHINE_KEY).digest("hex");
const SESSION = "test-session-secret-that-is-long-enough-too";
/** A signed-in renter: booking and claiming need one. */
const RENTER_COOKIE = `${SESSION_COOKIE}=${mintRenterSession(SESSION, "76561198000000001", 3600)}`;
/** Each test's bound: a server of its own and a database to open, slow on a loaded machine. */
const TIMEOUT = { timeout: 120_000 };
const servers: ChildProcess[] = [];
const databases: ServerDatabase[] = [];
/** Every socket and database client a test opened: a test that fails midway leaves them open. */
const sockets: WebSocket[] = [];
const clients: pg.Client[] = [];

// Each test's server and database go when the test ends, not with the file: a
// PGlite in this process holds a few hundred MB, and a dozen at once is gigabytes.
// Every wait here is bounded, so a stuck child or database cannot hang the run,
// and every socket and client goes too: any one left open holds the file open.
afterEach(
  async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    for (const client of clients.splice(0)) await within(client.end(), 5_000, null).catch(() => {});
    await Promise.all(servers.splice(0).map(stopServer));
    for (const database of databases.splice(0)) await within(database.close(), 10_000, null).catch(() => {});
  },
  { timeout: 30_000 },
);

/**
 * A server on a database of its own, with the ticket reconcile every
 * `reconcileMs` and seats trusted unconfirmed for `unconfirmedMs` (omitted:
 * as in production).
 */
async function startServer(reconcileMs?: number, unconfirmedMs?: number) {
  const database = await serverDatabase();
  databases.push(database);
  const { child, port } = await spawnServer(
    {
      ROOM_SECRET: SECRET,
      SESSION_SECRET: SESSION,
      MACHINE_KEYS: `pc-1:${HASH},pc-2:${HASH}`,
      DATABASE_URL: database.url,
      // Every game playable, so nothing here waits on or calls Steam (playable.ts).
      SWIFF_PLAYABILITY: "off",
      ...(reconcileMs === undefined ? {} : { SWIFF_TICKET_RECONCILE_MS: String(reconcileMs) }),
      ...(unconfirmedMs === undefined ? {} : { SWIFF_TICKET_UNCONFIRMED_MS: String(unconfirmedMs) }),
    },
    { from: 9300, span: 600 },
  );
  servers.push(child);
  const origin = `http://localhost:${port}`;

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
    sockets.push(ws);
    const received: SignalMessage[] = [];
    /** Waiting on the pongs to settled()'s pings, oldest first. */
    const pongs: (() => void)[] = [];
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as SignalMessage;
      if (message.type === "pong" && pongs.length) return pongs.shift()!();
      received.push(message);
      if (message.type === "denied") ws.send(JSON.stringify(AFTER));
    });
    ws.once("open", () => ws.send(JSON.stringify(first)));
    const closed = new Promise<number>((resolve) => ws.once("close", resolve));
    closed.then(() => pongs.splice(0).forEach((done) => done()));
    /**
     * Once the server has handled everything this socket sent: it takes a
     * socket's frames in turn, relays that wait on the database included, so
     * its pong to a ping sent now comes after them, and after whatever it
     * sent this socket before.
     */
    const settled = async () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const pong = new Promise<boolean>((resolve) => pongs.push(() => resolve(true)));
      ws.send(JSON.stringify({ type: "ping" }));
      assert.ok(await within(pong, 30_000, false), "no pong within 30 s");
    };
    return { ws, received, closed, settled };
  };

  /** Make every read of the sessions table fail, behind the server's back, until `restoreSessions`. */
  const breakSessions = () => database.exec("ALTER TABLE sessions RENAME TO sessions_away");
  const restoreSessions = () => database.exec("ALTER TABLE sessions_away RENAME TO sessions");

  /** Hold every read of the sessions table, behind the server's back, until the returned release. */
  const holdSessions = async () => {
    const client = new pg.Client({ connectionString: database.url });
    clients.push(client);
    await client.connect();
    await client.query("BEGIN");
    await client.query("LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE");
    return async () => {
      await client.query("COMMIT");
      await client.end();
    };
  };

  return {
    call,
    claimTicket,
    revokeBehindTheServersBack,
    runOutBehindTheServersBack,
    breakSessions,
    restoreSessions,
    holdSessions,
    peer,
  };
}

const ICE = { type: "ice", candidate: { candidate: "before" } } as SignalMessage;
const AFTER = { type: "ice", candidate: { candidate: "after" } } as SignalMessage;
/** Sent the moment the call that ends the session has answered. */
const NEXT = { type: "ice", candidate: { candidate: "next" } } as SignalMessage;
const iceFrames = (received: SignalMessage[]) =>
  received
    .filter((m) => m.type === "ice")
    .map((m) => (m as { candidate: { candidate: string } }).candidate.candidate);

/** A host in `room` and a renter seated on `ticket`, the renter's first frame relayed. */
async function seat(server: Awaited<ReturnType<typeof startServer>>, room: string, ticket: string) {
  const host = server.peer({ type: "register", hostId: room, key: MACHINE_KEY });
  await until(() => host.received.some((m) => m.type === "registered"), "the host registered");
  const renter = server.peer({ type: "join", ticket });
  await until(() => renter.received.length > 0, "the renter heard back on its join");
  assert.equal(renter.received[0]?.type, "joined");
  renter.ws.send(JSON.stringify(ICE));
  await until(() => iceFrames(host.received).length > 0, "the renter's first frame reached the host");
  assert.deepEqual(iceFrames(host.received), ["before"]);
  return { host, renter };
}

type Peer = ReturnType<Awaited<ReturnType<typeof startServer>>["peer"]>;

/** Both sides send a frame at once, as soon as the call that revoked the ticket has answered. */
function sendNext(host: Peer, renter: Peer) {
  renter.ws.send(JSON.stringify(NEXT));
  host.ws.send(JSON.stringify(NEXT));
}

/**
 * The renter was put out with bad-ticket, and nothing either side sent since
 * reached the other. Anything relayed to the host went before the renter was
 * put out, so before the host's pong; the renter's socket is closed, so what
 * it heard is all it will.
 */
async function putOut(host: Peer, renter: Peer) {
  assert.equal(await renter.closed, 4003);
  assert.deepEqual(renter.received.at(-1), { type: "denied", reason: "bad-ticket" });
  host.ws.send(JSON.stringify(AFTER));
  await host.settled();
  assert.deepEqual(iceFrames(host.received), ["before"], "nothing from the renter once put out");
  assert.deepEqual(iceFrames(renter.received), [], "nothing to the renter");
}

describe("revoked ticket through the platform", () => {
  it("puts the renter out at once when the host ends the session", TIMEOUT, async () => {
    const server = await startServer(60_000);
    const { ticket, sessionId } = await server.claimTicket("pc-1");
    const { host, renter } = await seat(server, "pc-1", ticket);
    assert.equal((await server.call("POST", `/api/sessions/${sessionId}/end`, {}, MACHINE_KEY)).status, 200);
    sendNext(host, renter);
    await putOut(host, renter);
    host.ws.close();
  });

  it("puts the renter out at once when the renter leaves", TIMEOUT, async () => {
    const server = await startServer(60_000);
    const { ticket, sessionId } = await server.claimTicket("pc-1");
    const { host, renter } = await seat(server, "pc-1", ticket);
    assert.equal((await server.call("POST", `/api/sessions/${sessionId}/leave`, {}, ticket)).status, 200);
    sendNext(host, renter);
    await putOut(host, renter);
    host.ws.close();
  });

  it("puts the renter out at once when the owner takes the machine back", TIMEOUT, async () => {
    const server = await startServer(60_000);
    const { ticket } = await server.claimTicket("pc-1");
    const { host, renter } = await seat(server, "pc-1", ticket);
    const back = await server.call(
      "PUT",
      "/api/machines/pc-1/availability",
      { available: false },
      MACHINE_KEY,
    );
    assert.equal(back.status, 200);
    sendNext(host, renter);
    await putOut(host, renter);
    host.ws.close();
  });

  it("puts the renter out at once when the time runs out", TIMEOUT, async () => {
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
    sendNext(host, renter);
    await putOut(host, renter);
    host.ws.close();
  });

  it("puts the renter out once the machine has gone silent", TIMEOUT, async () => {
    const server = await startServer(60_000);
    const { ticket } = await server.claimTicket("pc-1");
    const { host, renter } = await seat(server, "pc-1", ticket);
    // A claimed PC's socket going leaves it the liveness window to come back;
    // past that, the platform's own timer takes it offline and ends the session.
    host.ws.close();
    await until(() => renter.received.some((m) => m.type === "peer-left"), "the renter heard the PC left");
    assert.equal(await renter.closed, 4003);
    assert.deepEqual(renter.received.at(-1), { type: "denied", reason: "bad-ticket" });
    const again = server.peer({ type: "join", ticket });
    assert.equal(await again.closed, 4003);
  });
});

describe("revoked ticket without the session-end notice", () => {
  it("relays nothing from the very next frame, and puts the renter out", TIMEOUT, async () => {
    const server = await startServer(60_000);
    const { ticket } = await server.claimTicket("pc-1");
    const { host, renter } = await seat(server, "pc-1", ticket);

    await server.revokeBehindTheServersBack();
    sendNext(host, renter);
    await putOut(host, renter);
    const again = server.peer({ type: "join", ticket });
    assert.equal(await again.closed, 4003);
    assert.deepEqual(again.received[0], { type: "denied", reason: "bad-ticket" });
    host.ws.close();
  });

  it(
    "puts a waiting renter out when the host registers, without telling the host it is there",
    TIMEOUT,
    async () => {
      const server = await startServer(60_000);
      const { ticket } = await server.claimTicket("pc-1");
      const renter = server.peer({ type: "join", ticket });
      await until(() => renter.received.length > 0, "the renter heard back on its join");
      assert.equal(renter.received[0]?.type, "joined");

      await server.revokeBehindTheServersBack();
      const host = server.peer({ type: "register", hostId: "pc-1", key: MACHINE_KEY });
      assert.equal(await renter.closed, 4003);
      assert.deepEqual(renter.received.at(-1), { type: "denied", reason: "bad-ticket" });
      // Its register is handled before its pong, peer-joined and all.
      await host.settled();
      assert.ok(!host.received.some((m) => m.type === "peer-joined"));
      host.ws.close();
    },
  );

  it("puts a silent renter out at the next reconcile", TIMEOUT, async () => {
    const server = await startServer(200);
    const { ticket } = await server.claimTicket("pc-2");
    const renter = server.peer({ type: "join", ticket });
    await until(() => renter.received.length > 0, "the renter heard back on its join");
    assert.equal(renter.received[0]?.type, "joined");

    await server.revokeBehindTheServersBack();
    assert.equal(await renter.closed, 4003);
    assert.deepEqual(renter.received.at(-1), { type: "denied", reason: "bad-ticket" });
  });

  it(
    "keeps every seat while the database cannot read, holds relayed frames until it can, and puts a revoked renter out then",
    TIMEOUT,
    async () => {
      const server = await startServer(200);
      const { ticket } = await server.claimTicket("pc-1");
      const { host, renter } = await seat(server, "pc-1", ticket);

      await server.breakSessions();
      await wait(1_000);
      renter.ws.send(JSON.stringify({ type: "ice", candidate: { candidate: "still" } }));
      await wait(1_500);
      assert.deepEqual(iceFrames(host.received), ["before"], "held while unconfirmed");
      assert.equal(renter.ws.readyState, WebSocket.OPEN, "still seated");

      await server.restoreSessions();
      await until(() => iceFrames(host.received).length > 1, "the held frame reached the host");
      assert.deepEqual(iceFrames(host.received), ["before", "still"], "relayed once confirmed");

      await server.revokeBehindTheServersBack();
      assert.equal(await renter.closed, 4003);
      assert.deepEqual(renter.received.at(-1), { type: "denied", reason: "bad-ticket" });
      // Anything relayed to the host went before the renter was put out.
      await host.settled();
      assert.deepEqual(iceFrames(host.received), ["before", "still"], "nothing once revoked");
      host.ws.close();
    },
  );

  it(
    "holds what a socket sends while the database cannot read, in order, up to a cap, and drops the rest but not the seat",
    TIMEOUT,
    async () => {
      const server = await startServer(60_000);
      const { ticket } = await server.claimTicket("pc-1");
      const { host, renter } = await seat(server, "pc-1", ticket);

      await server.breakSessions();
      const sent = Array.from({ length: 70 }, (_, i) => `f${i}`);
      for (const candidate of sent) renter.ws.send(JSON.stringify({ type: "ice", candidate: { candidate } }));
      await wait(1_500);
      assert.deepEqual(iceFrames(host.received), ["before"], "held while unconfirmed");

      await server.restoreSessions();
      await until(() => iceFrames(host.received).length > 64, "the held frames reached the host");
      // Every frame the renter sent is handled, and anything relayed of them has reached the host.
      await renter.settled();
      await host.settled();
      assert.deepEqual(iceFrames(host.received), ["before", ...sent.slice(0, 64)], "the first 64, in order");
      assert.equal(renter.ws.readyState, WebSocket.OPEN, "still seated");
      renter.ws.send(JSON.stringify({ type: "ice", candidate: { candidate: "caught-up" } }));
      await until(() => iceFrames(host.received).length > 65, "the next frame reached the host");
      assert.equal(iceFrames(host.received).at(-1), "caught-up");
      host.ws.close();
    },
  );

  it("keeps seats through blips with a success between them, past the bound in all", TIMEOUT, async () => {
    const server = await startServer(200, 5_000);
    const { ticket } = await server.claimTicket("pc-1");
    const { host, renter } = await seat(server, "pc-1", ticket);

    // Two blips of 3 s each: 6 s of failed reads, past the 5 s bound, but a
    // good one between. A frame relayed between them is the proof of that
    // good read: it waits for one begun after it arrived.
    await server.breakSessions();
    await wait(3_000);
    await server.restoreSessions();
    renter.ws.send(JSON.stringify({ type: "ice", candidate: { candidate: "between" } }));
    await until(() => iceFrames(host.received).length > 1, "a frame relayed between the blips");
    await server.breakSessions();
    await wait(3_000);
    assert.equal(renter.ws.readyState, WebSocket.OPEN, "still seated: the good read confirmed it");
    await server.restoreSessions();
    renter.ws.send(JSON.stringify({ type: "ice", candidate: { candidate: "still" } }));
    await until(() => iceFrames(host.received).length > 2, "a frame relayed after the blips");
    assert.deepEqual(iceFrames(host.received), ["before", "between", "still"]);
    host.ws.close();
  });

  it("closes a seat whose ticket has gone unconfirmed past the bound, without denied", TIMEOUT, async () => {
    const server = await startServer(200, 1_500);
    const { ticket } = await server.claimTicket("pc-1");
    const { host, renter } = await seat(server, "pc-1", ticket);

    await server.breakSessions();
    const brokenAt = Date.now();
    assert.equal(await renter.closed, 1011);
    const tookMs = Date.now() - brokenAt;
    assert.ok(tookMs >= 1_000, `closed after only ${tookMs} ms`);
    assert.ok(!renter.received.some((m) => m.type === "denied"), "the renter may come back");
    await server.restoreSessions();
    host.ws.close();
  });

  it(
    "cuts a seated renter off within a few seconds by default, and relays nothing after",
    TIMEOUT,
    async () => {
      const server = await startServer();
      const { ticket } = await server.claimTicket("pc-1");
      const { host, renter } = await seat(server, "pc-1", ticket);

      const closedAt = renter.closed.then(() => Date.now());
      await server.revokeBehindTheServersBack();
      const revokedAt = Date.now();
      await putOut(host, renter);
      // The next 5 s round, with room for a loaded machine: the old default was 30 s.
      const tookMs = (await closedAt) - revokedAt;
      assert.ok(tookMs < 20_000, `put out after ${tookMs} ms`);
      host.ws.close();
    },
  );
});

describe("ticket that runs out while its join waits on the database", () => {
  it("is refused, and the renter already seated on it keeps the seat", TIMEOUT, async () => {
    const server = await startServer(60_000);
    // Expires 9 to 10 s from now (whole seconds): time to seat a renter on it
    // first, however loaded the machine.
    const mintedAt = Date.now();
    const ticket = mintTicket(SECRET, "pc-1", 10, mintedAt);
    const expiresAt = (Math.floor(mintedAt / 1000) + 10) * 1000;
    const { host, renter } = await seat(server, "pc-1", ticket);
    const joinsHeard = () => host.received.filter((m) => m.type === "peer-joined").length;
    const joinsBefore = joinsHeard();

    // Hold only the last 3 s or so: the server gives up on a lock after 5 s
    // (LIMITS.lockMs), and a join that gave up would be no late join at all.
    await wait(Math.max(0, expiresAt - 3_000 - Date.now()));
    const release = await server.holdSessions();
    assert.ok(Date.now() < expiresAt - 500, "the ticket must still be valid when the late join arrives");
    const late = server.peer({ type: "join", ticket });
    // Valid when it arrives; the read it waits on comes back after it expired.
    await wait(Math.max(0, expiresAt + 300 - Date.now()));
    await release();

    await until(() => late.received.length > 0, "the late join heard back");
    assert.deepEqual(late.received, [{ type: "denied", reason: "bad-ticket" }]);
    assert.equal(await late.closed, 4003);
    // Whatever the late join told the others went before it was refused.
    await renter.settled();
    await host.settled();
    assert.equal(renter.ws.readyState, WebSocket.OPEN, "the seated renter is not replaced");
    assert.ok(!renter.received.some((m) => m.type === "denied"));
    assert.equal(joinsHeard(), joinsBefore, "the host hears no new renter");
    renter.ws.send(JSON.stringify({ type: "ice", candidate: { candidate: "still" } }));
    await until(() => iceFrames(host.received).length > 1, "the seated renter's frame reached the host");
    assert.deepEqual(iceFrames(host.received), ["before", "still"], "still relayed");
    renter.ws.close();
    host.ws.close();
  });
});
