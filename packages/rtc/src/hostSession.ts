// The gaming PC's half of the handshake, shared by the Electron app and the
// web host page. Everything above it differs (Electron picks the screen in
// code, the browser shows a picker); everything from here down is identical.
//
//   register ──► peer-joined ──► addTrack ──► tune encoder ──► input channels ──► offer ──► answer
//
// With `serveClaims`, it also stands in for the PC service of
// docs/system-design/session-keys.md: on `session-claimed` it starts that
// session's host session and registers again with the session key. A key
// refused mid-session (expired after a drop) is replaced by ending and starting
// the same session again; when the session ends it goes back to the machine key
// to wait for the next claim.

import { createIceInbox, type IceInbox } from "./iceInbox";
import { INPUT_CHANNELS, type InputLane } from "./input";
import { DEFAULT_AUDIO_BITRATE, setLocalWithStereoOpus } from "./opus";
import { createPeerConnection, DEFAULT_ICE_SERVERS, type IceConfig } from "./peer";
import { connectSignaling, type Signaling, type SignalMessage } from "./signaling";

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

/** What `session-claimed` says: the platform session to start, the Steam appid and the minutes booked. */
export type SessionClaim = Omit<Extract<SignalMessage, { type: "session-claimed" }>, "type">;

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
   * A renter has claimed this machine. The PC's service starts the host session
   * for exactly `sessionId` (POST /api/machines/:id/session); see
   * docs/system-design/session-keys.md.
   */
  onSessionClaimed?: (claim: SessionClaim) => void;
  /**
   * Start each claimed session itself and serve it with its session key, as the
   * PC service will. Off, a claim is only reported.
   */
  serveClaims?: boolean;
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
  let stopped = false;
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
    await setLocalWithStereoOpus(pc, offer, Boolean(audio), capture.audioBitrate);
    send({ type: "offer", sdp: pc.localDescription ?? offer });
  };

  /**
   * Leave the room as it is held now and register again with `credential`:
   * the machine key between sessions, a session key during one.
   */
  const reconnect = (
    credential: { key: string } | { sessionKey: string },
    claim: SessionClaim | null = null,
  ) => {
    signaling?.close();
    teardown();
    opts.onPeerHere(false);
    signaling = connect(credential, claim);
  };

  /**
   * Start the claimed session's host session and serve it; with `restart`, end
   * the live one first for a fresh key. On failure, wait for the next claim.
   */
  const serve = (claim: SessionClaim, restart = false) => {
    signaling?.close();
    signaling = null;
    const machine = { url: opts.url, hostId: opts.hostId, machineKey: opts.machineKey };
    (restart ? endSession(machine) : Promise.resolve())
      .then(() => requestSessionKey({ ...machine, sessionId: claim.sessionId }))
      .then((sessionKey) => !stopped && reconnect({ sessionKey }, claim))
      .catch((cause: unknown) => {
        console.warn(
          "[swiff] could not start the claimed session:",
          cause instanceof Error ? cause.message : cause,
        );
        if (!stopped) reconnect({ key: opts.machineKey });
      });
  };

  /** Register with `credential`; `claim` is the session served with it, null for the machine key. */
  const connect = (credential: { key: string } | { sessionKey: string }, claim: SessionClaim | null) =>
    connectSignaling({
      url: opts.url,
      onOpen: (send) => send({ type: "register", hostId: opts.hostId, ...credential }),
      onMessage: (msg, send) => onMessage(msg, send, claim),
    });

  const onMessage = (msg: SignalMessage, send: (m: SignalMessage) => void, claim: SessionClaim | null) => {
    switch (msg.type) {
      case "denied":
        // The machine key refused is final. A session key refused may only
        // have expired: end and start the same session for a fresh one. Once
        // the session is over, back to waiting for the next renter.
        if (!claim) opts.onDenied?.();
        else if (msg.reason === "bad-session-key") serve(claim, true);
        else reconnect({ key: opts.machineKey });
        break;
      case "registered":
        serverIce = msg.iceServers ?? [];
        break;
      case "session-claimed": {
        const next = { sessionId: msg.sessionId, appid: msg.appid, minutes: msg.minutes };
        opts.onSessionClaimed?.(next);
        if (opts.serveClaims && !claim) serve(next);
        break;
      }
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
  };

  let signaling: Signaling | null = connect({ key: opts.machineKey }, null);

  return {
    stop: () => {
      stopped = true;
      signaling?.close();
      teardown();
    },
  };
}

type MachineAuth = { url: string; hostId: string; machineKey: string };

/** The session route for `hostId` on the signaling server's own HTTP origin. */
function sessionRoute(url: string, hostId: string): string {
  const origin = new URL(url);
  origin.protocol = origin.protocol === "wss:" ? "https:" : "http:";
  return `${origin.origin}/api/machines/${encodeURIComponent(hostId)}/session`;
}

/** End this machine's live host session, if any. Throws with the status alone when refused. */
async function endSession({ url, hostId, machineKey }: MachineAuth): Promise<void> {
  const res = await fetch(sessionRoute(url, hostId), {
    method: "DELETE",
    headers: { authorization: `Bearer ${machineKey}` },
  });
  if (res.status !== 204) throw new Error(`session end answered ${res.status}`);
}

/**
 * Start the host session for claimed platform session `sessionId` with this
 * machine's key, and return its session key. The HTTP origin is the signaling
 * server's. Throws with the status alone when the server refuses: the body is
 * never surfaced.
 */
export async function requestSessionKey({
  url,
  hostId,
  machineKey,
  sessionId,
}: MachineAuth & { sessionId: string }): Promise<string> {
  const res = await fetch(sessionRoute(url, hostId), {
    method: "POST",
    headers: { authorization: `Bearer ${machineKey}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (res.status !== 201) throw new Error(`session start answered ${res.status}`);
  const { sessionKey } = (await res.json()) as { sessionKey?: unknown };
  if (typeof sessionKey !== "string") throw new Error("session start answered no key");
  return sessionKey;
}
