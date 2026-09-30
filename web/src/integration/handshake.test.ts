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
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { connectSignaling } from "@swiff/rtc";
import { mintTicket } from "../../../server/src/access";

const PORT = 8500 + Math.floor(Math.random() * 400);
const SIGNALING_URL = `ws://127.0.0.1:${PORT}`;

/**
 * The member of the protocol union carrying tag `T`.
 *
 * Not `Extract<SignalMessage, { type: T }>`: offer and answer share one type
 * whose tag is `"offer" | "answer"`, which Extract rejects. Comparing the other
 * way round — does the wanted tag fall inside the member's tag — handles both.
 */
type MessageOf<T extends SignalMessage["type"], M = SignalMessage> = M extends { type: infer U }
  ? T extends U
    ? M
    : never
  : never;

type SignalMessage = import("@swiff/rtc").SignalMessage;
type Signaling = import("@swiff/rtc").Signaling;

// The server is started at the entry point it declares for itself — `main` in
// the server workspace's package.json — never a path this test invents. Whether
// that is dist/index.js today or somewhere else tomorrow stays the server
// workspace's business.
//
// Not `npm start`, which is how this used to work: npm is `npm.cmd` on Windows
// and `spawn` cannot resolve it without a shell, so the whole suite failed there
// with `spawn npm ENOENT`. Going through npm also means two processes, killable
// only as a group — and Unix process groups have no Windows equivalent, so the
// teardown leaked a server holding its port. One `node` process is the same
// thing the server's own tests start, and `kill` ends it on every platform.
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

/** Where the server workspace says its runnable entry point is. */
function findServerEntry(root: string): string {
  const manifest = resolve(root, "server", "package.json");
  const { main } = JSON.parse(readFileSync(manifest, "utf8")) as { main?: string };
  if (!main) throw new Error(`${manifest} declares no "main" to run`);
  return resolve(root, "server", main);
}

// Every room a test may use is a registered machine, all sharing one key.
const SECRET = "integration-room-secret-long-enough-to-pass";
const MACHINE_KEY = "integration-machine-key";
const ROOMS = Array.from({ length: 30 }, (_, i) => `it-pc-${i}`);
const HASH = createHash("sha256").update(MACHINE_KEY).digest("hex");
let roomIndex = 0;
const nextRoom = () => ROOMS[roomIndex++];

const register = (room: string): SignalMessage => ({ type: "register", hostId: room, key: MACHINE_KEY });
const join = (room: string, ticket = mintTicket(SECRET, room, 600)): SignalMessage => ({
  type: "join",
  ticket,
});

const REPO_ROOT = findRepoRoot();
const SERVER_ENTRY = findServerEntry(REPO_ROOT);
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
    url: SIGNALING_URL,
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
    /**
     * Resolve with the first message of `type`, or fail the test on timeout.
     *
     * Generic over the tag so the caller gets the narrowed member of the union
     * back — `waitFor("joined")` hands back something with `hostOnline` on it,
     * and a typo in the tag is a compile error rather than a 5s timeout.
     */
    async waitFor<T extends SignalMessage["type"]>(
      type: T,
      timeoutMs = 5000,
    ): Promise<MessageOf<T>> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = received.find((m) => m.type === type);
        if (hit) return hit as MessageOf<T>;
        await wait(20);
      }
      throw new Error(`timed out waiting for "${type}"; got [${received.map((m) => m.type)}]`);
    },
  };
}

beforeAll(async () => {
  // `npm test` builds the server workspace before this one runs. Say so plainly
  // rather than letting a missing build look like a server that would not boot.
  expect(
    existsSync(SERVER_ENTRY),
    `the server is not built — run \`npm run build -w @swiff/server\` (looked for ${SERVER_ENTRY})`,
  ).toBe(true);

  server = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: resolve(REPO_ROOT, "server"),
    env: {
      ...process.env,
      PORT: String(PORT),
      ROOM_SECRET: SECRET,
      MACHINE_KEYS: ROOMS.map((room) => `${room}:${HASH}`).join(","),
    },
    stdio: "ignore",
  });

  // Poll the HTTP side until it answers, rather than sleeping a fixed guess.
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) {
      throw new Error(`signaling server exited with code ${server.exitCode} before answering`);
    }
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

// One process, so no process-group dance: this ends it on Windows and on macOS.
afterAll(() => {
  server?.kill();
});

describe("web client against the real signaling server", () => {
  it("carries an offer from the host to the renter and the answer back", async () => {
    const room = nextRoom();

    const host = peer(register(room));
    await host.waitFor("registered");

    const renter = peer(join(room));
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
    const room = nextRoom();
    const host = peer(register(room));
    await host.waitFor("registered");
    const renter = peer(join(room));
    await renter.waitFor("joined");
    await host.waitFor("peer-joined");

    host.send({ type: "ice", candidate: { candidate: "from-host", sdpMid: "0" } });
    renter.send({ type: "ice", candidate: { candidate: "from-renter", sdpMid: "0" } });

    expect((await renter.waitFor("ice")).candidate?.candidate).toBe("from-host");
    expect((await host.waitFor("ice")).candidate?.candidate).toBe("from-renter");
  });

  it("tells a renter the gaming PC is offline when nobody has registered", async () => {
    const renter = peer(join(nextRoom()));

    expect((await renter.waitFor("joined")).hostOnline).toBe(false);
  });

  it("lets a renter wait in an empty room until the host shows up", async () => {
    const room = nextRoom();
    const renter = peer(join(room));
    expect((await renter.waitFor("joined")).hostOnline).toBe(false);

    const host = peer(register(room));
    await host.waitFor("registered");

    // Without this the late host never learns to offer and both sides hang.
    await host.waitFor("peer-joined");
  });

  it("tells the host when the renter goes away", async () => {
    const room = nextRoom();
    const host = peer(register(room));
    await host.waitFor("registered");
    const renter = peer(join(room));
    await host.waitFor("peer-joined");

    renter.signaling.close();

    await host.waitFor("peer-left");
  });

  it("never surfaces the keepalive to the application", async () => {
    const host = peer(register(nextRoom()));
    await host.waitFor("registered");

    host.send({ type: "ping" });
    await wait(300);

    // The server does answer with pong; the client is supposed to eat it.
    expect(host.types()).not.toContain("pong");
  });

  it("hands a reconnecting host its room back instead of locking it out", async () => {
    const room = nextRoom();
    const first = peer(register(room));
    await first.waitFor("registered");

    // A host whose machine slept comes back on a brand new socket.
    const second = peer(register(room));
    await second.waitFor("registered");

    const renter = peer(join(room));
    expect((await renter.waitFor("joined")).hostOnline).toBe(true);
    await second.waitFor("peer-joined");
  });

  it("reconnects by itself when the server drops the socket", async () => {
    const room = nextRoom();
    const host = peer(register(room));
    await host.waitFor("registered");

    // Registering the same room from elsewhere makes the server close the first
    // socket — the same shape as a network blip, and the client should come
    // back on its own and re-register.
    const usurper = peer(register(room));
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

  // Regression: a displaced socket's close used to fire peer-left at whoever
  // held the room next, so a renter who refreshed made the host tear down the
  // connection it had just built for them — no picture until the host restarted.
  it("does not tell the host a renter left when that renter was only replaced", async () => {
    const room = nextRoom();
    const host = peer(register(room));
    await host.waitFor("registered");

    // Same ticket both times: the link the renter opened is the same one.
    const ticket = mintTicket(SECRET, room, 600);
    const first = peer(join(room, ticket));
    await first.waitFor("joined");
    await host.waitFor("peer-joined");

    // The renter hits refresh: a new socket joins the same room, and the old
    // one is closed by the server a moment later.
    const second = peer(join(room, ticket));
    await second.waitFor("joined");
    await wait(500);

    const inbox = host.types();
    const lastJoined = inbox.lastIndexOf("peer-joined");
    const lastLeft = inbox.lastIndexOf("peer-left");

    expect(
      lastLeft < lastJoined,
      `host saw [${inbox}] — a peer-left after the new renter joined kills the fresh connection`,
    ).toBe(true);
  });

  it("gives up, rather than retrying forever, when the server refuses the ticket", async () => {
    const renter = peer({ type: "join", ticket: "not-a-ticket" });

    expect((await renter.waitFor("denied")).reason).toBe("bad-ticket");
    await wait(1500); // longer than the first backoff
    expect(renter.statuses).toEqual(["connecting", "open", "closed"]);
  });

  it("reports the connection status to the UI", async () => {
    const host = peer(register(nextRoom()));
    await host.waitFor("registered");

    expect(host.statuses).toEqual(["connecting", "open"]);
  });
});
