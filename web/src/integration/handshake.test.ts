// Integration test: the web app's own signaling client against the real server.
//
// The unit tests drive `connectSignaling` through a fake socket, and the server
// has its own tests driving raw `ws` sockets. Neither notices if the two sides
// stop agreeing — a renamed message type, a field the host stops sending — so
// this one runs the actual client module against the actual server process and
// walks the whole register → join → offer → answer → ice handshake through it.
//
// Nothing is faked but the pixels: there is no RTCPeerConnection here, just the
// messages the two peers would exchange to build one.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Hoisted so the config mock below can see the port it has to advertise.
const { PORT } = vi.hoisted(() => ({ PORT: 8500 + Math.floor(Math.random() * 400) }));

// The real config reads `location`, which under jsdom points at nothing useful.
// Everything else about the client stays real.
vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  SIGNALING_URL: `ws://127.0.0.1:${PORT}`,
}));

const { connectSignaling } = await import("../signaling");
type SignalMessage = import("../signaling").SignalMessage;
type Signaling = import("../signaling").Signaling;

// The server is started through its own `npm start`, never by naming a source
// file. Whether it is JavaScript today or compiled TypeScript tomorrow is the
// server workspace's business, and this test should not have to care.
//
// Under jsdom `import.meta.url` is an http:// URL, so the repo root has to be
// found by walking up from the working directory instead.
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, "server/package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`no server workspace found above ${process.cwd()}`);
}

const REPO_ROOT = findRepoRoot();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ChildProcess;
const openPeers: Signaling[] = [];

/**
 * A peer built the way the app builds one, with its inbox recorded so a test
 * can wait on a specific message rather than sleeping a guess.
 */
function peer(hello: SignalMessage) {
  const received: SignalMessage[] = [];
  const statuses: string[] = [];
  let send: (msg: SignalMessage) => void = () => {};

  const signaling = connectSignaling({
    onOpen: (s) => {
      send = s;
      s(hello);
    },
    onMessage: (msg) => received.push(msg),
    onStatus: (s) => statuses.push(s),
  });
  openPeers.push(signaling);

  return {
    received,
    statuses,
    signaling,
    send: (msg: SignalMessage) => send(msg),
    types: () => received.map((m) => m.type),
    /** Resolve with the first message of `type`, or fail the test on timeout. */
    async waitFor(type: string, timeoutMs = 5000): Promise<SignalMessage> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = received.find((m) => m.type === type);
        if (hit) return hit;
        await wait(20);
      }
      throw new Error(`timed out waiting for "${type}"; got [${received.map((m) => m.type)}]`);
    },
  };
}

beforeAll(async () => {
  // Detached so the whole npm -> node process group can be torn down together;
  // killing npm alone would leave the server holding the port.
  server = spawn("npm", ["start", "-w", "@swiff/server"], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
    detached: true,
  });

  // Poll the HTTP side until it answers, rather than sleeping a fixed guess.
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/`);
      return;
    } catch {
      await wait(100);
    }
  }
  throw new Error("signaling server did not start");
}, 30_000);

afterEach(() => {
  openPeers.splice(0).forEach((s) => s.close());
});

afterAll(() => {
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
  }
});

describe("web client against the real signaling server", () => {
  it("carries an offer from the host to the renter and the answer back", async () => {
    const room = `it-${Math.random().toString(36).slice(2)}`;

    const host = peer({ type: "register", hostId: room });
    await host.waitFor("registered");

    const renter = peer({ type: "join", hostId: room });
    const joined = await renter.waitFor("joined");
    expect(joined.hostOnline).toBe(true);

    // The host offers only once it knows somebody is there to answer.
    await host.waitFor("peer-joined");
    host.send({ type: "offer", sdp: { type: "offer", sdp: "v=0 fake-offer" } });

    const offer = await renter.waitFor("offer");
    expect(offer.sdp).toEqual({ type: "offer", sdp: "v=0 fake-offer" });

    renter.send({ type: "answer", sdp: { type: "answer", sdp: "v=0 fake-answer" } });
    const answer = await host.waitFor("answer");
    expect(answer.sdp).toEqual({ type: "answer", sdp: "v=0 fake-answer" });
  });

  it("relays ICE candidates in both directions", async () => {
    const room = `ice-${Math.random().toString(36).slice(2)}`;
    const host = peer({ type: "register", hostId: room });
    await host.waitFor("registered");
    const renter = peer({ type: "join", hostId: room });
    await renter.waitFor("joined");
    await host.waitFor("peer-joined");

    host.send({ type: "ice", candidate: { candidate: "from-host", sdpMid: "0" } });
    renter.send({ type: "ice", candidate: { candidate: "from-renter", sdpMid: "0" } });

    expect((await renter.waitFor("ice")).candidate?.candidate).toBe("from-host");
    expect((await host.waitFor("ice")).candidate?.candidate).toBe("from-renter");
  });

  it("tells a renter the gaming PC is offline when nobody has registered", async () => {
    const renter = peer({ type: "join", hostId: `empty-${Date.now()}` });

    expect((await renter.waitFor("joined")).hostOnline).toBe(false);
  });

  it("lets a renter wait in an empty room until the host shows up", async () => {
    const room = `late-${Date.now()}`;
    const renter = peer({ type: "join", hostId: room });
    expect((await renter.waitFor("joined")).hostOnline).toBe(false);

    const host = peer({ type: "register", hostId: room });
    await host.waitFor("registered");

    // Without this the late host never learns to offer and both sides hang.
    await host.waitFor("peer-joined");
  });

  it("tells the host when the renter goes away", async () => {
    const room = `left-${Date.now()}`;
    const host = peer({ type: "register", hostId: room });
    await host.waitFor("registered");
    const renter = peer({ type: "join", hostId: room });
    await host.waitFor("peer-joined");

    renter.signaling.close();

    await host.waitFor("peer-left");
  });

  it("never surfaces the keepalive to the application", async () => {
    const host = peer({ type: "register", hostId: `ping-${Date.now()}` });
    await host.waitFor("registered");

    host.send({ type: "ping" });
    await wait(300);

    // The server does answer with pong; the client is supposed to eat it.
    expect(host.types()).not.toContain("pong");
  });

  it("hands a reconnecting host its room back instead of locking it out", async () => {
    const room = `replace-${Date.now()}`;
    const first = peer({ type: "register", hostId: room });
    await first.waitFor("registered");

    // A host whose machine slept comes back on a brand new socket.
    const second = peer({ type: "register", hostId: room });
    await second.waitFor("registered");

    const renter = peer({ type: "join", hostId: room });
    expect((await renter.waitFor("joined")).hostOnline).toBe(true);
    await second.waitFor("peer-joined");
  });

  it("reconnects by itself when the server drops the socket", async () => {
    const room = `retry-${Date.now()}`;
    const host = peer({ type: "register", hostId: room });
    await host.waitFor("registered");

    // Registering the same room from elsewhere makes the server close the first
    // socket — the same shape as a network blip, and the client should come
    // back on its own and re-register.
    const usurper = peer({ type: "register", hostId: room });
    await usurper.waitFor("registered");
    usurper.signaling.close();

    // Second "registered" means the client reconnected and said hello again.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (host.types().filter((t) => t === "registered").length >= 2) return;
      await wait(50);
    }
    throw new Error(`client did not re-register; inbox was [${host.types()}]`);
  }, 15_000);

  it("reports the connection status to the UI", async () => {
    const host = peer({ type: "register", hostId: `status-${Date.now()}` });
    await host.waitFor("registered");

    expect(host.statuses).toEqual(["connecting", "open"]);
  });
});
