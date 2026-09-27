// The gaming PC's half of the handshake, shared by the Electron app and the
// web host page. Everything above it differs (Electron picks the screen in
// code, the browser shows a picker); everything from here down is identical.
//
//   register ──► peer-joined ──► addTrack ──► tune encoder ──► offer ──► answer

import { createPeerConnection, DEFAULT_ICE_SERVERS, type IceConfig } from "./peer";
import { connectSignaling, type SignalMessage } from "./signaling";

export type CaptureSettings = {
  width: number;
  frameRate: number;
  maxBitrate: number;
};

export const DEFAULT_CAPTURE: CaptureSettings = {
  width: 1920,
  frameRate: 60,
  maxBitrate: 10_000_000,
};

export type HostSessionOptions = IceConfig & {
  url: string;
  hostId: string;
  stream: MediaStream;
  capture?: CaptureSettings;
  onPeerHere: (here: boolean) => void;
  onPeerConnection: (pc: RTCPeerConnection | null) => void;
};

export function startHostSession(opts: HostSessionOptions): { stop: () => void } {
  const capture = opts.capture ?? DEFAULT_CAPTURE;
  let pc: RTCPeerConnection | null = null;
  // TURN from the server's `registered`, which always precedes `peer-joined`.
  let serverIce: RTCIceServer[] = [];

  const teardown = () => {
    pc?.close();
    pc = null;
    opts.onPeerConnection(null);
  };

  const offerTo = async (send: (m: SignalMessage) => void) => {
    teardown();
    pc = createPeerConnection({
      ...opts,
      iceServers: opts.iceServers ?? [...DEFAULT_ICE_SERVERS, ...serverIce],
    });
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

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: "offer", sdp: offer });
  };

  const signaling = connectSignaling({
    url: opts.url,
    onOpen: (send) => send({ type: "register", hostId: opts.hostId }),
    onMessage: (msg, send) => {
      switch (msg.type) {
        case "registered":
          serverIce = msg.iceServers ?? [];
          break;
        case "peer-joined":
          opts.onPeerHere(true);
          void offerTo(send);
          break;
        case "answer":
          if (msg.sdp) void pc?.setRemoteDescription(msg.sdp);
          break;
        case "ice":
          if (msg.candidate) void pc?.addIceCandidate(msg.candidate).catch(() => {});
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
