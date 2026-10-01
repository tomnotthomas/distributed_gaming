// Unit tests for the gaming PC's half of the handshake, against a fake
// signaling socket and a fake fetch. Only the signaling wiring and the claim
// handover are covered here: no renter arrives, so no peer connection is made.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestSessionKey, startHostSession, type SessionClaim } from "./hostSession";
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

/** Let the handover's fetch and its continuations settle. */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** Start a host session on a fresh fake socket, recording what it reports. */
function start(serveClaims = false) {
  const claims: SessionClaim[] = [];
  const denied = vi.fn();
  const session = startHostSession({
    serveClaims,
    onDenied: denied,
    url: "wss://signal.test",
    hostId: "pc-1",
    machineKey: "test-machine-key",
    stream: {} as MediaStream, // never read: no renter arrives
    onPeerHere: () => {},
    onPeerConnection: () => {},
    onSessionClaimed: (claim) => claims.push(claim),
  });
  const socket = FakeSocket.instances[0]!;
  socket.accept();
  return { session, socket, claims, denied };
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
    const { session, socket, denied } = start(true);
    socket.deliver(CLAIM);
    await settle();
    const streamer = FakeSocket.instances[1]!;
    streamer.accept();

    streamer.deliver({ type: "denied", reason: "session-ended" });
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
