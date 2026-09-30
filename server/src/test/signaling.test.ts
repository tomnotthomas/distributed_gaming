// Integration test for the signaling server: spawns it on a free port, drives
// two real WebSockets through the full handshake, asserts every relay lands.
//
// Covers the paths the browser cannot easily be made to exercise on demand:
// late host, replaced peer, ping/pong liveness, and peer-left on disconnect.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createHash } from "node:crypto";
import { mintTicket } from "../access.js";
import type { JoinedMessage, SignalMessage } from "../protocol.js";

const SERVER = fileURLToPath(new URL("../index.js", import.meta.url));
const PORT = 8100 + Math.floor(Math.random() * 400);
const ORIGIN = `ws://localhost:${PORT}`;

// Every room a test may use is a registered machine, all sharing one key.
const SECRET = "test-room-secret-that-is-long-enough-to-pass";
const MACHINE_KEY = "test-machine-key";
const ROOMS = Array.from({ length: 30 }, (_, i) => `pc-${i}`);
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

/** A socket that records every message it receives, so tests can assert on order. */
type RecordingSocket = WebSocket & { received: SignalMessage[] };

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
  ws.on("message", (raw) => ws.received.push(JSON.parse(String(raw)) as SignalMessage));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

before(async () => {
  server = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ROOM_SECRET: SECRET,
      MACHINE_KEYS: ROOMS.map((room) => `${room}:${HASH}`).join(","),
    },
    stdio: "ignore",
  });
  // Poll until it accepts connections rather than sleeping a fixed guess.
  for (let i = 0; i < 50; i++) {
    try {
      (await open()).close();
      return;
    } catch {
      await wait(100);
    }
  }
  throw new Error("signaling server did not start");
});

after(() => server?.kill());

describe("signaling", () => {
  it("relays the full offer/answer/ice handshake between two peers", async () => {
    const room = nextRoom();
    const host = await open();
    send(host, register(room));
    await wait(100);

    const client = await open();
    send(client, join(room));
    await wait(100);

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
    await wait(100);
    assert.equal(joinedMessage(client).hostOnline, false);
    client.close();
  });

  it("notifies a late-registering host that a renter is already waiting", async () => {
    const room = nextRoom();
    const client = await open();
    send(client, join(room));
    await wait(100);

    const host = await open();
    send(host, register(room));
    await wait(100);

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
    await wait(100);

    // Same ticket both times: it is the same renter, reloading.
    const ticket = mintTicket(SECRET, room, 600);
    const first = await open();
    send(first, join(room, ticket));
    await wait(100);

    const second = await open();
    send(second, join(room, ticket));
    await wait(250);

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
    await wait(100);

    const first = await open();
    send(first, register(room));
    await wait(100);

    const second = await open();
    send(second, register(room));
    await wait(250);

    assert.equal(first.readyState, WebSocket.CLOSED, "the stale host socket was closed");
    assert.ok(!types(renter).includes("peer-left"), `renter saw [${types(renter)}]`);

    renter.close();
    second.close();
  });

  it("replaces a stale host socket instead of locking it out of its own room", async () => {
    const room = nextRoom();
    const first = await open();
    send(first, register(room));
    await wait(100);

    const second = await open();
    send(second, register(room));
    await wait(150);

    assert.ok(types(second).includes("registered"), "reconnecting host takes the room");
    assert.equal(first.readyState, WebSocket.CLOSED, "stale socket was closed");
    second.close();
  });

  it("tells the surviving peer when the other one disconnects", async () => {
    const room = nextRoom();
    const host = await open();
    send(host, register(room));
    await wait(100);
    const client = await open();
    send(client, join(room));
    await wait(100);

    client.close();
    await wait(150);
    assert.ok(types(host).includes("peer-left"));
    host.close();
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
    await wait(100);

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
    await wait(100);
    first.close();
    await wait(150);

    const second = await open();
    send(second, join(room));
    await wait(100);
    assert.ok(types(second).includes("joined"));
    second.close();
  });

  it("relays nothing from a socket that never got into a room", async () => {
    const room = nextRoom();
    const host = await open();
    send(host, register(room));
    await wait(100);

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
  });
});
