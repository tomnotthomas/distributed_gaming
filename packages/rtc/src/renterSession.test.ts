// Unit tests for the renter's session, against a fake signaling socket and a
// fake RTCPeerConnection.
//
// The session is the one place the renter's side of a stream is wired
// together, so what matters is the wiring: the ticket goes out, the offer is
// answered, tracks reach the video, input rides the PC's channels, stats are
// read, and — the rule the input path exists for — nothing the renter holds is
// left pressed when the session ends.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeInput, INPUT_CHANNELS, INPUT_PROTOCOL, type InputMessage } from "./input";
import { DEFAULT_ICE_SERVERS } from "./peer";
import {
  readRenterStats,
  startRenterSession,
  type RenterSessionEvent,
  type RenterSessionOptions,
} from "./renterSession";
import type { SignalMessage } from "./signaling";
import { FakeSocket } from "./test/fakes";

const URL = "wss://signal.test";
const TICKET = "test-ticket";
const OFFER = { type: "offer", sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n" } as const;
const TURN = [{ urls: "turn:turn.test:3478", username: "u", credential: "c" }];

/** A data channel the PC opened, as the renter sees it. Records what is sent. */
class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  sent: InputMessage[] = [];

  constructor(
    readonly label: string,
    readonly protocol: string,
    private log: string[],
  ) {
    super();
  }

  /** Decode and record one input message, as the PC would receive it. */
  send(data: Uint8Array<ArrayBuffer>) {
    const msg = decodeInput(data)!;
    this.sent.push(msg);
    this.log.push(`${this.label}:${msg.type}`);
  }

  /** The channel finishes opening. */
  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  /** The channel closes under the renter. */
  drop() {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

/** Stand-in for RTCPeerConnection: the calls the session makes, and hooks to answer them. */
class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];

  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  candidates: RTCIceCandidateInit[] = [];
  statsReports: Record<string, unknown>[] = [];
  closed = false;
  log: string[] = [];
  onicecandidate: ((event: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void) | null = null;
  ondatachannel: ((event: { channel: FakeChannel }) => void) | null = null;
  ontrack: ((event: unknown) => void) | null = null;

  constructor(readonly config: RTCConfiguration) {
    super();
    FakePeerConnection.instances.push(this);
  }

  /** Record the applied offer. */
  async setRemoteDescription(sdp: RTCSessionDescriptionInit) {
    this.remoteDescription = sdp;
  }
  /** Produce a minimal answer; a closed connection refuses, as a real one does. */
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    if (this.closed) throw new Error("closed");
    return { type: "answer", sdp: "v=0\r\n" };
  }
  /** Record the applied answer. */
  async setLocalDescription(sdp: RTCSessionDescriptionInit) {
    this.localDescription = sdp;
  }
  /** Record a delivered remote candidate. */
  async addIceCandidate(candidate: RTCIceCandidateInit) {
    this.candidates.push(candidate);
  }
  /** Serve whatever reports the test put in `statsReports`. */
  async getStats() {
    const reports = this.statsReports;
    return { forEach: (fn: (r: Record<string, unknown>) => void) => reports.forEach(fn) };
  }
  /** Mark the connection closed and log when, relative to input sent. */
  close() {
    this.closed = true;
    this.log.push("pc:close");
  }

  // --- test helpers ---
  /** Move to a connection state and tell listeners. */
  setState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.dispatchEvent(new Event("connectionstatechange"));
  }

  /** The PC's two input channels arrive and open. */
  openInput(protocol = INPUT_PROTOCOL) {
    const keys = new FakeChannel(INPUT_CHANNELS.keys.label, protocol, this.log);
    const motion = new FakeChannel(INPUT_CHANNELS.motion.label, protocol, this.log);
    this.ondatachannel?.({ channel: keys });
    this.ondatachannel?.({ channel: motion });
    keys.open();
    motion.open();
    return { keys, motion };
  }

  /** Deliver a track on the given stream; returns its receiver to inspect. */
  track(kind: "video" | "audio", stream: MediaStream) {
    const receiver: Record<string, unknown> = { jitterBufferTarget: 100 };
    this.ontrack?.({ track: { kind }, streams: [stream], receiver });
    return receiver;
  }
}

let video: HTMLVideoElement;
let play: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  FakePeerConnection.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  // Controllers are polled once a frame; the session must not need a real one.
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  video = document.createElement("video");
  play = vi.fn(async () => {});
  video.play = play as unknown as HTMLVideoElement["play"];
  document.body.append(video);
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
});

afterEach(() => {
  video.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The most recent signaling socket. */
const socket = () => FakeSocket.instances[FakeSocket.instances.length - 1];
/** The most recent peer connection. */
const peer = () => FakePeerConnection.instances[FakePeerConnection.instances.length - 1];
/** Let pending promises settle without moving the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

/** Start a session, open its socket, and collect everything it reports. */
function start(opts: Partial<RenterSessionOptions> = {}) {
  const session = startRenterSession({ url: URL, ticket: TICKET, video, ...opts });
  const events: RenterSessionEvent[] = [];
  session.on((event) => events.push(event));
  socket().accept();
  const types = () => events.map((e) => e.type);
  return { session, events, types };
}

/** Deliver the server's `joined` and the PC's offer, and wait for the answer. */
async function answered(joined: Partial<Extract<SignalMessage, { type: "joined" }>> = {}) {
  socket().deliver({ type: "joined", hostId: "room-1", hostOnline: true, ...joined });
  socket().deliver({ type: "offer", sdp: OFFER });
  await flush();
  return peer();
}

describe("startRenterSession", () => {
  it("joins with the ticket and reports the room", () => {
    const { events } = start();

    expect(socket().url).toBe(URL);
    expect(socket().messages).toEqual([{ type: "join", ticket: TICKET }]);

    socket().deliver({ type: "joined", hostId: "room-1", hostOnline: false });
    expect(events).toEqual([{ type: "joined", hostId: "room-1", hostOnline: false }]);
  });

  it("passes on the PC's Steam sign-in code and the sign-in, before any stream", () => {
    const { events } = start();
    socket().deliver({ type: "joined", hostId: "room-1", hostOnline: true });

    socket().deliver({ type: "steam-login", state: "qr", url: "https://s.team/q/1/42" });
    socket().deliver({ type: "steam-login", state: "signed-in" });

    expect(events.slice(1)).toEqual([
      { type: "steam-login", state: "qr", url: "https://s.team/q/1/42" },
      { type: "steam-login", state: "signed-in" },
    ]);
  });

  it("answers the PC's offer with the server's TURN added to the default STUN", async () => {
    const { events } = start();

    const pc = await answered({ iceServers: TURN });

    expect(pc.config.iceServers).toEqual([...DEFAULT_ICE_SERVERS, ...TURN]);
    expect(pc.remoteDescription).toEqual(OFFER);
    expect(socket().messages.at(-1)).toEqual({ type: "answer", sdp: pc.localDescription });
    expect(events).toContainEqual({ type: "peer-connection", pc });
  });

  it("delivers the PC's candidates, including the ones that beat the offer", async () => {
    start();
    socket().deliver({ type: "joined", hostId: "room-1", hostOnline: true });
    socket().deliver({ type: "offer", sdp: OFFER });
    socket().deliver({ type: "ice", candidate: { candidate: "early" } });
    await flush();
    socket().deliver({ type: "ice", candidate: { candidate: "late" } });
    await flush();

    expect(peer().candidates).toEqual([{ candidate: "early" }, { candidate: "late" }]);
  });

  it("sends its own candidates to the PC", async () => {
    start();
    const pc = await answered();

    pc.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "mine" }) } });
    pc.onicecandidate?.({ candidate: null });

    expect(socket().messages.filter((m) => m.type === "ice")).toEqual([
      { type: "ice", candidate: { candidate: "mine" } },
    ]);
  });

  it("answers with createAnswer's description unchanged", async () => {
    start();
    socket().deliver({ type: "joined", hostId: "room-1", hostOnline: true });
    const answerSdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n";
    const spy = vi
      .spyOn(FakePeerConnection.prototype, "createAnswer")
      .mockResolvedValueOnce({ type: "answer", sdp: answerSdp });
    socket().deliver({ type: "offer", sdp: { type: "offer", sdp: "v=0\r\nm=audio 9 x 111\r\n" } });
    await flush();
    spy.mockRestore();

    expect(peer().localDescription?.sdp).toBe(answerSdp);
    expect(socket().messages).toContainEqual({ type: "answer", sdp: { type: "answer", sdp: answerSdp } });
  });

  it("plays the tracks in the video, without a jitter buffer, and reports them", async () => {
    const { events } = start();
    const pc = await answered();
    const stream = { id: "stream" } as unknown as MediaStream;

    const receiver = pc.track("video", stream);
    pc.track("audio", stream);

    expect(video.srcObject).toBe(stream);
    expect(receiver.jitterBufferTarget).toBe(0);
    expect(play).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === "track")).toHaveLength(2);
  });

  it("mutes the video rather than losing the picture when sound is refused", async () => {
    play.mockRejectedValueOnce(new Error("NotAllowedError"));
    const { types } = start();
    const pc = await answered();

    pc.track("video", { id: "stream" } as unknown as MediaStream);
    await flush();

    expect(video.muted).toBe(true);
    expect(types()).toContain("autoplay-muted");
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("reports connected and the first frame once each", async () => {
    const { types } = start();
    const pc = await answered();
    pc.track("video", { id: "stream" } as unknown as MediaStream);

    pc.setState("connecting");
    pc.setState("connected");
    video.dispatchEvent(new Event("loadeddata"));
    pc.statsReports = [{ type: "inbound-rtp", kind: "video", timestamp: 1000, framesDecoded: 3 }];
    await vi.advanceTimersByTimeAsync(1000);

    expect(types().filter((t) => t === "connected")).toHaveLength(1);
    expect(types().filter((t) => t === "first-frame")).toHaveLength(1);
  });

  it("drops a stats sample the browser refuses", async () => {
    const { types } = start();
    const pc = await answered();
    const spy = vi.spyOn(pc, "getStats").mockRejectedValue(new Error("closed"));

    await vi.advanceTimersByTimeAsync(1000);
    spy.mockRestore();

    expect(types()).not.toContain("stats");
    expect(types()).not.toContain("error");
  });

  it("reports the first frame from stats when there is no video element", async () => {
    const { types } = start({ video: undefined });
    const pc = await answered();

    pc.statsReports = [{ type: "inbound-rtp", kind: "video", timestamp: 1000, framesDecoded: 0 }];
    await vi.advanceTimersByTimeAsync(1000);
    expect(types()).not.toContain("first-frame");

    pc.statsReports = [{ type: "inbound-rtp", kind: "video", timestamp: 2000, framesDecoded: 1 }];
    await vi.advanceTimersByTimeAsync(1000);
    expect(types()).toContain("first-frame");
  });

  it("sends input over the PC's channels once both are open", async () => {
    start();
    const pc = await answered();
    const { keys } = pc.openInput();

    video.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", bubbles: true }));

    expect(keys.sent).toContainEqual({ type: "key", code: "KeyW", down: true });
  });

  it("leaves input off when the PC speaks another input protocol", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    start();
    const pc = await answered();
    const { keys } = pc.openInput("swiff-input/0");

    video.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", bubbles: true }));

    expect(keys.sent).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("sends no input without an input target", async () => {
    start({ video: undefined });
    const pc = await answered();
    const { keys } = pc.openInput();

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", bubbles: true }));

    expect(keys.sent).toEqual([]);
  });

  it("releases held input when an input channel closes", async () => {
    start();
    const pc = await answered();
    const { keys, motion } = pc.openInput();
    video.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", bubbles: true }));

    motion.drop();

    expect(keys.sent.at(-1)).toMatchObject({ type: "release" });
  });

  it("samples stats on the interval and keeps the latest", async () => {
    const { session, events } = start({ statsIntervalMs: 500 });
    const pc = await answered();
    expect(session.stats()).toBeNull();

    pc.statsReports = [
      { type: "inbound-rtp", kind: "video", timestamp: 1000, bytesReceived: 0, framesDecoded: 0 },
      {
        type: "candidate-pair",
        selected: true,
        localCandidateId: "l",
        remoteCandidateId: "r",
        currentRoundTripTime: 0.02,
      },
      { id: "l", type: "local-candidate", candidateType: "srflx" },
      { id: "r", type: "remote-candidate", candidateType: "host" },
    ];
    await vi.advanceTimersByTimeAsync(500);
    pc.statsReports[0] = {
      type: "inbound-rtp",
      kind: "video",
      timestamp: 1500,
      bytesReceived: 62_500,
      framesDecoded: 30,
    };
    await vi.advanceTimersByTimeAsync(500);

    expect(session.stats()).toEqual({
      fps: 60,
      bitrate: 1_000_000,
      rttMs: 20,
      candidateType: "srflx",
      path: "direct",
      framesDecoded: 30,
    });
    expect(events.filter((e) => e.type === "stats")).toHaveLength(2);
  });

  it("treats the PC leaving as the end of the connection, not the session", async () => {
    const { types } = start();
    const pc = await answered();
    const { keys } = pc.openInput();
    video.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", bubbles: true }));

    socket().deliver({ type: "peer-left" });

    expect(pc.closed).toBe(true);
    expect(keys.sent.at(-1)).toMatchObject({ type: "release" });
    expect(types().slice(-2)).toEqual(["peer-connection", "peer-left"]);
    expect(types()).not.toContain("ended");

    // The PC comes back and offers again.
    socket().deliver({ type: "offer", sdp: OFFER });
    await flush();
    expect(FakePeerConnection.instances).toHaveLength(2);
  });

  it("replaces the connection when a new offer arrives, without reporting an error", async () => {
    const { types } = start();
    socket().deliver({ type: "joined", hostId: "room-1", hostOnline: true });
    socket().deliver({ type: "offer", sdp: OFFER });
    socket().deliver({ type: "offer", sdp: OFFER });
    await flush();

    const [first, second] = FakePeerConnection.instances;
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(types()).not.toContain("error");
  });

  it("reports an offer it could not answer", async () => {
    const { events } = start();
    socket().deliver({ type: "joined", hostId: "room-1", hostOnline: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = vi
      .spyOn(FakePeerConnection.prototype, "setRemoteDescription")
      .mockRejectedValueOnce(new Error("Failed to parse SessionDescription. a=secret Invalid value"));
    socket().deliver({ type: "offer", sdp: OFFER });
    await flush();
    spy.mockRestore();

    // Browser parse errors quote SDP lines; none of that may leave the session.
    expect(events).toContainEqual({ type: "error", message: "could not answer the PC's offer" });
    expect(JSON.stringify(events)).not.toContain("a=secret");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("a=secret");
    warn.mockRestore();
  });

  it("stops for good when the ticket is refused", async () => {
    const { events } = start();

    socket().deliver({ type: "denied", reason: "bad-ticket" });

    expect(events).toEqual([
      { type: "denied", reason: "bad-ticket" },
      { type: "ended", reason: "denied" },
    ]);
    expect(socket().closeCalls).toBe(1);
  });

  it("releases input before it hangs up, then ends once", async () => {
    const { session, types } = start();
    const pc = await answered();
    const { keys } = pc.openInput();
    video.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", bubbles: true }));

    session.end();
    session.end();

    expect(keys.sent.at(-1)).toMatchObject({ type: "release" });
    expect(pc.log.indexOf("input-keys:release")).toBeLessThan(pc.log.indexOf("pc:close"));
    expect(socket().closeCalls).toBe(1);
    expect(types().filter((t) => t === "ended")).toHaveLength(1);
    expect(types().at(-1)).toBe("ended");

    // Nothing is sampled or reported after the end.
    const before = types().length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(types()).toHaveLength(before);
    expect(session.stats()).toBeNull();
  });

  it("stops reporting to a listener that unsubscribed", () => {
    const session = startRenterSession({ url: URL, ticket: TICKET });
    const listener = vi.fn();
    const off = session.on(listener);
    off();
    socket().accept();

    socket().deliver({ type: "joined", hostId: "room-1", hostOnline: true });

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("readRenterStats", () => {
  const report = (entries: Record<string, unknown>[]) =>
    ({ forEach: (fn: (r: unknown) => void) => entries.forEach(fn) }) as unknown as RTCStatsReport;

  it("reports nothing it has not measured", () => {
    const { stats, sample } = readRenterStats(report([]), null);

    expect(stats).toEqual({
      fps: null,
      bitrate: null,
      rttMs: null,
      candidateType: "unknown",
      path: "unknown",
      framesDecoded: 0,
    });
    expect(sample).toBeNull();
  });

  it("prefers the browser's own frame rate", () => {
    const { stats } = readRenterStats(
      report([{ type: "inbound-rtp", kind: "video", timestamp: 0, framesPerSecond: 59, framesDecoded: 10 }]),
      null,
    );

    expect(stats.fps).toBe(59);
  });

  it("ignores the audio stream", () => {
    const { sample } = readRenterStats(
      report([{ type: "inbound-rtp", kind: "audio", timestamp: 0, bytesReceived: 5 }]),
      null,
    );

    expect(sample).toBeNull();
  });

  it("calls a path relayed when either end is on TURN", () => {
    const entries = (local: string, remote: string) =>
      report([
        { type: "candidate-pair", state: "succeeded", localCandidateId: "l", remoteCandidateId: "r" },
        { id: "l", candidateType: local },
        { id: "r", candidateType: remote },
      ]);

    expect(readRenterStats(entries("srflx", "relay"), null).stats.path).toBe("relayed");
    expect(readRenterStats(entries("relay", "host"), null).stats).toMatchObject({
      candidateType: "relay",
      path: "relayed",
    });
    expect(readRenterStats(entries("host", "srflx"), null).stats.path).toBe("direct");
  });
});
