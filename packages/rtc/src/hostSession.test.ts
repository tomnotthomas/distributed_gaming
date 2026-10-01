// Unit tests for the gaming PC's half of the handshake, against a fake
// signaling socket. Only the signaling wiring is covered here: no renter
// arrives, so no peer connection is ever made.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHostSession, type SessionClaim } from "./hostSession";
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

/** Start a host session on a fresh fake socket, recording what it reports. */
function start() {
  const claims: SessionClaim[] = [];
  const session = startHostSession({
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
  return { session, socket, claims };
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
});
