// The renter's side of a latency probe, against fake peer connections and a
// fake signaling socket: what it sends, what it makes of the echoes, and that
// it always settles, and soon.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkOf, PROBE_PINGS, PROBE_TIMEOUT_MS, probeLatency, type ProbeResult } from "./latency";
import { FakeSocket } from "./test/fakes";

/** The renter's end of the channel; the test plays the PC by echoing what it sends. */
class FakeChannel {
  readyState: RTCDataChannelState = "connecting";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly options: RTCDataChannelInit) {}
  /** Each ping's round trip in ms, by sequence number: absent or null is lost. */
  rtts: (number | null)[] = [];
  send(data: string) {
    this.sent.push(data);
    const rtt = this.rtts[Number(data)];
    if (rtt !== null && rtt !== undefined) setTimeout(() => this.onmessage?.({ data }), rtt);
  }
  open() {
    this.readyState = "open";
    this.onopen?.();
  }
}

class FakePeer extends EventTarget {
  static made: FakePeer[] = [];
  iceGatheringState: RTCIceGatheringState = "complete";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: { toJSON(): RTCSessionDescriptionInit } | null = null;
  remote: RTCSessionDescriptionInit | null = null;
  channel: FakeChannel | null = null;
  closed = false;
  /** The candidate types on the pair ICE selected. */
  path: { local: string; remote: string } = { local: "srflx", remote: "srflx" };
  onconnectionstatechange: (() => void) | null = null;
  constructor(readonly iceServers: RTCIceServer[]) {
    super();
    FakePeer.made.push(this);
  }
  createDataChannel(_label: string, options: RTCDataChannelInit) {
    this.channel = new FakeChannel(options);
    return this.channel;
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0 offer" };
  }
  async setLocalDescription(sdp: RTCSessionDescriptionInit) {
    this.localDescription = { toJSON: () => sdp };
  }
  async setRemoteDescription(sdp: RTCSessionDescriptionInit) {
    this.remote = sdp;
  }
  async getStats() {
    const reports = [
      { id: "t", type: "transport", selectedCandidatePairId: "pair" },
      { id: "pair", type: "candidate-pair", localCandidateId: "l", remoteCandidateId: "r" },
      { id: "l", type: "local-candidate", candidateType: this.path.local },
      { id: "r", type: "remote-candidate", candidateType: this.path.remote },
    ];
    return new Map(reports.map((r) => [r.id, r]));
  }
  close() {
    this.closed = true;
  }
}

const settle = () => vi.advanceTimersByTimeAsync(0);

/** Start probing `hosts`; the socket opens at once. */
async function start(hosts: string[], iceServers: RTCIceServer[] = []) {
  let result: ProbeResult[] | null = null;
  const done = probeLatency({
    url: "wss://signal.test",
    targets: hosts.map((hostId) => ({ hostId, token: `token-${hostId}` })),
    iceServers,
    createPeer: (servers) => new FakePeer(servers) as unknown as RTCPeerConnection,
    openSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    now: () => Date.now(),
  }).then((r) => (result = r));
  const socket = FakeSocket.instances[0]!;
  socket.accept();
  await settle();
  return { socket, done, result: () => result };
}

/** The PC answers probe `probeId`, its channel opens, and each ping comes back after `rtts[seq]` ms (null: lost). */
async function answerAndEcho(socket: FakeSocket, peer: FakePeer, probeId: string, rtts: (number | null)[]) {
  socket.deliver({ type: "probe-answer", probeId, sdp: { type: "answer", sdp: "v=0 answer" } });
  await settle();
  peer.channel!.rtts = rtts;
  peer.channel!.open();
  await vi.advanceTimersByTimeAsync(1_000);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.instances = [];
  FakePeer.made = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("probeLatency", () => {
  it("sends one probe per machine with its token and full offer, over one socket", async () => {
    const turn = { urls: "turn:turn.test", username: "u", credential: "c" };
    const { socket } = await start(["pc-1", "pc-2"], [turn]);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.messages).toEqual([
      {
        type: "probe",
        hostId: "pc-1",
        token: "token-pc-1",
        probeId: "p0",
        sdp: { type: "offer", sdp: "v=0 offer" },
      },
      {
        type: "probe",
        hostId: "pc-2",
        token: "token-pc-2",
        probeId: "p1",
        sdp: { type: "offer", sdp: "v=0 offer" },
      },
    ]);
    // Data only, unordered and never resent; the server's TURN beside the default STUN.
    const [peer] = FakePeer.made;
    expect(peer!.channel!.options).toEqual({ ordered: false, maxRetransmits: 0 });
    expect(peer!.iceServers.at(-1)).toEqual(turn);
    expect(peer!.iceServers.length).toBeGreaterThan(1);
  });

  it("measures the median round trip and jitter from ten pings, and says the path was direct", async () => {
    const { socket, done } = await start(["pc-1"]);
    await answerAndEcho(socket, FakePeer.made[0]!, "p0", [20, 22, 20, 21, 20, 30, 20, 21, 20, 22]);
    const [result] = await done;
    expect(result).toEqual({
      hostId: "pc-1",
      status: "measured",
      link: { rttMs: 20.5, jitterMs: 10, relayed: false },
    });
    expect(FakePeer.made[0]!.channel!.sent).toEqual(
      Array.from({ length: PROBE_PINGS }, (_, seq) => String(seq)),
    );
    expect(FakePeer.made[0]!.closed).toBe(true);
    expect(socket.closeCalls).toBe(1);
  });

  it("says the path went through TURN when either end of the chosen pair is a relay", async () => {
    const { socket, done } = await start(["pc-1"]);
    FakePeer.made[0]!.path = { local: "srflx", remote: "relay" };
    await answerAndEcho(socket, FakePeer.made[0]!, "p0", Array(10).fill(15));
    const [result] = await done;
    expect(result).toEqual({
      hostId: "pc-1",
      status: "measured",
      link: { rttMs: 15, jitterMs: 0, relayed: true },
    });
  });

  it("measures what came back when some pings are lost", async () => {
    const { socket, done } = await start(["pc-1"]);
    await answerAndEcho(socket, FakePeer.made[0]!, "p0", [10, null, 12, null, 10, 10, 10, 10, 10, null]);
    const [result] = await done;
    expect(result.status).toBe("measured");
    expect(result.status === "measured" && result.link.rttMs).toBe(10);
  });

  it("calls a PC that answered but echoed nothing unreachable", async () => {
    const { socket, done } = await start(["pc-1"]);
    await answerAndEcho(socket, FakePeer.made[0]!, "p0", Array(10).fill(null));
    expect(await done).toEqual([{ hostId: "pc-1", status: "unreachable" }]);
  });

  it("calls a PC that answered but never opened the channel unreachable, at the deadline", async () => {
    const { socket, result } = await start(["pc-1"]);
    socket.deliver({ type: "probe-answer", probeId: "p0", sdp: { type: "answer", sdp: "v=0 answer" } });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(result()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(result()).toEqual([{ hostId: "pc-1", status: "unreachable" }]);
  });

  it("knows nothing of a PC that never answered, or a probe the server refused", async () => {
    const { socket, done } = await start(["pc-1", "pc-2"]);
    socket.deliver({ type: "probe-refused", probeId: "p1", reason: "too-many" });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    expect(await done).toEqual([
      { hostId: "pc-1", status: "unanswered" },
      { hostId: "pc-2", status: "unanswered", reason: "too-many" },
    ]);
    expect(FakePeer.made.every((p) => p.closed)).toBe(true);
  });

  it("gives up at once on probes still waiting when the socket closes", async () => {
    const { socket, done } = await start(["pc-1"]);
    socket.drop();
    expect(await done).toEqual([{ hostId: "pc-1", status: "unanswered" }]);
  });

  it("asks nothing for no machines", async () => {
    expect(await probeLatency({ url: "wss://signal.test", targets: [] })).toEqual([]);
    expect(FakeSocket.instances).toHaveLength(0);
  });
});

describe("linkOf", () => {
  it("takes the median, and the 95th percentile of the change from one round trip to the next", () => {
    expect(linkOf([10, 12, 11, 30, 11], false)).toEqual({ rttMs: 11, jitterMs: 19, relayed: false });
    expect(linkOf([8], true)).toEqual({ rttMs: 8, jitterMs: 0, relayed: true });
  });
});
