// Unit tests for the gaming PC's half of the handshake, against a fake
// signaling socket and a fake fetch. Only the signaling wiring and the claim
// handover are covered here: no renter arrives, so no peer connection is made.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  requestSessionKey,
  startHostSession,
  type HostConnection,
  type HostSessionOptions,
  type SessionClaim,
} from "./hostSession";
import { FakeSocket } from "./test/fakes";

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const CLAIM = { type: "session-claimed", sessionId: "s1", appid: 730, minutes: 45 } as const;

/** A fetch that answers every call with `status` and `body`, recording the calls. */
function fakeFetch(status: number, body: unknown = {}) {
  const fetch = vi.fn(
    async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/**
 * A fetch that answers its calls with `answers` in order, recording the calls.
 * `"network"` fails the call as an unreachable server does.
 */
function fakeFetches(...answers: ([status: number, body?: unknown] | "network")[]) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    const answer = answers.shift()!;
    if (answer === "network") throw new TypeError("fetch failed");
    const [status, body] = answer;
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** Let the handover's fetch and its continuations settle. */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** Let every retry of a failed session call run. */
const settleRetries = () => vi.advanceTimersByTimeAsync(5_000);

/** The method and body of each session call made. */
const callsOf = (fetch: ReturnType<typeof fakeFetches>) =>
  fetch.mock.calls.map(([, init]) => [init.method, init.body ?? null]);

/**
 * A peer connection just able to make an offer, and a stream with one video
 * track: `offered` counts the peer connections made.
 */
function fakePeer() {
  const offered = vi.fn();
  vi.stubGlobal(
    "RTCPeerConnection",
    class extends EventTarget {
      localDescription: RTCSessionDescriptionInit | null = null;
      constructor() {
        super();
        offered();
      }
      addTrack() {
        return { getParameters: () => ({}), setParameters: async () => {} };
      }
      createDataChannel() {
        return {};
      }
      async createOffer() {
        return { type: "offer", sdp: "v=0" };
      }
      async setLocalDescription(sdp: RTCSessionDescriptionInit) {
        this.localDescription = sdp;
      }
      close() {}
    },
  );
  const stream = { getVideoTracks: () => [{}], getAudioTracks: () => [] } as unknown as MediaStream;
  return { offered, stream };
}

/** Start a host session on a fresh fake socket, recording what it reports. */
function start(serveClaims = false, extra: Partial<HostSessionOptions> = {}) {
  const claims: SessionClaim[] = [];
  const connection: HostConnection[] = [];
  const denied = vi.fn();
  const claimOver = vi.fn();
  const session = startHostSession({
    serveClaims,
    onDenied: denied,
    onClaimOver: claimOver,
    onConnection: (state) => connection.push(state),
    url: "wss://signal.test",
    hostId: "pc-1",
    machineKey: "test-machine-key",
    stream: {} as MediaStream, // never read: no renter arrives
    onPeerHere: () => {},
    onPeerConnection: () => {},
    onSessionClaimed: (claim) => claims.push(claim),
    ...extra,
  });
  const socket = FakeSocket.instances[0]!;
  socket.accept();
  return { session, socket, claims, connection, denied, claimOver };
}

describe("startHostSession", () => {
  it("registers with the machine key", () => {
    const { session, socket } = start();
    expect(socket.messages).toEqual([{ type: "register", hostId: "pc-1", key: "test-machine-key" }]);
    session.stop();
  });

  it("hands a session-claimed push to onSessionClaimed, and nothing else", () => {
    const { session, socket, claims } = start();
    socket.deliver({ type: "registered", hostId: "pc-1" });
    socket.deliver({ type: "session-claimed", sessionId: "s1", appid: 730, minutes: 45 });
    expect(claims).toEqual([{ sessionId: "s1", appid: 730, minutes: 45 }]);
    expect(socket.messages).toHaveLength(1); // still only the register
    session.stop();
  });

  it("ends a claim it does not accept, instead of serving it", async () => {
    const fetch = fakeFetch(200, { sessionId: "s1", roomId: "pc-1" });
    const refused: SessionClaim[] = [];
    const acceptClaim = vi.fn((claim: SessionClaim) => claim.appid !== 730);
    const { session, socket, claims } = start(true, { acceptClaim, onClaimRefused: (c) => refused.push(c) });
    socket.deliver(CLAIM);
    await settle();

    expect(acceptClaim).toHaveBeenCalledWith({ sessionId: "s1", appid: 730, minutes: 45 });
    expect(claims).toEqual([]);
    expect(refused).toEqual([{ sessionId: "s1", appid: 730, minutes: 45 }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://signal.test/api/sessions/s1/end");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-machine-key");
    // Still in the room with the machine key, waiting for the next claim.
    expect(socket.closeCalls).toBe(0);
    expect(FakeSocket.instances).toHaveLength(1);

    socket.deliver({ ...CLAIM, sessionId: "s2", appid: 570 });
    expect(claims).toEqual([{ sessionId: "s2", appid: 570, minutes: 45 }]);
    session.stop();
  });

  it("offers no renter the screen while a refused claim is not yet ended, nor after its end fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { offered, stream } = fakePeer();
    let end!: (res: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (end = resolve))),
    );
    const peerHere = vi.fn();
    const acceptClaim = (claim: SessionClaim) => claim.appid !== 730;
    const { session, socket } = start(true, { acceptClaim, stream, onPeerHere: peerHere });
    socket.deliver(CLAIM);
    await settle();

    // The end is still under way: a renter joining now may hold the refused session's ticket.
    socket.deliver({ type: "peer-joined" });
    await settle();
    expect(peerHere).not.toHaveBeenCalled();
    expect(offered).not.toHaveBeenCalled();

    // Once the platform has ended it, a renter who joins is offered the screen again.
    end(new Response("{}", { status: 200 }));
    await settle();
    socket.deliver({ type: "peer-joined" });
    await settle();
    expect(peerHere).toHaveBeenCalledWith(true);
    expect(offered).toHaveBeenCalledTimes(1);
    expect(socket.messages.at(-1)).toMatchObject({ type: "offer" });

    // An end the platform refuses keeps the screen closed.
    socket.deliver({ type: "peer-left" });
    vi.mocked(fetch).mockImplementation(async () => new Response("{}", { status: 403 }));
    socket.deliver({ ...CLAIM, sessionId: "s3" });
    await settleRetries();
    socket.deliver({ type: "peer-joined" });
    await settle();
    expect(offered).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it("keeps trying to end a refused claim while the platform fails, and opens the screen once it has", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const peerHere = vi.fn();
    const { offered, stream } = fakePeer();
    // Every try of the first end, and of its first retry, fails on the server.
    const fetch = fakeFetches([500], [500], [500], [500], [500], [500], [200, {}]);
    const acceptClaim = (claim: SessionClaim) => claim.appid !== 730;
    const { session, socket } = start(true, { acceptClaim, stream, onPeerHere: peerHere });
    socket.deliver(CLAIM);
    await settleRetries();
    expect(fetch).toHaveBeenCalledTimes(3);

    // Pushed again meanwhile: the end under way goes on, no second one starts.
    socket.deliver(CLAIM);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    socket.deliver({ type: "peer-joined" });
    expect(peerHere).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await settleRetries();
    expect(fetch).toHaveBeenCalledTimes(6);
    socket.deliver({ type: "peer-joined" });
    expect(peerHere).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(fetch.mock.calls.every(([url]) => url === "https://signal.test/api/sessions/s1/end")).toBe(true);
    expect(offered).not.toHaveBeenCalled();

    // Ended: a renter who joins now is offered the screen.
    socket.deliver({ type: "peer-joined" });
    await settle();
    expect(peerHere).toHaveBeenCalledWith(true);
    expect(offered).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it("gives up on a refused-claim end that hangs, tries again, and opens the screen once it has", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const peerHere = vi.fn();
    const { offered, stream } = fakePeer();
    // The first end never answers; it settles only when aborted. The next one is answered.
    let calls = 0;
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init.signal!;
          if (signal.aborted) return reject(signal.reason);
          if (calls++ > 0) return resolve(new Response("{}", { status: 200 }));
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const acceptClaim = () => false;
    const { session, socket } = start(true, { acceptClaim, stream, onPeerHere: peerHere });
    socket.deliver(CLAIM);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    socket.deliver({ type: "peer-joined" });
    expect(peerHere).not.toHaveBeenCalled();

    // Past the deadline the hung end fails, and the end is tried again after the backoff.
    await vi.advanceTimersByTimeAsync(1_000);
    await settleRetries();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(2);

    socket.deliver({ type: "peer-joined" });
    await settle();
    expect(peerHere).toHaveBeenCalledWith(true);
    expect(offered).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it("stops trying to end a refused claim on stop", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = fakeFetch(500);
    const acceptClaim = () => false;
    const { session, socket } = start(true, { acceptClaim });
    socket.deliver(CLAIM);
    await settleRetries();
    const tries = fetch.mock.calls.length;
    session.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(tries);
  });

  it("launches the game it is told to and answers game-started once it runs", async () => {
    let running: () => void = () => {};
    const launchGame = vi.fn(() => new Promise<void>((resolve) => (running = resolve)));
    const { session, socket } = start(false, { launchGame });
    socket.deliver({ type: "launch-game", sessionId: "s1", appid: 730 });
    await settle();
    expect(launchGame).toHaveBeenCalledWith(730);
    expect(socket.messages.map((m) => m.type)).toEqual(["register"]);

    running();
    await settle();
    expect(socket.messages.at(-1)).toEqual({ type: "game-started" });
    session.stop();
  });

  it("answers game-started at once with nothing to launch, and nothing when the launch fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bare = start();
    bare.socket.deliver({ type: "launch-game", sessionId: "s1", appid: 730 });
    await settle();
    expect(bare.socket.messages.at(-1)).toEqual({ type: "game-started" });
    bare.session.stop();

    FakeSocket.instances = [];
    const failing = start(false, { launchGame: () => Promise.reject(new Error("Steam is not running")) });
    failing.socket.deliver({ type: "launch-game", sessionId: "s1", appid: 730 });
    await settle();
    expect(failing.socket.messages.map((m) => m.type)).toEqual(["register"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    failing.session.stop();
  });

  it("only reports a claim unless asked to serve it", async () => {
    const fetch = fakeFetch(201, { sessionKey: "test-session-key" });
    const { session, socket } = start();
    socket.deliver(CLAIM);
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.closeCalls).toBe(0);
    session.stop();
  });

  it("starts the claimed session by its id and registers again with its session key", async () => {
    const fetch = fakeFetch(201, { sessionKey: "test-session-key" });
    const { session, socket, claims } = start(true);
    socket.deliver(CLAIM);
    expect(claims).toEqual([{ sessionId: "s1", appid: 730, minutes: 45 }]);
    expect(socket.closeCalls).toBe(1); // the machine-key socket leaves first
    await settle();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://signal.test/api/machines/pc-1/session");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ sessionId: "s1" });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-machine-key");

    const streamer = FakeSocket.instances[1]!;
    streamer.accept();
    expect(streamer.messages).toEqual([{ type: "register", hostId: "pc-1", sessionKey: "test-session-key" }]);
    session.stop();
  });

  it("goes back to the machine key when the session ends, without reporting a denial", async () => {
    fakeFetch(201, { sessionKey: "test-session-key" });
    const { session, socket, denied, claimOver } = start(true);
    socket.deliver(CLAIM);
    await settle();
    const streamer = FakeSocket.instances[1]!;
    streamer.accept();

    streamer.deliver({ type: "denied", reason: "session-ended" });
    const next = FakeSocket.instances[2]!;
    next.accept();
    expect(next.messages).toEqual([{ type: "register", hostId: "pc-1", key: "test-machine-key" }]);
    expect(denied).not.toHaveBeenCalled();
    expect(claimOver).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it("tries a start again after a network error or a 5xx, keeping the claim", async () => {
    const fetch = fakeFetches(
      "network",
      [503, { error: "internal-error" }],
      [201, { sessionKey: "test-session-key" }],
    );
    const { session, socket, claimOver } = start(true);
    socket.deliver(CLAIM);
    await settleRetries();
    expect(callsOf(fetch)).toEqual(Array(3).fill(["POST", JSON.stringify({ sessionId: "s1" })]));
    const streamer = FakeSocket.instances[1]!;
    streamer.accept();
    expect(streamer.messages).toEqual([{ type: "register", hostId: "pc-1", sessionKey: "test-session-key" }]);
    expect(claimOver).not.toHaveBeenCalled();
    session.stop();
  });

  it("tries an end again when it fails, then starts the same session", async () => {
    const fetch = fakeFetches(
      [201, { sessionKey: "test-session-key" }],
      [500, { error: "internal-error" }],
      "network",
      [204],
      [201, { sessionKey: "test-session-key-2" }],
    );
    const { session, socket, denied } = start(true);
    socket.deliver(CLAIM);
    await settle();
    const streamer = FakeSocket.instances[1]!;
    streamer.accept();

    streamer.deliver({ type: "denied", reason: "bad-session-key" });
    await settleRetries();
    expect(callsOf(fetch).slice(1)).toEqual([
      ["DELETE", null],
      ["DELETE", null],
      ["DELETE", null],
      ["POST", JSON.stringify({ sessionId: "s1" })],
    ]);
    const next = FakeSocket.instances[2]!;
    next.accept();
    expect(next.messages).toEqual([{ type: "register", hostId: "pc-1", sessionKey: "test-session-key-2" }]);
    expect(denied).not.toHaveBeenCalled();
    session.stop();
  });

  it("does not try a refused start again", async () => {
    const fetch = fakeFetches([401, { error: "bad-machine-key" }]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { session, socket, claimOver } = start(true);
    socket.deliver(CLAIM);
    await settleRetries();
    expect(fetch).toHaveBeenCalledTimes(1);
    const next = FakeSocket.instances[1]!;
    next.accept();
    expect(next.messages).toEqual([{ type: "register", hostId: "pc-1", key: "test-machine-key" }]);
    expect(claimOver).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it("ends a session it no longer serves when the machine key is kept out, and registers again", async () => {
    const fetch = fakeFetches([204]);
    const { session, socket, denied } = start(true);
    socket.deliver({ type: "denied", reason: "session-active" });
    await settle();
    expect(callsOf(fetch)).toEqual([["DELETE", null]]);
    const next = FakeSocket.instances[1]!;
    next.accept();
    expect(next.messages).toEqual([{ type: "register", hostId: "pc-1", key: "test-machine-key" }]);
    expect(denied).not.toHaveBeenCalled();
    session.stop();
  });

  it("reports the machine key kept out when the session holding the room cannot be ended", async () => {
    fakeFetches([401, { error: "bad-machine-key" }]);
    const { session, socket, denied } = start(true);
    socket.deliver({ type: "denied", reason: "session-active" });
    await settle();
    expect(denied).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(1);
    session.stop();
  });

  it("registers with the machine key again when the session holding the room cannot be reached", async () => {
    const fetch = fakeFetches("network", [503, { error: "internal-error" }], "network");
    const { session, socket, denied } = start(true);
    socket.deliver({ type: "denied", reason: "session-active" });
    await settleRetries();
    expect(callsOf(fetch)).toEqual(Array(3).fill(["DELETE", null]));
    const next = FakeSocket.instances[1]!;
    next.accept();
    expect(next.messages).toEqual([{ type: "register", hostId: "pc-1", key: "test-machine-key" }]);
    expect(denied).not.toHaveBeenCalled();
    session.stop();
  });

  it("reports nothing when the session holding the room fails to end after stop", async () => {
    fakeFetches([401, { error: "bad-machine-key" }]);
    const { session, socket, denied } = start(true);
    socket.deliver({ type: "denied", reason: "session-active" });
    session.stop();
    await settle();
    expect(denied).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("ends and starts the same session again when its key is refused", async () => {
    const fetch = fakeFetches(
      [201, { sessionKey: "test-session-key" }],
      [204],
      [201, { sessionKey: "test-session-key-2" }],
    );
    const { session, socket, denied } = start(true);
    socket.deliver(CLAIM);
    await settle();
    const streamer = FakeSocket.instances[1]!;
    streamer.accept();

    streamer.deliver({ type: "denied", reason: "bad-session-key" });
    await settle();
    const calls = fetch.mock.calls.map(([url, init]) => [url, init.method, init.body]);
    expect(calls.slice(1)).toEqual([
      ["https://signal.test/api/machines/pc-1/session", "DELETE", undefined],
      ["https://signal.test/api/machines/pc-1/session", "POST", JSON.stringify({ sessionId: "s1" })],
    ]);
    const next = FakeSocket.instances[2]!;
    next.accept();
    expect(next.messages).toEqual([{ type: "register", hostId: "pc-1", sessionKey: "test-session-key-2" }]);
    expect(denied).not.toHaveBeenCalled();

    // Served like the first: once the session ends, back to the machine key.
    next.deliver({ type: "denied", reason: "session-ended" });
    const machine = FakeSocket.instances[3]!;
    machine.accept();
    expect(machine.messages).toEqual([{ type: "register", hostId: "pc-1", key: "test-machine-key" }]);
    session.stop();
  });

  it("goes back to the machine key when the session cannot be started again", async () => {
    fakeFetches([201, { sessionKey: "test-session-key" }], [204], [409, { error: "not-claimed" }]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { session, socket, denied } = start(true);
    socket.deliver(CLAIM);
    await settle();
    const streamer = FakeSocket.instances[1]!;
    streamer.accept();

    streamer.deliver({ type: "denied", reason: "bad-session-key" });
    await settle();
    const next = FakeSocket.instances[2]!;
    next.accept();
    expect(next.messages).toEqual([{ type: "register", hostId: "pc-1", key: "test-machine-key" }]);
    expect(denied).not.toHaveBeenCalled();
    session.stop();
  });

  it("waits for the next claim with the machine key when the start is refused", async () => {
    fakeFetch(409, { error: "not-claimed" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { session, socket } = start(true);
    socket.deliver(CLAIM);
    await settle();
    const next = FakeSocket.instances[1]!;
    next.accept();
    expect(next.messages).toEqual([{ type: "register", hostId: "pc-1", key: "test-machine-key" }]);
    session.stop();
  });

  it("reports a refused machine key as final", () => {
    const { session, socket, denied } = start(true);
    socket.deliver({ type: "denied", reason: "bad-machine-key" });
    expect(denied).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(1);
    session.stop();
  });

  it("does not register with a key that arrives after stop", async () => {
    fakeFetch(201, { sessionKey: "test-session-key" });
    const { session, socket } = start(true);
    socket.deliver(CLAIM);
    session.stop();
    await settle();
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe("startHostSession with a host certificate", () => {
  /** Serve claims with host certificates handed out in turn, as an attesting caller would. */
  function startAttested(...certs: string[]) {
    const fetch = fakeFetch(201, { sessionKey: "test-session-key" });
    const session = startHostSession({
      serveClaims: true,
      url: "wss://signal.test",
      hostId: "pc-1",
      machineKey: "test-machine-key",
      hostCert: () => certs.shift(),
      stream: {} as MediaStream,
      onPeerHere: () => {},
      onPeerConnection: () => {},
    });
    const socket = FakeSocket.instances[0]!;
    socket.accept();
    return { session, socket, fetch };
  }

  it("registers and starts the session with a fresh certificate each time, and ends it with the machine key", async () => {
    const { session, socket, fetch } = startAttested("cert-1", "cert-2", "cert-3");
    expect(socket.messages).toEqual([{ type: "register", hostId: "pc-1", hostCert: "cert-1" }]);

    socket.deliver(CLAIM);
    await settle();
    const [, start] = fetch.mock.calls[0]!;
    expect((start.headers as Record<string, string>).authorization).toBe("Bearer cert-2");

    // The session ends: back to waiting, on the next certificate.
    const streamer = FakeSocket.instances[1]!;
    streamer.accept();
    streamer.deliver({ type: "denied", reason: "session-ended" });
    const waiting = FakeSocket.instances[2]!;
    waiting.accept();
    expect(waiting.messages).toEqual([{ type: "register", hostId: "pc-1", hostCert: "cert-3" }]);

    // Kept out by a session this app lost: ended with the machine key, the control credential.
    waiting.deliver({ type: "denied", reason: "session-active" });
    await settle();
    const [, end] = fetch.mock.calls.at(-1)!;
    expect(end.method).toBe("DELETE");
    expect((end.headers as Record<string, string>).authorization).toBe("Bearer test-machine-key");
    session.stop();
  });

  it("never sends a certificate unencrypted to another machine", async () => {
    const fetch = fakeFetch(201, { sessionKey: "test-session-key" });
    const start = (url: string) =>
      startHostSession({
        url,
        hostId: "pc-1",
        machineKey: "test-machine-key",
        hostCert: () => "cert-1",
        stream: {} as MediaStream,
        onPeerHere: () => {},
        onPeerConnection: () => {},
      });
    expect(() => start("ws://signal.test")).toThrow(/wss/);
    expect(FakeSocket.instances).toHaveLength(0);
    await expect(
      requestSessionKey({
        url: "ws://signal.test",
        hostId: "pc-1",
        machineKey: "k",
        hostCert: "cert-1",
        sessionId: "s1",
      }),
    ).rejects.toThrow(/wss/);
    expect(fetch).not.toHaveBeenCalled();
    // This machine, as in development, is fine.
    start("ws://localhost:8080").stop();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("falls back to the machine key when no certificate is given", () => {
    const { session, socket } = startAttested();
    expect(socket.messages).toEqual([{ type: "register", hostId: "pc-1", key: "test-machine-key" }]);
    session.stop();
  });
});

describe("startHostSession connection reports", () => {
  it("reports connecting, then registered once the server confirms the room", () => {
    const { session, socket, connection } = start();
    expect(connection).toEqual(["connecting"]);
    socket.deliver({ type: "registered", hostId: "pc-1" });
    expect(connection).toEqual(["connecting", "registered"]);
    session.stop();
  });

  it("reports offline when the socket drops, and registered again after the retry", () => {
    const { session, socket, connection } = start();
    socket.deliver({ type: "registered", hostId: "pc-1" });
    socket.drop();
    expect(connection.at(-1)).toBe("offline");

    vi.advanceTimersByTime(500);
    const retry = FakeSocket.instances[1]!;
    retry.accept();
    retry.deliver({ type: "registered", hostId: "pc-1" });
    expect(connection).toEqual(["connecting", "registered", "offline", "connecting", "registered"]);
    session.stop();
  });

  it("reports no drop for a socket it handed over to a session key", async () => {
    fakeFetch(201, { sessionKey: "test-session-key" });
    const { session, socket, connection } = start(true);
    socket.deliver({ type: "registered", hostId: "pc-1" });
    socket.deliver(CLAIM);
    socket.drop(); // the machine-key socket's close lands after the handover began
    await settle();
    const streamer = FakeSocket.instances[1]!;
    streamer.accept();
    streamer.deliver({ type: "registered", hostId: "pc-1" });
    expect(connection).toEqual(["connecting", "registered", "connecting", "registered"]);
    session.stop();
  });

  it("reports no drop after a refusal or after stop", () => {
    const refused = start();
    refused.socket.deliver({ type: "denied", reason: "bad-machine-key" });
    refused.socket.drop();
    expect(refused.connection).toEqual(["connecting"]);
    refused.session.stop();

    FakeSocket.instances = [];
    const stopped = start();
    stopped.session.stop();
    stopped.socket.drop();
    expect(stopped.connection).toEqual(["connecting"]);
  });
});

describe("requestSessionKey", () => {
  it("posts to the signaling server's own origin over http for ws", async () => {
    const fetch = fakeFetch(201, { sessionKey: "test-session-key" });
    const key = await requestSessionKey({
      url: "ws://127.0.0.1:8080",
      hostId: "pc 1",
      machineKey: "test-machine-key",
      sessionId: "s1",
    });
    expect(key).toBe("test-session-key");
    expect(fetch.mock.calls[0]![0]).toBe("http://127.0.0.1:8080/api/machines/pc%201/session");
  });

  it("throws with the status alone when refused", async () => {
    fakeFetch(401, { error: "bad-machine-key" });
    await expect(
      requestSessionKey({ url: "wss://signal.test", hostId: "pc-1", machineKey: "wrong", sessionId: "s1" }),
    ).rejects.toThrow("session start answered 401");
  });
});
