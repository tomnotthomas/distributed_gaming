// The PC's side of a latency probe, against a fake peer connection: what it
// answers, what it echoes, and that it never holds a probe open for long.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProbeResponder, MAX_OPEN_PROBES, MAX_PROBE_MESSAGES, PROBE_MAX_MS } from "./probe";
import type { SignalMessage } from "./signaling";

class FakeChannel {
  readyState: RTCDataChannelState = "open";
  binaryType = "blob";
  sent: unknown[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(data: unknown) {
    this.sent.push(data);
  }
}

class FakePeer extends EventTarget {
  static made: FakePeer[] = [];
  iceServers: RTCIceServer[];
  iceGatheringState: RTCIceGatheringState = "new";
  connectionState: RTCPeerConnectionState = "new";
  remote: RTCSessionDescriptionInit | null = null;
  localDescription: { toJSON(): RTCSessionDescriptionInit } | null = null;
  closed = false;
  ondatachannel: ((event: { channel: FakeChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor(iceServers: RTCIceServer[]) {
    super();
    this.iceServers = iceServers;
    FakePeer.made.push(this);
  }
  async setRemoteDescription(sdp: RTCSessionDescriptionInit) {
    this.remote = sdp;
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0 answer" };
  }
  async setLocalDescription(sdp: RTCSessionDescriptionInit) {
    this.localDescription = { toJSON: () => sdp };
  }
  close() {
    this.closed = true;
  }

  // --- test helpers ---
  finishGathering() {
    this.iceGatheringState = "complete";
    this.dispatchEvent(new Event("icegatheringstatechange"));
  }
  openChannel() {
    const channel = new FakeChannel();
    this.ondatachannel?.({ channel });
    return channel;
  }
}

const OFFER = {
  type: "probe-offer",
  probeId: "p1",
  sdp: { type: "offer", sdp: "v=0 offer" },
} as const satisfies SignalMessage;

const TURN = [{ urls: "turn:relay.example:3478", username: "u", credential: "c" }];

function responder() {
  const sent: SignalMessage[] = [];
  const probes = createProbeResponder({
    iceServers: () => TURN,
    createPeer: (servers) => new FakePeer(servers) as unknown as RTCPeerConnection,
  });
  return { probes, sent, send: (msg: SignalMessage) => sent.push(msg) };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakePeer.made = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createProbeResponder", () => {
  it("answers once every candidate is gathered, under the renter's probe id", async () => {
    const { probes, sent, send } = responder();
    probes.answer(OFFER, send);
    await vi.advanceTimersByTimeAsync(0);
    const peer = FakePeer.made[0]!;

    expect(peer.iceServers).toEqual(TURN);
    expect(peer.remote).toEqual(OFFER.sdp);
    expect(sent).toEqual([]);

    peer.finishGathering();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([
      { type: "probe-answer", probeId: "p1", sdp: { type: "answer", sdp: "v=0 answer" } },
    ]);
  });

  it("answers with the candidates it has when gathering is slow", async () => {
    const { probes, sent, send } = responder();
    probes.answer(OFFER, send);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sent.map((m) => m.type)).toEqual(["probe-answer"]);
  });

  it("echoes each message on the renter's channel", async () => {
    const { probes, send } = responder();
    probes.answer(OFFER, send);
    await vi.advanceTimersByTimeAsync(0);
    const channel = FakePeer.made[0]!.openChannel();

    channel.onmessage?.({ data: '{"seq":1,"t":123.4}' });
    channel.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });

    expect(channel.binaryType).toBe("arraybuffer");
    expect(channel.sent).toHaveLength(2);
    expect(channel.sent[0]).toBe('{"seq":1,"t":123.4}');
  });

  it("closes a probe that sends too much or too big", async () => {
    const { probes, send } = responder();
    probes.answer(OFFER, send);
    probes.answer({ ...OFFER, probeId: "p2" }, send);
    await vi.advanceTimersByTimeAsync(0);
    const [chatty, big] = FakePeer.made.map((peer) => peer.openChannel());

    for (let i = 0; i < MAX_PROBE_MESSAGES; i++) chatty!.onmessage?.({ data: "x" });
    expect(FakePeer.made[0]!.closed).toBe(false);
    chatty!.onmessage?.({ data: "x" });
    expect(FakePeer.made[0]!.closed).toBe(true);
    expect(chatty!.sent).toHaveLength(MAX_PROBE_MESSAGES);

    big!.onmessage?.({ data: "x".repeat(257) });
    expect(FakePeer.made[1]!.closed).toBe(true);
    expect(big!.sent).toHaveLength(0);
  });

  it("closes every probe after PROBE_MAX_MS, and when the renter closes the channel", async () => {
    const { probes, send } = responder();
    probes.answer(OFFER, send);
    probes.answer({ ...OFFER, probeId: "p2" }, send);
    await vi.advanceTimersByTimeAsync(0);
    FakePeer.made[1]!.openChannel().onclose?.();
    expect(FakePeer.made.map((p) => p.closed)).toEqual([false, true]);

    await vi.advanceTimersByTimeAsync(PROBE_MAX_MS);
    expect(FakePeer.made.map((p) => p.closed)).toEqual([true, true]);
  });

  it("answers at most MAX_OPEN_PROBES at once, and nothing malformed", async () => {
    const { probes, send } = responder();
    probes.answer({ ...OFFER, sdp: { type: "answer", sdp: "v=0" } }, send);
    probes.answer({ ...OFFER, probeId: "" }, send);
    probes.answer({ ...OFFER, sdp: { type: "offer", sdp: "x".repeat(20_000) } }, send);
    expect(FakePeer.made).toHaveLength(0);

    for (let i = 0; i <= MAX_OPEN_PROBES; i++) probes.answer({ ...OFFER, probeId: `p${i}` }, send);
    expect(FakePeer.made).toHaveLength(MAX_OPEN_PROBES);

    probes.closeAll();
    expect(FakePeer.made.every((p) => p.closed)).toBe(true);
    probes.answer(OFFER, send);
    expect(FakePeer.made).toHaveLength(MAX_OPEN_PROBES + 1);
  });

  it("sends no answer for a probe closed while it gathered", async () => {
    const { probes, sent, send } = responder();
    probes.answer(OFFER, send);
    await vi.advanceTimersByTimeAsync(0);
    probes.closeAll();
    FakePeer.made[0]!.finishGathering();
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toEqual([]);
  });
});
