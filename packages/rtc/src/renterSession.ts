// The renter's half of the handshake, shared by the /rtc test page and the
// Swiff screens. Everything above it is presentation; everything from here
// down is identical wherever a game is streamed.
//
//   join(ticket) ──► joined ──► offer ──► createAnswer ──► answer ──► ontrack ──► <video>
//                                                            └──► ondatachannel ×2 ──► input
//   first frame ──► (the page starts the session) ──► the PC launches the game ──► game-started
//
// One peer connection at a time. The PC re-offers whenever it re-registers, so
// a new offer replaces the old connection rather than adding a second one, and
// input is always released on the old one before it goes.

import { createIceInbox, type IceInbox } from "./iceInbox";
import { inputLane, INPUT_PROTOCOL, type InputLane } from "./input";
import { startInputCapture, type InputCapture } from "./inputCapture";
import {
  candidateTypeOf,
  createPeerConnection,
  DEFAULT_ICE_SERVERS,
  selectedCandidatePair,
  type CandidateType,
  type IceConfig,
} from "./peer";
import { connectSignaling, type SignalMessage } from "./signaling";

type DeniedReason = Extract<SignalMessage, { type: "denied" }>["reason"];

/** How often the stats snapshot is refreshed unless the caller says otherwise. */
export const DEFAULT_STATS_INTERVAL_MS = 1000;

/**
 * One reading of the connection, for a HUD.
 *
 * Each field is null until the browser has reported it: bitrate needs two
 * samples, and a connection that has not picked a path has no round trip.
 */
export type RenterStats = {
  /** Decoded video frames per second. */
  fps: number | null;
  /** Video bits per second received since the previous sample. */
  bitrate: number | null;
  /** Current round trip on the selected candidate pair, in milliseconds. */
  rttMs: number | null;
  /** This side's candidate on the selected pair; see `selectedCandidateType`. */
  candidateType: CandidateType;
  /** Whether media goes straight between the peers or through TURN, on either end. */
  path: "direct" | "relayed" | "unknown";
  /** Video frames decoded so far on this connection. */
  framesDecoded: number;
};

export type RenterSessionEvent =
  /** The server let this ticket into its room. `hostOnline` is false while the PC is away. */
  | { type: "joined"; hostId: string; hostOnline: boolean }
  /** A new peer connection for the PC's offer, or null once it is gone. */
  | { type: "peer-connection"; pc: RTCPeerConnection | null }
  /** A video or audio track arrived. Both share one stream. */
  | { type: "track"; track: MediaStreamTrack; stream: MediaStream }
  /** The browser refused audible playback, so the video was muted to keep the picture. */
  | { type: "autoplay-muted" }
  /** ICE and DTLS are up on the current connection. */
  | { type: "connected" }
  /** The first video frame was decoded on the current connection. */
  | { type: "first-frame" }
  /** The PC says the game booked runs, after the session was started. */
  | { type: "game-started" }
  /** A fresh stats snapshot; also readable through `stats()`. */
  | { type: "stats"; stats: RenterStats }
  /** The PC went away. The session stays in the room and answers its next offer. */
  | { type: "peer-left" }
  /** The server refused the ticket. Final: an `ended` follows. */
  | { type: "denied"; reason: DeniedReason }
  /** Answering the PC's offer failed. */
  | { type: "error"; message: string }
  /** The session is over, because `end()` was called or the ticket was refused. */
  | { type: "ended"; reason: "local" | "denied" };

export type RenterSessionOptions = IceConfig & {
  /** ws:// or wss:// origin of the signaling server. */
  url: string;
  /** The join ticket. It names the room, so the renter never does. */
  ticket: string;
  /** Plays the stream when given. Without one, take the tracks from `track` events. */
  video?: HTMLVideoElement;
  /** Where mouse, keyboard and controller input is read. Defaults to `video`; none means no input. */
  inputTarget?: HTMLVideoElement;
  statsIntervalMs?: number;
};

export type RenterSession = {
  /** Listen for session events; returns the unsubscribe. */
  on(listener: (event: RenterSessionEvent) => void): () => void;
  /** The latest stats snapshot, or null before the first one. */
  stats(): RenterStats | null;
  /** Release held input, hang up and leave the room. Idempotent. */
  end(): void;
};

/** One stats sample's raw counters, kept to turn the next one into rates. */
type Sample = { at: number; bytes: number; frames: number };

/**
 * Reduce a getStats report to the HUD's numbers.
 * `previous` is the last sample on the same connection, for the rates.
 */
export function readRenterStats(
  report: RTCStatsReport,
  previous: Sample | null,
): { stats: RenterStats; sample: Sample | null } {
  let video: RTCInboundRtpStreamStats | undefined;
  report.forEach((entry) => {
    if (entry.type === "inbound-rtp" && entry.kind === "video") video = entry;
  });

  const pair = selectedCandidatePair(report);
  const local = candidateTypeOf(report, pair?.localCandidateId);
  const remote = candidateTypeOf(report, pair?.remoteCandidateId);
  const path =
    local === "relay" || remote === "relay" ? "relayed" : local === "unknown" ? "unknown" : "direct";
  const rtt = pair?.currentRoundTripTime;

  const sample = video
    ? { at: video.timestamp, bytes: video.bytesReceived ?? 0, frames: video.framesDecoded ?? 0 }
    : null;
  const seconds = sample && previous ? (sample.at - previous.at) / 1000 : 0;

  let fps = video?.framesPerSecond ?? null;
  if (fps === null && sample && seconds > 0) fps = (sample.frames - previous!.frames) / seconds;
  const bitrate = sample && seconds > 0 ? ((sample.bytes - previous!.bytes) * 8) / seconds : null;

  return {
    stats: {
      fps,
      bitrate,
      rttMs: rtt === undefined ? null : rtt * 1000,
      candidateType: local,
      path,
      framesDecoded: sample?.frames ?? 0,
    },
    sample,
  };
}

/**
 * Join a room with a ticket and stream the PC's game into this page.
 *
 * Answers the PC's offer, plays its video and audio, sends input over its two
 * input channels, and samples getStats on a fixed interval. Everything that
 * happens is reported as an event; nothing is emitted before `startRenterSession`
 * returns, because the signaling socket opens asynchronously.
 */
export function startRenterSession(opts: RenterSessionOptions): RenterSession {
  const listeners = new Set<(event: RenterSessionEvent) => void>();
  const inputTarget = opts.inputTarget ?? opts.video;
  const statsIntervalMs = opts.statsIntervalMs ?? DEFAULT_STATS_INTERVAL_MS;

  let pc: RTCPeerConnection | null = null;
  // Holds the PC's candidates until its offer has been applied.
  let inbox: IceInbox | null = null;
  // TURN from the server's `joined`, which always precedes the PC's offer.
  let serverIce: RTCIceServer[] = [];
  let capture: InputCapture | null = null;
  // Removes every listener this connection added to the page and its channels.
  let detach: AbortController | null = null;
  let statsTimer: number | undefined;
  let latest: RenterStats | null = null;
  let ended = false;

  const emit = (event: RenterSessionEvent) => listeners.forEach((fn) => fn(event));

  // Releases every key and button still held, while the channels can still
  // carry it. Always before the connection goes away.
  const stopInput = () => {
    capture?.stop();
    capture = null;
  };

  const teardown = () => {
    stopInput();
    window.clearInterval(statsTimer);
    detach?.abort();
    detach = null;
    latest = null;
    if (!pc) return;
    pc.close();
    pc = null;
    inbox = null;
    emit({ type: "peer-connection", pc: null });
  };

  const answer = async (sdp: RTCSessionDescriptionInit, send: (m: SignalMessage) => void) => {
    teardown();
    const connection = createPeerConnection({
      ...opts,
      iceServers: opts.iceServers ?? [...DEFAULT_ICE_SERVERS, ...serverIce],
    });
    const signal = (detach = new AbortController()).signal;
    pc = connection;
    inbox = createIceInbox(connection);
    emit({ type: "peer-connection", pc: connection });

    let sawFrame = false;
    const firstFrame = () => {
      if (sawFrame || pc !== connection) return;
      sawFrame = true;
      emit({ type: "first-frame" });
    };

    connection.onicecandidate = (event) => {
      if (event.candidate) send({ type: "ice", candidate: event.candidate.toJSON() });
    };

    connection.addEventListener(
      "connectionstatechange",
      () => {
        if (connection.connectionState === "connected") emit({ type: "connected" });
      },
      { signal },
    );

    // The PC opens two input channels, keys and motion; input starts once
    // both are open, and stops for good when either closes.
    const lanes: Partial<Record<InputLane, RTCDataChannel>> = {};
    const startInput = () => {
      const { keys, motion } = lanes;
      if (pc !== connection || capture || !inputTarget) return;
      if (keys?.readyState !== "open" || motion?.readyState !== "open") return;
      capture = startInputCapture({ target: inputTarget, channels: { keys, motion } });
    };

    connection.ondatachannel = ({ channel }) => {
      const lane = inputLane(channel.label);
      if (!lane) return;
      if (channel.protocol !== INPUT_PROTOCOL) {
        console.warn(`[swiff] the gaming PC speaks ${channel.protocol || "no"} input protocol; input is off`);
        return;
      }
      lanes[lane] = channel;
      if (channel.readyState === "open") startInput();
      else channel.addEventListener("open", startInput, { once: true, signal });
      channel.addEventListener("close", stopInput, { signal });
    };

    connection.ontrack = (event) => {
      const [stream] = event.streams;
      // The largest single latency win available: do not buffer for smoothness.
      const receiver = event.receiver as RTCRtpReceiver & { jitterBufferTarget?: number };
      if ("jitterBufferTarget" in receiver) receiver.jitterBufferTarget = 0;

      const video = opts.video;
      if (video && stream) {
        video.srcObject = stream;
        video.addEventListener("loadeddata", firstFrame, { once: true, signal });
        // Audio arrives as a second track on the same stream, so ontrack fires
        // twice; starting playback again is harmless and covers the case where
        // the audio track is the one that lands first. A browser that refuses
        // sound must still show the picture.
        void video.play().catch(() => {
          video.muted = true;
          emit({ type: "autoplay-muted" });
          return video.play().catch(() => {});
        });
      }
      if (stream) emit({ type: "track", track: event.track, stream });
    };

    let previous: Sample | null = null;
    statsTimer = window.setInterval(() => {
      void connection.getStats().then(
        (report) => {
          if (pc !== connection) return;
          const reading = readRenterStats(report, previous);
          previous = reading.sample;
          latest = reading.stats;
          emit({ type: "stats", stats: reading.stats });
          if (reading.stats.framesDecoded > 0) firstFrame();
        },
        () => {},
      );
    }, statsIntervalMs);

    try {
      await inbox.setRemote(sdp);
      const reply = await connection.createAnswer();
      await connection.setLocalDescription(reply);
      send({ type: "answer", sdp: connection.localDescription ?? reply });
    } catch (cause) {
      // A connection a newer offer or `end()` already replaced fails on the
      // way out; that is the replacement working, not an error.
      if (pc !== connection) return;
      console.warn(
        "[swiff] could not answer the PC's offer",
        cause instanceof Error ? cause.name : typeof cause,
      );
      emit({ type: "error", message: "could not answer the PC's offer" });
    }
  };

  const signaling = connectSignaling({
    url: opts.url,
    onOpen: (send) => send({ type: "join", ticket: opts.ticket }),
    onMessage: (msg, send) => {
      switch (msg.type) {
        case "denied":
          emit({ type: "denied", reason: msg.reason });
          finish("denied");
          break;
        case "joined":
          serverIce = msg.iceServers ?? [];
          emit({ type: "joined", hostId: msg.hostId, hostOnline: msg.hostOnline });
          break;
        case "offer":
          if (msg.sdp) void answer(msg.sdp, send);
          break;
        case "ice":
          if (msg.candidate) inbox?.add(msg.candidate);
          break;
        case "game-started":
          emit({ type: "game-started" });
          break;
        case "peer-left":
          teardown();
          emit({ type: "peer-left" });
          break;
      }
    },
  });

  function finish(reason: "local" | "denied") {
    if (ended) return;
    ended = true;
    // Let go of everything first, while the channels can still carry it.
    stopInput();
    signaling.close();
    teardown();
    emit({ type: "ended", reason });
    listeners.clear();
  }

  return {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stats: () => latest,
    end: () => finish("local"),
  };
}
