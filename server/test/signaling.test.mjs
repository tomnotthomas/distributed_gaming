// Integration test for the signaling server: spawns it on a free port, drives
// two real WebSockets through the full handshake, asserts every relay lands.
//
// Covers the paths the browser cannot easily be made to exercise on demand:
// late host, replaced peer, ping/pong liveness, and peer-left on disconnect.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const SERVER = fileURLToPath(new URL("../index.js", import.meta.url));
const PORT = 8100 + Math.floor(Math.random() * 400);
const URL_ = `ws://localhost:${PORT}`;

let server;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (ws, msg) => ws.send(JSON.stringify(msg));

/** Opens a socket that records every message type it receives. */
async function open() {
  const ws = new WebSocket(URL_);
  ws.received = [];
  ws.on("message", (raw) => ws.received.push(JSON.parse(raw)));
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  return ws;
}

const types = (ws) => ws.received.map((m) => m.type);

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
    assert.ok(types(client).includes("joined"), "client joined");
    assert.ok(types(host).includes("peer-joined"), "host was told a renter arrived");
    assert.equal(client.received.find((m) => m.type === "joined").hostOnline, true);

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
    assert.equal(client.received.find((m) => m.type === "joined").hostOnline, false);
    client.close();
  });

  it("notifies a waiting client's host when the host registers late", async () => {
    const room = `late-${Date.now()}`;
    const client = await open();
    send(client, { type: "join", hostId: room });
    await wait(100);

    const host = await open();
    send(host, { type: "register", hostId: room });
    await wait(100);

    assert.ok(types(host).includes("peer-joined"), "late host learns a renter is already waiting");
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
