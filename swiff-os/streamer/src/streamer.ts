// The streamer's half of the handshake: the Linux counterpart of @swiff/rtc's
// startHostSession, for a process that holds a session key and nothing else.
//
//   register(sessionKey) ──► peer-joined ──► tracks + input channels ──► offer ──► answer
//
// The protocol is the one the desktop host speaks, unchanged: the same
// signaling client, the same two input channels, the same input receiver. What
// differs is underneath. There is no browser here, so the peer connection is
// werift's, and the tracks carry RTP the capture helpers already encoded
// rather than a MediaStream for the browser to encode.
//
// It serves one renter at a time and as many connections as the renter makes
// (a reload is a new peer-joined). It ends when the server puts it out — the
// session ended, or its key is refused after a reconnect — and leaves what
// happens next to swiff-hostd, which started it.

import {
  connectSignaling,
  createIceInbox,
  createInputReceiver,
  DEFAULT_ICE_SERVERS,
  INPUT_CHANNELS,
  type InputReceiver,
  type InputSink,
  type SignalMessage,
} from "@swiff/rtc";
import type { RTCPeerConnection } from "werift";
import type { SessionGrant, StreamerConfig } from "./config";
import type { MediaKind } from "./capture";
import { createPeer, type Peer } from "./peer";

type DeniedReason = Extract<SignalMessage, { type: "denied" }>["reason"];

export type StreamerOptions = {
  config: Pick<StreamerConfig, "serverUrl" | "hostId" | "audio" | "icePortRange" | "forceRelay">;
  grant: SessionGrant;
  /** Where the renter's input goes. Null: received, and dropped. */
  input: InputSink | null;
  /** The renter's decoder needs a keyframe: it just connected, or lost one. */
  onKeyframeNeeded: () => void;
  /** Stand-in for werift's peer connection, so tests can wrap it. */
  makePeer?: typeof createPeer;
  log?: (message: string) => void;
};

export type Streamer = {
  /** An encoded RTP packet from the capture, for the renter connected now. */
  send(kind: MediaKind, packet: Buffer): void;
  /** Settles when the server puts the streamer out, with its reason. */
  readonly ended: Promise<DeniedReason>;
  /** Hang up: close the peer and the socket. */
  stop(): void;
};

export function startStreamer({
  config,
  grant,
  input,
  onKeyframeNeeded,
  makePeer = createPeer,
  log = (m) => console.error(m),
}: StreamerOptions): Streamer {
  let peer: Peer | null = null;
  let receiver: InputReceiver | null = null;
  let inbox: ReturnType<typeof createIceInbox> | null = null;
  // TURN from the server's `registered`, which always comes before `peer-joined`.
  let serverIce: RTCIceServer[] = [];
  let stopped = false;
  let end!: (reason: DeniedReason) => void;
  const ended = new Promise<DeniedReason>((resolve) => (end = resolve));

  /**
   * Run an input call from an event handler. The receiver passes on whatever
   * the sink throws, and an exception escaping a data-channel or signaling
   * callback would take the streamer down with it.
   */
  const guarded = (what: string, call: () => void) => {
    try {
      call();
    } catch (cause) {
      log(`[swiff-streamer] input ${what} failed: ${cause instanceof Error ? cause.message : cause}`);
    }
  };

  const teardown = () => {
    // Lets go of everything the renter held before the connection goes.
    const old = receiver;
    if (old) guarded("release", () => old.close());
    receiver = null;
    inbox = null;
    const gone = peer;
    peer = null;
    void gone?.pc.close().catch(() => {});
  };

  const offerTo = async (send: (m: SignalMessage) => void) => {
    teardown();
    const current = makePeer({
      iceServers: [...DEFAULT_ICE_SERVERS, ...serverIce],
      forceRelay: config.forceRelay,
      icePortRange: config.icePortRange,
      audio: config.audio !== "off",
    });
    peer = current;
    const { pc } = current;
    // werift checks the shape at runtime; the DOM's own type is the protocol's.
    inbox = createIceInbox(pc as unknown as globalThis.RTCPeerConnection);

    pc.onIceCandidate.subscribe((candidate) => {
      if (candidate && peer === current) send({ type: "ice", candidate: candidate.toJSON() });
    });
    pc.connectionStateChange.subscribe((state) => {
      // A keyframe the moment media can flow, so the first frame decodes at once.
      if (state === "connected" && peer === current) onKeyframeNeeded();
    });
    current.video.sender.onPictureLossIndication.subscribe(() => peer === current && onKeyframeNeeded());

    receiver = createInputReceiver({
      sink: input ?? DROP,
      onRelease: (reason) => log(`[swiff-streamer] released the renter's input (${reason})`),
    });
    attachInput(pc, receiver, current);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (peer !== current) return;
    const local = pc.localDescription!;
    send({ type: "offer", sdp: { type: local.type, sdp: local.sdp } });
  };

  /** The renter's input channels, created before the offer so they are in the first negotiation. */
  const attachInput = (pc: RTCPeerConnection, into: InputReceiver, owner: Peer) => {
    for (const lane of ["keys", "motion"] as const) {
      const { label, init } = INPUT_CHANNELS[lane];
      const channel = pc.createDataChannel(label, {
        ordered: init.ordered,
        maxRetransmits: init.maxRetransmits,
        protocol: init.protocol,
      });
      channel.onMessage.subscribe((data) => {
        if (peer === owner && typeof data !== "string") guarded("delivery", () => into.receive(data));
      });
      channel.stateChanged.subscribe((state) => {
        if (state === "closed") guarded("release", () => into.releaseAll("closed"));
      });
    }
  };

  const onMessage = (msg: SignalMessage, send: (m: SignalMessage) => void) => {
    switch (msg.type) {
      case "registered":
        serverIce = msg.iceServers ?? [];
        log("[swiff-streamer] registered; waiting for the renter");
        break;
      case "denied":
        // Final either way: the session is over, or this key cannot open the
        // room again. swiff-hostd decides what comes next from the session.
        log(`[swiff-streamer] the server put the streamer out (${msg.reason})`);
        stop();
        end(msg.reason);
        break;
      case "peer-joined":
        log("[swiff-streamer] the renter joined");
        offerTo(send).catch((cause: unknown) => {
          log(`[swiff-streamer] could not make the offer: ${cause instanceof Error ? cause.message : cause}`);
        });
        break;
      case "answer":
        if (msg.sdp) {
          inbox?.setRemote(msg.sdp).catch(() => {
            log("[swiff-streamer] could not apply the renter's answer");
          });
        }
        break;
      case "ice":
        if (msg.candidate) inbox?.add(msg.candidate);
        break;
      case "peer-left":
        log("[swiff-streamer] the renter left");
        teardown();
        break;
    }
  };

  const signaling = connectSignaling({
    url: config.serverUrl,
    onOpen: (send) => send({ type: "register", hostId: config.hostId, sessionKey: grant.sessionKey }),
    onMessage,
    onStatus: (status) => {
      if (status === "closed" && !stopped) log("[swiff-streamer] signaling dropped; reconnecting");
    },
  });

  function stop() {
    if (stopped) return;
    stopped = true;
    signaling.close();
    teardown();
  }

  return {
    send(kind, packet) {
      const track = kind === "video" ? peer?.video.track : peer?.audio?.track;
      // Before the renter connects there is nowhere to send; werift drops it
      // until the transport is up.
      track?.writeRtp(packet);
    },
    ended,
    stop,
  };
}

const DROP: InputSink = {
  move() {},
  moveBy() {},
  wheel() {},
  button() {},
  key() {},
  gamepad() {},
};
