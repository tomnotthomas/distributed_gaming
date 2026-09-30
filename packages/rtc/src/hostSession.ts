// The gaming PC's half of the handshake, shared by the Electron app and the
// web host page. Everything above it differs (Electron picks the screen in
// code, the browser shows a picker); everything from here down is identical.
//
//   register ──► peer-joined ──► addTrack ──► tune encoder ──► input channels ──► offer ──► answer

import { createIceInbox, type IceInbox } from "./iceInbox";
import { INPUT_CHANNELS, type InputLane } from "./input";
import { DEFAULT_AUDIO_BITRATE, withStereoOpus } from "./opus";
import { createPeerConnection, DEFAULT_ICE_SERVERS, type IceConfig } from "./peer";
import { connectSignaling, type SignalMessage } from "./signaling";

export type CaptureSettings = {
  width: number;
  frameRate: number;
  maxBitrate: number;
  /** Opus ceiling. Only used when the capture actually carries sound. */
  audioBitrate: number;
};

export const DEFAULT_CAPTURE: CaptureSettings = {
  width: 1920,
  frameRate: 60,
  maxBitrate: 10_000_000,
  audioBitrate: DEFAULT_AUDIO_BITRATE,
};

/**
 * Apply a description, preferring the stereo-tuned version of it.
 *
 * Editing SDP that `createOffer` produced is discouraged, and for Opus stereo
 * it is also the only option. A browser that refuses the edit should cost the
 * session its second audio channel, never the session itself — so the
 * untouched description is applied instead and the reason is said out loud.
 */
async function setLocalDescription(
  pc: RTCPeerConnection,
  description: RTCSessionDescriptionInit,
  hasAudio: boolean,
  bitrate: number,
): Promise<void> {
  if (!hasAudio) return pc.setLocalDescription(description);
  try {
    await pc.setLocalDescription(withStereoOpus(description, bitrate));
  } catch (cause) {
    console.warn("[swiff] stereo Opus was rejected; falling back to mono", cause);
    await pc.setLocalDescription(description);
  }
}

export type HostSessionOptions = IceConfig & {
  url: string;
  hostId: string;
  /** This machine's key, from `npm run machine-key`. Without the right one the server refuses the room. */
  machineKey: string;
  stream: MediaStream;
  capture?: CaptureSettings;
  onPeerHere: (here: boolean) => void;
  onPeerConnection: (pc: RTCPeerConnection | null) => void;
  /** The server refused the machine key. Final: the session does not retry. */
  onDenied?: () => void;
  /**
   * The renter's input channels, once per peer connection. Attach both to one
   * `createInputReceiver`, and close that receiver when `onPeerConnection(null)`
   * says the connection is gone: a connection closed from this side fires no
   * `close` on its channels.
   */
  onInputChannels?: (channels: Record<InputLane, RTCDataChannel>) => void;
};

/**
 * Register the host and negotiate its media stream and input channels with renters.
 * Reports peer and channel changes through callbacks; stop closes signaling and
 * tears down the current peer connection.
 */
export function startHostSession(opts: HostSessionOptions): { stop: () => void } {
  const capture = opts.capture ?? DEFAULT_CAPTURE;
  let pc: RTCPeerConnection | null = null;
  // Holds the renter's candidates until the answer has been applied.
  let inbox: IceInbox | null = null;
  // TURN from the server's `registered`, which always precedes `peer-joined`.
  let serverIce: RTCIceServer[] = [];

  const teardown = () => {
    pc?.close();
    pc = null;
    inbox = null;
    opts.onPeerConnection(null);
  };

  const offerTo = async (send: (m: SignalMessage) => void) => {
    teardown();
    pc = createPeerConnection({
      ...opts,
      iceServers: opts.iceServers ?? [...DEFAULT_ICE_SERVERS, ...serverIce],
    });
    inbox = createIceInbox(pc);
    opts.onPeerConnection(pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) send({ type: "ice", candidate: event.candidate.toJSON() });
    };

    const [track] = opts.stream.getVideoTracks();
    const sender = pc.addTrack(track, opts.stream);

    // Each of these fails silently if omitted, and each costs real quality.
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.degradationPreference = "maintain-resolution"; // else Chrome drops to 320x180 under load
    params.encodings[0].maxBitrate = capture.maxBitrate; // else estimation saturates the link
    await sender.setParameters(params);

    // Audio is its own sender. The tuning above is video-only: applying a
    // resolution preference or a 10 Mbit ceiling to an audio track quietly
    // does nothing, and reading it back later suggests it did something.
    const [audio] = opts.stream.getAudioTracks();
    if (audio) pc.addTrack(audio, opts.stream);

    // Created here, by the side that makes the offer, so they are part of the
    // first negotiation rather than a second one the renter would have to start.
    const keys = pc.createDataChannel(INPUT_CHANNELS.keys.label, INPUT_CHANNELS.keys.init);
    const motion = pc.createDataChannel(INPUT_CHANNELS.motion.label, INPUT_CHANNELS.motion.init);
    opts.onInputChannels?.({ keys, motion });

    const offer = await pc.createOffer();
    await setLocalDescription(pc, offer, Boolean(audio), capture.audioBitrate);
    send({ type: "offer", sdp: pc.localDescription ?? offer });
  };

  const signaling = connectSignaling({
    url: opts.url,
    onOpen: (send) => send({ type: "register", hostId: opts.hostId, key: opts.machineKey }),
    onMessage: (msg, send) => {
      switch (msg.type) {
        case "denied":
          opts.onDenied?.();
          break;
        case "registered":
          serverIce = msg.iceServers ?? [];
          break;
        case "peer-joined":
          opts.onPeerHere(true);
          void offerTo(send);
          break;
        case "answer":
          if (msg.sdp) {
            void inbox?.setRemote(msg.sdp).catch((cause) => {
              console.warn("[swiff] could not apply the renter's answer", cause);
            });
          }
          break;
        case "ice":
          if (msg.candidate) inbox?.add(msg.candidate);
          break;
        case "peer-left":
          opts.onPeerHere(false);
          teardown();
          break;
      }
    },
  });

  return {
    stop: () => {
      signaling.close();
      teardown();
    },
  };
}
