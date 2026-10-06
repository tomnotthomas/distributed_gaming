// Unit tests for what may pass between a player and a crewmate watching them.
// watch.test.ts covers the signaling server carrying it; these cover the rules.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SignalMessage } from "../protocol.js";
import { relayServers } from "../protocol.js";
import { isRelayCandidate, relaySdp, watchFrame } from "../watchIce.js";

describe("watch connections are relay-only", () => {
  it("takes only TURN relays from the servers a watch may use", () => {
    const turn = { urls: ["turn:relay.test:3478", "turns:relay.test:5349"], username: "u", credential: "c" };
    assert.deepEqual(
      relayServers([{ urls: "stun:stun.test:3478" }, turn, { urls: ["stun:a.test", "stun:b.test"] }]),
      [turn],
    );
    assert.deepEqual(relayServers([{ urls: "stun:stun.test:3478" }]), []);
  });

  it("tells a relay candidate from one carrying the user's own address", () => {
    assert.equal(
      isRelayCandidate("candidate:3 1 udp 41885439 203.0.113.9 50000 typ relay raddr 0.0.0.0 rport 0"),
      true,
    );
    assert.equal(isRelayCandidate("candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host"), false);
    assert.equal(
      isRelayCandidate("candidate:2 1 udp 1 198.51.100.7 1 typ srflx raddr 10.0.0.2 rport 1"),
      false,
    );
    assert.equal(isRelayCandidate("candidate:4 1 tcp 1 198.51.100.7 1 typ prflx"), false);
    assert.equal(isRelayCandidate("candidate:5 1 udp 1 198.51.100.7 1 typ relayed"), false);
  });

  it("blanks IPv6 addresses in an SDP as well", () => {
    const sdp = [
      "c=IN IP6 2001:db8::7",
      "a=rtcp:9 IN IP6 2001:db8::7",
      "a=candidate:1 1 udp 1 2001:db8::7 9 typ host",
    ].join("\r\n");
    assert.equal(relaySdp(sdp), ["c=IN IP6 ::", "a=rtcp:9 IN IP6 ::"].join("\r\n"));
  });

  it("rebuilds the voice chat's talk field by field, and drops what is not it", () => {
    const person = { id: "w1", name: "Lea", mid: "3", inVoice: true, muted: false, mutedByPlayer: false };
    assert.deepEqual(
      watchFrame(
        {
          type: "crew",
          data: { kind: "roster", people: [{ ...person, ip: "198.51.100.7" }] },
        } as unknown as SignalMessage,
        "w1",
      ),
      { type: "crew", data: { kind: "roster", people: [person] }, watchId: "w1" },
    );
    assert.equal(
      watchFrame(
        { type: "crew", data: { kind: "roster", people: [{ id: 1 }] } } as unknown as SignalMessage,
        "w1",
      ),
      null,
    );
    assert.equal(
      watchFrame({ type: "crew", data: { kind: "chat", text: "hi" } } as unknown as SignalMessage, "w1"),
      null,
    );
  });

  it("passes no frame that is not what it says, nor any other type", () => {
    assert.equal(watchFrame({ type: "offer", sdp: { type: "answer", sdp: "v=0" } }, "w1"), null);
    assert.equal(watchFrame({ type: "ice", candidate: {} } as SignalMessage, "w1"), null);
    assert.equal(watchFrame({ type: "game-started", sessionId: "s1" }, "w1"), null);
  });
});
