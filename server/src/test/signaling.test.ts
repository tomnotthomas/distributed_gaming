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
import type { JoinedMessage, SignalMessage } from "../protocol.js";

const SERVER = fileURLToPath(new URL("../index.js", import.meta.url));
const PORT = 8100 + Math.floor(Math.random() * 400);
const ORIGIN = `ws://localhost:${PORT}`;

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
    env: { ...process.env, PORT: String(PORT) },
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
    const room = `room-${Math.random().toString(36).slice(2)}`;
    const host = await open();
    send(host, { type: "register", hostId: room });
    await wait(100);

    const client = await open();
    send(client, { type: "join", hostId: room });
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
    send(client, { type: "join", hostId: `empty-${Date.now()}` });
    await wait(100);
    assert.equal(joinedMessage(client).hostOnline, false);
    client.close();
  });

  it("notifies a late-registering host that a renter is already waiting", async () => {
    const room = `late-${Date.now()}`;
    const client = await open();
    send(client, { type: "join", hostId: room });
    await wait(100);

    const host = await open();
    send(host, { type: "register", hostId: room });
    await wait(100);

    assert.ok(types(host).includes("peer-joined"));
    host.close();
    client.close();
  });

  it("replaces a stale host socket instead of locking it out of its own room", async () => {
    const room = `replace-${Date.now()}`;
    const first = await open();
    send(first, { type: "register", hostId: room });
    await wait(100);

    const second = await open();
    send(second, { type: "register", hostId: room });
    await wait(150);

    assert.ok(types(second).includes("registered"), "reconnecting host takes the room");
    assert.equal(first.readyState, WebSocket.CLOSED, "stale socket was closed");
    second.close();
  });

  it("tells the surviving peer when the other one disconnects", async () => {
    const room = `left-${Date.now()}`;
    const host = await open();
    send(host, { type: "register", hostId: room });
    await wait(100);
    const client = await open();
    send(client, { type: "join", hostId: room });
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
