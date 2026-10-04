// Integration test for the signaling server: spawns it on a free port, drives
// two real WebSockets through the full handshake, asserts every relay lands.
//
// Covers the paths the browser cannot easily be made to exercise on demand:
// late host, replaced peer, ping/pong liveness, peer-left on disconnect, and a
// test streamer registering with a session key.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createHash } from "node:crypto";
import { mintHostCert, mintRenterSession, mintSessionKey, mintTicket, type SessionKey } from "../access.js";
import { SESSION_COOKIE } from "../signin.js";
import { sessionPath, type JoinedMessage, type SessionGrant, type SignalMessage } from "../protocol.js";
import { serverDatabase, type ServerDatabase } from "./db.js";
import { REPORT } from "./report.js";

const SERVER = fileURLToPath(new URL("../index.js", import.meta.url));
const PORT = 8100 + Math.floor(Math.random() * 400);
const ORIGIN = `ws://localhost:${PORT}`;

// Every room a test may use is a registered machine, all sharing one key.
const SECRET = "test-room-secret-that-is-long-enough-to-pass";
const SESSION_SECRET = "test-session-secret-that-is-long-enough-too";
/** A signed-in renter, who alone may book and claim. */
const RENTER_COOKIE = `${SESSION_COOKIE}=${mintRenterSession(SESSION_SECRET, "76561198000000001", 3600)}`;
const MACHINE_KEY = "test-machine-key";
const ROOMS = Array.from({ length: 60 }, (_, i) => `pc-${i}`);
const HASH = createHash("sha256").update(MACHINE_KEY).digest("hex");
let roomIndex = 0;
const nextRoom = () => ROOMS[roomIndex++]!;

const register = (room: string, key = MACHINE_KEY): SignalMessage => ({
  type: "register",
  hostId: room,
  key,
});
const join = (room: string, ticket = mintTicket(SECRET, room, 600)): SignalMessage => ({
  type: "join",
  ticket,
});

/**
 * A socket that records every message it receives, so tests can assert on
 * order. `barriers` counts the pings handled() sent whose pongs are not in.
 */
type RecordingSocket = WebSocket & { received: SignalMessage[]; barriers: number };

let server: ChildProcess | undefined;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const send = (ws: WebSocket, msg: SignalMessage) => ws.send(JSON.stringify(msg));
const types = (ws: RecordingSocket) => ws.received.map((m) => m.type);

function joinedMessage(ws: RecordingSocket): JoinedMessage {
  const msg = ws.received.find((m): m is JoinedMessage => m.type === "joined");
  assert.ok(msg, "expected a joined acknowledgement");
  return msg;
}

async function open(): Promise<RecordingSocket> {
  const ws = new WebSocket(ORIGIN) as RecordingSocket;
  ws.received = [];
  ws.barriers = 0;
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as SignalMessage;
    if (msg.type === "pong" && ws.barriers > 0) ws.barriers -= 1;
    else ws.received.push(msg);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

/**
 * Wait until the server has handled everything `ws` sent: it takes a socket's
 * frames in order, so its pong to a ping sent now comes after them. Register
 * and join wait on the database, longer on a loaded machine than a fixed
 * sleep allows. A moment more lets what they sent other sockets arrive.
 */
async function handled(ws: RecordingSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    ws.barriers += 1;
    send(ws, { type: "ping" });
    const end = Date.now() + 10_000;
    while (ws.barriers > 0 && ws.readyState === WebSocket.OPEN && Date.now() < end) await wait(5);
  }
  await wait(30);
}

let database: ServerDatabase;

before(async () => {
  database = await serverDatabase();
  server = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ROOM_SECRET: SECRET,
      SESSION_SECRET,
      MACHINE_KEYS: ROOMS.map((room) => `${room}:${HASH}`).join(","),
      DATABASE_URL: database.url,
    },
    stdio: "ignore",
  });
  // Poll until it accepts connections rather than sleeping a fixed guess.
  // Up to 15 s: the server opens its database before it listens, slower under a full test run.
  for (let i = 0; i < 150; i++) {
    try {
      (await open()).close();
      return;
    } catch {
      await wait(100);
    }
  }
  throw new Error("signaling server did not start");
});

after(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((resolve) => server!.once("exit", resolve));
    server.kill();
    await exited;
  }
  await database.close();
});

describe("signaling", () => {
  it("relays the full offer/answer/ice handshake between two peers", async () => {
    const room = nextRoom();
    const host = await open();
    send(host, register(room));
    await handled(host);

    const client = await open();
    send(client, join(room));
    await handled(client);

    assert.ok(types(host).includes("registered"), "host is registered");
    assert.ok(types(host).includes("peer-joined"), "host was told a renter arrived");
    assert.equal(joinedMessage(client).hostOnline, true);

    send(host, { type: "offer", sdp: { type: "offer", sdp: "x" } });
    await wait(100);
    assert.ok(types(client).includes("offer"), "offer reached the client");

    send(client, { type: "answer", sdp: { type: "answer", sdp: "x" } });
    send(client, { type: "ice", candidate: { candidate: "x" } });
    await wait(100);
    assert.ok(types(host).includes("answer"), "answer reached the host");
    assert.ok(types(host).includes("ice"), "ice reached the host");

    host.close();
    client.close();
  });

  it("answers ping so an idle socket is not culled by the proxy", async () => {
    const ws = await open();
    send(ws, { type: "ping" });
    await wait(100);
    assert.ok(types(ws).includes("pong"));
    ws.close();
  });

  it("tells the client the host is offline when it joins an empty room", async () => {
    const client = await open();
    send(client, join(nextRoom()));
    await handled(client);
    assert.equal(joinedMessage(client).hostOnline, false);
    client.close();
  });

  it("notifies a late-registering host that a renter is already waiting", async () => {
    const room = nextRoom();
    const client = await open();
    send(client, join(room));
    await handled(client);

    const host = await open();
    send(host, register(room));
    await handled(host);

    assert.ok(types(host).includes("peer-joined"));
    host.close();
    client.close();
  });

  it("does not announce peer-left for a renter that was only replaced", async () => {
    // A renter refreshing the page: the new socket joins before the old one has
    // finished closing. The stale close must not reach the host, which is by
    // then already negotiating with the replacement — it would tear that fresh
    // connection straight back down.
    const room = nextRoom();
    const host = await open();
    send(host, register(room));
    await handled(host);

    // Same ticket both times: it is the same renter, reloading.
    const ticket = mintTicket(SECRET, room, 600);
    const first = await open();
    send(first, join(room, ticket));
    await handled(first);

    const second = await open();
    send(second, join(room, ticket));
    await handled(second);
    await wait(150);

    assert.equal(first.readyState, WebSocket.CLOSED, "the stale renter socket was closed");
    const inbox = types(host);
    assert.ok(
      inbox.lastIndexOf("peer-left") < inbox.lastIndexOf("peer-joined"),
      `host saw [${inbox}] — a peer-left after the new renter joined kills the fresh connection`,
    );

    host.close();
    second.close();
  });

  it("does not announce peer-left for a host that was only replaced", async () => {
    // The mirror case: a gaming PC reconnecting must not make the renter give
    // up on the session the new host socket is about to serve.
    const room = nextRoom();
    const renter = await open();
    send(renter, join(room));
    await handled(renter);

    const first = await open();
    send(first, register(room));
    await handled(first);

    const second = await open();
    send(second, register(room));
    await handled(second);
    await wait(150);

    assert.equal(first.readyState, WebSocket.CLOSED, "the stale host socket was closed");
    assert.ok(!types(renter).includes("peer-left"), `renter saw [${types(renter)}]`);

    renter.close();
    second.close();
  });

  it("replaces a stale host socket instead of locking it out of its own room", async () => {
    const room = nextRoom();
    const first = await open();
    send(first, register(room));
    await handled(first);

    const second = await open();
    send(second, register(room));
    await handled(second);
    await wait(50);

    assert.ok(types(second).includes("registered"), "reconnecting host takes the room");
    assert.equal(first.readyState, WebSocket.CLOSED, "stale socket was closed");
    second.close();
  });

  it("tells the surviving peer when the other one disconnects", async () => {
    const room = nextRoom();
    const host = await open();
    send(host, register(room));
    await handled(host);
    const client = await open();
    send(client, join(room));
    await handled(client);

    client.close();
    await wait(150);
    assert.ok(types(host).includes("peer-left"));
    host.close();
  });

  // Register and join wait on the database; a socket's frames, and its close,
  // are still handled in the order they came.
  it("relays the frames a peer sends right behind its register or join", async () => {
    const room = nextRoom();
    const ticket = mintTicket(SECRET, room, 600);
    const client = await open();
    send(client, join(room, ticket));
    await handled(client);

    const host = await open();
    send(host, register(room));
    send(host, { type: "offer", sdp: { type: "offer", sdp: "x" } });
    await handled(host);
    assert.deepEqual(types(host).slice(0, 2), ["registered", "peer-joined"]);
    assert.ok(types(client).includes("offer"), "the offer behind the register reached the client");

    const late = await open();
    send(late, join(room, ticket)); // the same ticket: the renter refreshing takes the seat
    send(late, { type: "ice", candidate: { candidate: "x" } });
    await handled(late);
    assert.equal(types(late)[0], "joined");
    assert.ok(types(host).includes("ice"), "the candidate behind the join reached the host");

    host.close();
    client.close();
    late.close();
  });

  it("gives up the seat of a host that closes before its register is done", async () => {
    const room = nextRoom();
    const gone = await open();
    send(gone, register(room));
    gone.close();
    await wait(200);

    const client = await open();
    send(client, join(room));
    await handled(client);
    assert.equal(joinedMessage(client).hostOnline, false, "nobody holds the room");
    client.close();
  });

  it("ignores malformed frames without dropping the connection", async () => {
    const ws = await open();
    ws.send("not json at all");
    await wait(100);
    assert.equal(ws.readyState, WebSocket.OPEN, "socket survived garbage input");
    send(ws, { type: "ping" });
    await wait(100);
    assert.ok(types(ws).includes("pong"), "still serving after garbage");
    ws.close();
  });
});

describe("room access", () => {
  const denial = (ws: RecordingSocket) => ws.received.find((m) => m.type === "denied");
  const closed = (ws: WebSocket) =>
    new Promise<number>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve(-1);
      ws.once("close", (code) => resolve(code));
    });

  it("refuses a gaming PC with the wrong machine key", async () => {
    const host = await open();
    const code = closed(host);
    send(host, register(nextRoom(), "not-the-key"));
    assert.equal(await code, 4003);
    assert.deepEqual(denial(host), { type: "denied", reason: "bad-machine-key" });
    assert.ok(!types(host).includes("registered"));
  });

  it("refuses a machine id that has no key configured", async () => {
    const host = await open();
    const code = closed(host);
    send(host, register("not-a-machine"));
    assert.equal(await code, 4003);
  });

  it("refuses a renter without a valid ticket", async () => {
    const room = nextRoom();
    const forged = mintTicket("some-other-secret-of-at-least-32-chars", room, 600);
    const expired = mintTicket(SECRET, room, 60, Date.now() - 120_000);
    for (const ticket of ["", "garbage", forged, expired]) {
      const renter = await open();
      const code = closed(renter);
      send(renter, { type: "join", ticket });
      assert.equal(await code, 4003, `ticket ${JSON.stringify(ticket.slice(0, 12))} was let in`);
      assert.deepEqual(denial(renter), { type: "denied", reason: "bad-ticket" });
    }
  });

  it("keeps a second renter out while the first holds the seat", async () => {
    const room = nextRoom();
    const host = await open();
    send(host, register(room));
    const first = await open();
    send(first, join(room));
    await handled(first);

    const second = await open();
    const code = closed(second);
    send(second, join(room));
    assert.equal(await code, 4003);
    assert.deepEqual(denial(second), { type: "denied", reason: "room-taken" });

    // The first renter was not disturbed.
    await wait(100);
    assert.equal(first.readyState, WebSocket.OPEN);
    assert.ok(!types(host).includes("peer-left"));
    host.close();
    first.close();
  });

  it("lets the next renter in once the seat is free", async () => {
    const room = nextRoom();
    const first = await open();
    send(first, join(room));
    await handled(first);
    first.close();
    await wait(150);

    const second = await open();
    send(second, join(room));
    await handled(second);
    assert.ok(types(second).includes("joined"));
    second.close();
  });

  it("relays nothing from a socket that never got into a room", async () => {
    const room = nextRoom();
    const host = await open();
    send(host, register(room));
    await handled(host);

    const intruder = await open();
    send(intruder, { type: "offer", sdp: { type: "offer", sdp: "x" } });
    send(intruder, { type: "ice", candidate: { candidate: "x" } });
    await wait(150);

    assert.deepEqual(types(host), ["registered"]);
    host.close();
    intruder.close();
  });

  it("drops a socket that sends an oversized frame", async () => {
    const ws = await open();
    const code = closed(ws);
    ws.send("x".repeat(256 * 1024));
    assert.equal(await code, 1009);

    // And only that socket: the server is still up for everyone else.
    const next = await open();
    send(next, { type: "ping" });
    await wait(100);
    assert.ok(types(next).includes("pong"), "server survived an oversized frame");
    next.close();
  });
});

describe("host sessions", () => {
  const HTTP = `http://localhost:${PORT}`;
  const denial = (ws: RecordingSocket) => ws.received.find((m) => m.type === "denied");
  const closed = (ws: WebSocket) =>
    new Promise<number>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve(-1);
      ws.once("close", (code) => resolve(code));
    });

  // The platform matches the oldest queued booking first, whatever room it was
  // made for: one a failed claim left queued would take the next test's
  // machine, and fail that test's claim too. Let it go, so a failure stays the
  // test's own.
  afterEach(() => database.exec("UPDATE bookings SET status = 'expired' WHERE status = 'queued'"));

  /** One JSON call to the server as the signed-in renter, with the machine key as bearer when given one. */
  async function call(method: string, path: string, body?: unknown, key?: string) {
    const res = await fetch(`${HTTP}${path}`, {
      method,
      headers: {
        cookie: RENTER_COOKIE,
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
  }

  /** One call to the session API, as the PC's background service makes it. */
  const api = (
    room: string,
    method: "POST" | "DELETE" | "GET",
    path = "",
    key = MACHINE_KEY,
    body?: unknown,
  ) => call(method, `${sessionPath(room)}${path}`, body, key);

  /**
   * A renter books and claims `room`, the only machine on offer, as the
   * platform's booking flow does. Returns the claimed platform session's id
   * and the join ticket the claim handed out.
   */
  async function claimRoomWithTicket(
    room: string,
    minutes = 30,
  ): Promise<{ sessionId: string; ticket: string }> {
    const offered = await call(
      "PUT",
      `/api/machines/${room}/availability`,
      { available: true, ...REPORT },
      MACHINE_KEY,
    );
    assert.equal(offered.status, 200);
    const booking = await call("POST", "/api/bookings", { gameId: 730, minutes });
    const claim = await call("POST", `/api/bookings/${booking.body.bookingId}/claim`);
    // The status and room only: the body carries the renter's ticket.
    assert.equal(claim.status, 200, `claim answered ${claim.status}`);
    assert.equal(claim.body.roomId, room);
    return { sessionId: claim.body.sessionId as string, ticket: claim.body.ticket as string };
  }

  /** As claimRoomWithTicket, returning the claimed platform session's id alone. */
  const claimRoom = async (room: string, minutes = 30): Promise<string> =>
    (await claimRoomWithTicket(room, minutes)).sessionId;

  /**
   * Start a host session for `room` as the PC service would, with the machine
   * key, for `sessionId`; without one, a renter claims the room first.
   */
  async function startSession(room: string, sessionId?: string): Promise<SessionGrant> {
    const { status, body } = await api(room, "POST", "", MACHINE_KEY, {
      sessionId: sessionId ?? (await claimRoom(room)),
    });
    // The status only: the body may be a grant, and its key must not reach test output.
    assert.equal(status, 201, `start answered ${status}`);
    return body as SessionGrant;
  }

  /** The fields of a session key, read without verifying it. */
  const keyFields = (sessionKey: string) =>
    JSON.parse(Buffer.from(sessionKey.split(".")[0]!, "base64url").toString("utf8")) as SessionKey;

  /** The streamer in the renter's account: registers with the session key only. */
  async function streamer(room: string, sessionKey: string): Promise<RecordingSocket> {
    const ws = await open();
    send(ws, { type: "register", hostId: room, sessionKey });
    await handled(ws);
    return ws;
  }

  /** Register a streamer with `sessionKey` and check it is refused as bad-session-key. */
  async function refusedStreamer(room: string, sessionKey: string) {
    const ws = await open();
    const code = closed(ws);
    send(ws, { type: "register", hostId: room, sessionKey });
    assert.equal(await code, 4003);
    assert.deepEqual(denial(ws), { type: "denied", reason: "bad-session-key" });
    assert.ok(!types(ws).includes("registered"));
  }

  it("lets a test streamer register with a session key and serve a renter", async () => {
    const room = nextRoom();
    const grant = await startSession(room);
    assert.ok(grant.expiresAt > Date.now() / 1000, "the key expires in the future");
    assert.ok(grant.expiresAt <= Date.now() / 1000 + 600, "and within minutes");

    const host = await streamer(room, grant.sessionKey);
    assert.ok(types(host).includes("registered"));

    const renter = await open();
    send(renter, join(room));
    await handled(renter);
    assert.equal(joinedMessage(renter).hostOnline, true);
    send(host, { type: "offer", sdp: { type: "offer", sdp: "x" } });
    await wait(100);
    assert.ok(types(renter).includes("offer"), "offer reached the renter");

    host.close();
    renter.close();
    await api(room, "DELETE");
  });

  it("refuses a session key once its session has ended", async () => {
    const room = nextRoom();
    const grant = await startSession(room);
    assert.equal((await api(room, "DELETE")).status, 204);
    await refusedStreamer(room, grant.sessionKey);
  });

  it("refuses an expired session key even while its session is live", async () => {
    const room = nextRoom();
    const grant = await startSession(room);
    const expired = mintSessionKey(SECRET, keyFields(grant.sessionKey), 60, Date.now() - 120_000);
    await refusedStreamer(room, expired);
    await api(room, "DELETE");
  });

  it("refuses a session key for another room", async () => {
    const [x, y] = [nextRoom(), nextRoom()];
    const grant = await startSession(x);
    await refusedStreamer(y, grant.sessionKey);
    // Nor when room Y is in a session of its own.
    await startSession(y);
    await refusedStreamer(y, grant.sessionKey);
    await api(x, "DELETE");
    await api(y, "DELETE");
  });

  it("does not let the machine key take over a room held by a live session key", async () => {
    const room = nextRoom();
    const grant = await startSession(room);
    const host = await streamer(room, grant.sessionKey);
    const renter = await open();
    send(renter, join(room));
    await handled(renter);

    // Registering with the machine key is refused.
    const intruder = await open();
    const code = closed(intruder);
    send(intruder, register(room));
    assert.equal(await code, 4003);
    assert.deepEqual(denial(intruder), { type: "denied", reason: "session-active" });

    // So is a second start for the session.
    assert.deepEqual(await api(room, "POST", "", MACHINE_KEY, { sessionId: grant.sessionId }), {
      status: 409,
      body: { error: "session-active" },
    });

    // And there is no way to mint another key for the live session.
    const renew = await fetch(`${HTTP}${sessionPath(room)}/renew`, {
      method: "POST",
      headers: { authorization: `Bearer ${MACHINE_KEY}` },
    });
    const renewed = (await renew.json()) as Partial<SessionGrant>;
    assert.equal(renew.status, 404);
    assert.equal(renewed.sessionKey, undefined, "renew answered with a grant");

    // The streamer and the renter never noticed.
    await wait(100);
    assert.equal(host.readyState, WebSocket.OPEN);
    assert.ok(!types(renter).includes("peer-left"), `renter saw [${types(renter)}]`);

    // Only ending the session hands the room back, and visibly.
    const hungUp = closed(host);
    assert.equal((await api(room, "DELETE")).status, 204);
    assert.equal(await hungUp, 4003);
    assert.deepEqual(denial(host), { type: "denied", reason: "session-ended" });
    await wait(100);
    assert.ok(types(renter).includes("peer-left"));
    renter.close();
  });

  it("keeps the machine key out while a session is live, and lets it back in after", async () => {
    const room = nextRoom();
    await startSession(room);

    // Before the streamer has connected: still the session's room.
    const early = await open();
    const code = closed(early);
    send(early, register(room));
    assert.equal(await code, 4003);
    assert.deepEqual(denial(early), { type: "denied", reason: "session-active" });

    await api(room, "DELETE");
    const host = await open();
    send(host, register(room));
    await handled(host);
    assert.ok(types(host).includes("registered"), "the phase-1 machine-key register works again");
    host.close();
  });

  it("lets a host certificate serve as the PC service too, kept out while a session is live", async () => {
    const room = nextRoom();
    const hostCert = mintHostCert(SECRET, room, "attested", 600);
    const service = await open();
    send(service, { type: "register", hostId: room, hostCert });
    await handled(service);
    assert.ok(types(service).includes("registered"));

    const sessionId = await claimRoom(room);
    await wait(100);
    assert.ok(types(service).includes("session-claimed"), "the claim reached the attested socket");
    const code = closed(service);
    const started = await api(room, "POST", "", hostCert, { sessionId });
    assert.equal(started.status, 201, `start answered ${started.status}`);
    assert.equal(await code, 4003);

    const early = await open();
    const refused = closed(early);
    // A fresh certificate: the one that started the session is spent.
    send(early, { type: "register", hostId: room, hostCert: mintHostCert(SECRET, room, "attested", 600) });
    assert.equal(await refused, 4003);
    assert.deepEqual(denial(early), { type: "denied", reason: "session-active" });
    assert.equal((await api(room, "DELETE")).status, 204, "the machine key still ends it");
  });

  it("puts out a machine-key host when a session starts", async () => {
    const room = nextRoom();
    const host = await open();
    send(host, register(room));
    await handled(host);
    const code = closed(host);
    await startSession(room);
    assert.equal(await code, 4003);
    assert.deepEqual(denial(host), { type: "denied", reason: "session-active" });
    await api(room, "DELETE");
  });

  it("hangs up on the streamer and tells the renter when the session ends", async () => {
    const room = nextRoom();
    const grant = await startSession(room);
    const host = await streamer(room, grant.sessionKey);
    const renter = await open();
    send(renter, join(room));
    await handled(renter);

    const code = closed(host);
    assert.equal((await api(room, "DELETE")).status, 204);
    assert.equal(await code, 4003);
    assert.deepEqual(denial(host), { type: "denied", reason: "session-ended" });
    await wait(100);
    assert.ok(types(renter).includes("peer-left"));
    renter.close();
  });

  it("tells the renter peer-left before a new session's streamer takes the room", async () => {
    const room = nextRoom();
    const grant = await startSession(room);
    const host = await streamer(room, grant.sessionKey);
    const renter = await open();
    send(renter, join(room));
    await handled(renter);

    // The old streamer does not answer the close handshake, so the server's
    // close event for it has not fired when the next streamer registers.
    host.pause();
    assert.equal((await api(room, "DELETE")).status, 204);
    const next = await startSession(room, grant.sessionId);
    const intruder = await streamer(room, next.sessionKey);
    assert.ok(types(intruder).includes("registered"));

    const inbox = types(renter);
    assert.ok(inbox.includes("peer-left"), `renter saw [${inbox}]`);
    const hostInbox = types(intruder);
    assert.ok(hostInbox.includes("peer-joined"), `new host saw [${hostInbox}]`);
    host.terminate();
    intruder.close();
    renter.close();
    await api(room, "DELETE");
  });

  it("relays nothing from a streamer whose session has ended", async () => {
    const room = nextRoom();
    const grant = await startSession(room);
    const host = await streamer(room, grant.sessionKey);
    const renter = await open();
    send(renter, join(room));
    await handled(renter);

    // The old streamer ignores the close frame and keeps talking.
    host.pause();
    assert.equal((await api(room, "DELETE")).status, 204);
    await wait(100);
    send(host, { type: "offer", sdp: { type: "offer", sdp: "x" } });
    send(host, { type: "ice", candidate: { candidate: "c", sdpMid: "0", sdpMLineIndex: 0 } });
    await wait(100);

    const inbox = types(renter);
    assert.ok(inbox.includes("peer-left"), `renter saw [${inbox}]`);
    assert.ok(!inbox.includes("offer") && !inbox.includes("ice"), `renter saw [${inbox}]`);
    host.terminate();
    renter.close();
  });

  it("tells the renter peer-left when a session start puts out a machine-key host", async () => {
    const room = nextRoom();
    const host = await open();
    send(host, register(room));
    const renter = await open();
    send(renter, join(room));
    await handled(renter);

    host.pause();
    const grant = await startSession(room);
    const next = await streamer(room, grant.sessionKey);
    assert.ok(types(next).includes("registered"));
    const inbox = types(renter);
    assert.ok(inbox.includes("peer-left"), `renter saw [${inbox}]`);
    host.terminate();
    next.close();
    renter.close();
    await api(room, "DELETE");
  });

  it("lets a reconnecting streamer retake the room with its session key", async () => {
    const room = nextRoom();
    const grant = await startSession(room);
    const first = await streamer(room, grant.sessionKey);
    const second = await streamer(room, grant.sessionKey);
    await wait(100);
    assert.ok(types(second).includes("registered"));
    assert.equal(first.readyState, WebSocket.CLOSED);
    second.close();
    await api(room, "DELETE");
  });

  it("guards the session API with the machine key", async () => {
    const room = nextRoom();
    assert.deepEqual(await api(room, "POST", "", "not-the-key"), {
      status: 401,
      body: { error: "bad-machine-key" },
    });
    assert.equal((await api("not-a-machine", "POST")).status, 401);
    // Ending needs the key as well: nobody else may hang up on a renter.
    const grant = await startSession(room);
    assert.equal((await api(room, "DELETE", "", "not-the-key")).status, 401);
    assert.deepEqual(await api(room, "POST", "", MACHINE_KEY, { sessionId: grant.sessionId }), {
      status: 409,
      body: { error: "session-active" },
    });
    assert.equal((await api(room, "GET")).status, 405);
    assert.equal((await api(room, "DELETE")).status, 204);
    assert.equal((await api(room, "DELETE")).status, 204, "ending twice is fine");
  });

  it("pushes session-claimed to the claimed machine only, the moment it is claimed", async () => {
    const [room, other] = [nextRoom(), nextRoom()];
    const host = await open();
    send(host, register(room));
    const bystander = await open();
    send(bystander, register(other));
    await handled(bystander);

    const sessionId = await claimRoom(room, 45);
    await wait(100);
    assert.deepEqual(
      host.received.filter((m) => m.type === "session-claimed"),
      [{ type: "session-claimed", sessionId, appid: 730, minutes: 45 }],
    );
    assert.deepEqual(types(bystander), ["registered"]);

    // The pushed id is the one start takes, and the key it grants is for it.
    const grant = await startSession(room, sessionId);
    assert.equal(grant.sessionId, sessionId);
    assert.equal(keyFields(grant.sessionKey).session, sessionId);
    bystander.close();
    await api(room, "DELETE");
  });

  it("has the session's streamer launch the game on the renter's first frame, and tells the renter it runs", async () => {
    const room = nextRoom();
    const { sessionId, ticket } = await claimRoomWithTicket(room, 45);
    const host = await streamer(room, (await startSession(room, sessionId)).sessionKey);
    const renter = await open();
    send(renter, join(room, ticket));
    await handled(renter);
    const launches = () => host.received.filter((m) => m.type === "launch-game");
    assert.deepEqual(launches(), [], "nothing to launch before the first frame");

    // The renter's page starts the session with its ticket once a frame has arrived.
    assert.equal((await call("POST", `/api/sessions/${sessionId}/start`, undefined, ticket)).status, 200);
    for (const end = Date.now() + 10_000; !launches().length && Date.now() < end;) await wait(5);
    assert.deepEqual(launches(), [{ type: "launch-game", sessionId, appid: 730 }]);

    send(host, { type: "game-started", sessionId });
    await handled(host);
    for (const end = Date.now() + 10_000; !types(renter).includes("game-started") && Date.now() < end;)
      await wait(5);
    assert.ok(types(renter).includes("game-started"), "the renter heard the game runs");
    renter.close();
    host.close();
    await api(room, "DELETE");
  });

  it("has the PC service launch the game, and tells the renter only for the session they started", async () => {
    const room = nextRoom();
    const host = await open();
    send(host, register(room));
    await handled(host);
    const { sessionId, ticket } = await claimRoomWithTicket(room, 45);
    const renter = await open();
    send(renter, join(room, ticket));
    await handled(renter);
    const launches = () => host.received.filter((m) => m.type === "launch-game");

    // Answered before the renter's page started anything: not theirs yet.
    send(host, { type: "game-started", sessionId });
    await handled(host);
    assert.equal((await call("POST", `/api/sessions/${sessionId}/start`, undefined, ticket)).status, 200);
    for (const end = Date.now() + 10_000; !launches().length && Date.now() < end;) await wait(5);
    assert.deepEqual(launches(), [{ type: "launch-game", sessionId, appid: 730 }]);

    // A launch that outlived another session, or one with no session, never reaches them.
    send(host, { type: "game-started", sessionId: "another-session" });
    send(host, { type: "game-started" } as unknown as SignalMessage);
    await handled(host);
    await wait(100);
    assert.ok(!types(renter).includes("game-started"), `renter saw [${types(renter)}]`);

    send(host, { type: "game-started", sessionId });
    await handled(host);
    for (const end = Date.now() + 10_000; !types(renter).includes("game-started") && Date.now() < end;)
      await wait(5);
    assert.deepEqual(
      renter.received.filter((m) => m.type === "game-started"),
      [{ type: "game-started", sessionId }],
    );
    renter.close();
    host.close();
    await api(room, "DELETE");
  });

  it("never has a host certificate launch a game once it has expired", async () => {
    const room = nextRoom();
    const service = await open();
    const code = closed(service);
    send(service, { type: "register", hostId: room, hostCert: mintHostCert(SECRET, room, "attested", 2) });
    await handled(service);
    assert.ok(types(service).includes("registered"));
    assert.equal(await code, 4003);

    const { sessionId, ticket } = await claimRoomWithTicket(room, 45);
    assert.equal((await call("POST", `/api/sessions/${sessionId}/start`, undefined, ticket)).status, 200);
    await wait(100);
    assert.ok(!types(service).includes("launch-game"), `the expired host saw [${types(service)}]`);
    await api(room, "DELETE");
  });

  it("pushes the claim again when the machine key registers with no host session live", async () => {
    const room = nextRoom();
    const claimsOf = (ws: RecordingSocket) => ws.received.filter((m) => m.type === "session-claimed");
    // A renter waits in the room throughout: the server tells it peer-left as
    // it handles a seated PC socket's close, which is when it tells the
    // platform the PC is gone.
    const renter = await open();
    send(renter, join(room));
    await handled(renter);
    const departures = () => types(renter).filter((type) => type === "peer-left").length;
    const machine = async () => {
      const ws = await open();
      send(ws, register(room));
      await handled(ws);
      const seated = types(ws).includes("registered");
      const left = departures() + 1;
      ws.close();
      // Gone before the test goes on: a close the server handles late takes the
      // next offer offline. This side seeing the socket closed is not enough, as
      // the server may still take a request sent after that first.
      if (seated) {
        for (const end = Date.now() + 10_000; departures() < left && Date.now() < end;) await wait(5);
        assert.equal(departures(), left, "the server handled the PC's close");
      }
      return ws;
    };

    assert.deepEqual(claimsOf(await machine()), [], "nothing claimed");

    const sessionId = await claimRoom(room, 45);
    const claimed = [{ type: "session-claimed", sessionId, appid: 730, minutes: 45 }];
    assert.deepEqual(claimsOf(await machine()), claimed, "claimed while the PC was away");

    await startSession(room, sessionId);
    const kept = await machine();
    assert.deepEqual(denial(kept), { type: "denied", reason: "session-active" });
    assert.deepEqual(claimsOf(kept), [], "a host session is live");

    await api(room, "DELETE");
    assert.deepEqual(claimsOf(await machine()), claimed, "the host session was ended, the claim runs on");
    renter.close();
  });

  it("starts a session only for the machine's own claimed session", async () => {
    const [room, other] = [nextRoom(), nextRoom()];
    const otherSession = await claimRoom(other);
    const start = (body?: unknown) => api(room, "POST", "", MACHINE_KEY, body);
    const notClaimed = { status: 409, body: { error: "not-claimed" } };

    // Nothing claimed on this machine yet.
    assert.deepEqual(await start({ sessionId: otherSession }), notClaimed);

    const sessionId = await claimRoom(room);
    assert.deepEqual(await start({ sessionId: otherSession }), notClaimed, "another machine's session");
    assert.deepEqual(await start({ sessionId: "made-up" }), notClaimed);
    const badRequest = { status: 400, body: { error: "bad-request" } };
    assert.deepEqual(await start(), badRequest);
    assert.deepEqual(await start({ sessionId: 42 }), badRequest);
    assert.deepEqual(await start("not json"), badRequest);
    // The machine key still comes first.
    assert.equal((await api(room, "POST", "", "not-the-key", { sessionId })).status, 401);

    assert.equal((await start({ sessionId })).status, 201);
    await api(room, "DELETE");
    await api(other, "DELETE");
  });

  it("starts the same claimed session again after an end, without reviving its old keys", async () => {
    const room = nextRoom();
    const first = await startSession(room);
    assert.equal((await api(room, "DELETE")).status, 204);
    const again = await startSession(room, first.sessionId);
    assert.equal(again.sessionId, first.sessionId);
    await refusedStreamer(room, first.sessionKey);
    const host = await streamer(room, again.sessionKey);
    assert.ok(types(host).includes("registered"));
    host.close();
    await api(room, "DELETE");
  });

  it("hangs up on the streamer and kills its keys when the host ends the platform session", async () => {
    const room = nextRoom();
    const grant = await startSession(room);
    const host = await streamer(room, grant.sessionKey);
    const code = closed(host);

    const ended = await call("POST", `/api/sessions/${grant.sessionId}/end`, {}, MACHINE_KEY);
    assert.equal(ended.status, 200);
    assert.equal(await code, 4003);
    assert.deepEqual(denial(host), { type: "denied", reason: "session-ended" });
    await refusedStreamer(room, grant.sessionKey);
    // And the ended session cannot be started again.
    assert.deepEqual(await api(room, "POST", "", MACHINE_KEY, { sessionId: grant.sessionId }), {
      status: 409,
      body: { error: "not-claimed" },
    });
    // Ending the session offers the machine again; take it back so the next
    // test's booking is matched to its own room.
    await call("PUT", `/api/machines/${room}/availability`, { available: false }, MACHINE_KEY);
  });

  it("lets the desktop app call the session API from its own origin", async () => {
    const room = nextRoom();
    const preflight = await fetch(`${HTTP}${sessionPath(room)}`, {
      method: "OPTIONS",
      headers: {
        origin: "file://",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /POST/);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);
    assert.equal(preflight.headers.get("access-control-allow-credentials"), null);

    const sessionId = await claimRoom(room);
    const res = await fetch(`${HTTP}${sessionPath(room)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${MACHINE_KEY}`,
        "content-type": "application/json",
        origin: "file://",
      },
      body: JSON.stringify({ sessionId }),
    });
    // The status and header only: the body carries the session key.
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    await res.body?.cancel();
    await api(room, "DELETE");
  });
});
