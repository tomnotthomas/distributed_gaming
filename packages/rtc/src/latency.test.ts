// The renter's side of a latency probe, against fake peer connections and a
// fake signaling socket: what it sends, what it makes of the echoes, and that
// it always settles, and soon.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  linkOf,
  PROBE_PINGS,
  PROBE_TIMEOUT_MS,
  probeLatency,
  turnServersOf,
  type ProbeResult,
} from "./latency";
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

/** An offer as a relay-only peer connection writes it: one relay candidate. */
const OFFER_SDP = "v=0\r\na=candidate:6 1 udp 41885439 198.51.100.9 3478 typ relay raddr 0.0.0.0 rport 0\r\n";
const TURN: RTCIceServer = { urls: "turn:turn.test", username: "u", credential: "c" };

class FakePeer extends EventTarget {
  static made: FakePeer[] = [];
  iceGatheringState: RTCIceGatheringState = "complete";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: { sdp: string; toJSON(): RTCSessionDescriptionInit } | null = null;
  /** What createOffer writes. */
  static offer = OFFER_SDP;
  remote: RTCSessionDescriptionInit | null = null;
  channel: FakeChannel | null = null;
  closed = false;
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
    return { type: "offer", sdp: FakePeer.offer };
  }
  async setLocalDescription(sdp: RTCSessionDescriptionInit) {
    this.localDescription = { sdp: sdp.sdp!, toJSON: () => sdp };
  }
  async setRemoteDescription(sdp: RTCSessionDescriptionInit) {
    this.remote = sdp;
  }
  close() {
    this.closed = true;
  }
}

const settle = () => vi.advanceTimersByTimeAsync(0);

/** Start probing `hosts`; the socket opens at once. */
async function start(hosts: string[], iceServers: RTCIceServer[] = [TURN]) {
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
  FakePeer.offer = OFFER_SDP;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("probeLatency", () => {
  it("sends one probe per machine with its token and full offer, over one socket", async () => {
    const stun = { urls: "stun:stun.test" };
    const { socket } = await start(["pc-1", "pc-2"], [stun, TURN]);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.messages).toEqual([
      {
        type: "probe",
        hostId: "pc-1",
        token: "token-pc-1",
        probeId: "p0",
        sdp: { type: "offer", sdp: OFFER_SDP },
      },
      {
        type: "probe",
        hostId: "pc-2",
        token: "token-pc-2",
        probeId: "p1",
        sdp: { type: "offer", sdp: OFFER_SDP },
      },
    ]);
    // Data only, unordered and never resent; through the server's TURN alone, no STUN.
    const [peer] = FakePeer.made;
    expect(peer!.channel!.options).toEqual({ ordered: false, maxRetransmits: 0 });
    expect(peer!.iceServers).toEqual([{ ...TURN, urls: ["turn:turn.test"] }]);
  });

  it("opens a peer connection that gathers relay candidates only, with the server's TURN", async () => {
    let config: RTCConfiguration | undefined;
    vi.stubGlobal(
      "RTCPeerConnection",
      class extends FakePeer {
        constructor(c: RTCConfiguration) {
          super(c.iceServers ?? []);
          config = c;
        }
      },
    );
    const done = probeLatency({
      url: "wss://signal.test",
      targets: [{ hostId: "pc-1", token: "t" }],
      iceServers: [{ urls: ["stun:stun.test", "turns:turn.test:443"], username: "u", credential: "c" }],
      openSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    expect(config).toEqual({
      iceServers: [{ urls: ["turns:turn.test:443"], username: "u", credential: "c" }],
      iceTransportPolicy: "relay",
    });
    FakeSocket.instances[0]!.drop();
    await done;
  });

  it("probes nothing without a TURN relay: no socket, no peer connection, nothing known", async () => {
    for (const iceServers of [[], [{ urls: "stun:stun.test" }]]) {
      const results = await probeLatency({
        url: "wss://signal.test",
        targets: [{ hostId: "pc-1", token: "t" }],
        iceServers,
        createPeer: (servers) => new FakePeer(servers) as unknown as RTCPeerConnection,
      });
      expect(results).toEqual([{ hostId: "pc-1", status: "unanswered" }]);
    }
    expect(FakeSocket.instances).toHaveLength(0);
    expect(FakePeer.made).toHaveLength(0);
  });

  it("offers nothing when the relay gave no candidate in time", async () => {
    FakePeer.offer = "v=0\r\na=candidate:1 1 udp 2122260223 192.168.1.20 51234 typ host\r\n";
    const { socket, done } = await start(["pc-1"]);
    expect(await done).toEqual([{ hostId: "pc-1", status: "unanswered" }]);
    expect(socket.messages).toEqual([]);
    expect(FakePeer.made[0]!.closed).toBe(true);
  });

  it("measures the median round trip and jitter from ten pings", async () => {
    const { socket, done } = await start(["pc-1"]);
    await answerAndEcho(socket, FakePeer.made[0]!, "p0", [20, 22, 20, 21, 20, 30, 20, 21, 20, 22]);
    const [result] = await done;
    expect(result).toEqual({
      hostId: "pc-1",
      status: "measured",
      link: { rttMs: 20.5, jitterMs: 10 },
    });
    expect(FakePeer.made[0]!.channel!.sent).toEqual(
      Array.from({ length: PROBE_PINGS }, (_, seq) => String(seq)),
    );
    expect(FakePeer.made[0]!.closed).toBe(true);
    expect(socket.closeCalls).toBe(1);
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
    expect(linkOf([10, 12, 11, 30, 11])).toEqual({ rttMs: 11, jitterMs: 19 });
    expect(linkOf([8])).toEqual({ rttMs: 8, jitterMs: 0 });
  });
});

describe("turnServersOf", () => {
  it("keeps the TURN URLs alone, with their credentials", () => {
    expect(
      turnServersOf([
        { urls: "stun:a" },
        { urls: ["stun:b", "turn:b?transport=udp", "TURNS:b:443"], username: "u", credential: "c" },
      ]),
    ).toEqual([{ urls: ["turn:b?transport=udp", "TURNS:b:443"], username: "u", credential: "c" }]);
  });
});
