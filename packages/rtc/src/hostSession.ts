// The gaming PC's half of the handshake, shared by the Electron app and the
// web host page. Everything above it differs (Electron picks the screen in
// code, the browser shows a picker); everything from here down is identical.
//
//   register ──► peer-joined ──► addTrack ──► tune encoder ──► input channels ──► offer ──► answer
//   launch-game (the renter's first frame) ──► launchGame(appid) ──► game-started
//
// With `serveClaims`, it also stands in for the PC service of
// docs/system-design/session-keys.md: on `session-claimed` it starts that
// session's host session and registers again with the session key. A key
// refused mid-session (expired after a drop) is replaced by ending and starting
// the same session again; when the session ends it goes back to the machine key
// to wait for the next claim. A machine key kept out by a session this app lost
// (reloaded mid-session) ends that session, and the server pushes its claim again.
// A claim `acceptClaim` turns down (a game the owner no longer offers) is ended
// at once instead of served, and until the platform confirms that end, no renter
// who joins is offered the screen.
//
// With `hostCert`, the PC service's own socket and each session start use a
// host certificate from attestation instead of the machine key: the hosting
// credential of docs/system-design/session-keys.md. Ending a session stays with
// the machine key, which keeps that right. This client never attests; whoever
// passes `hostCert` does.

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

/**
 * Whether the room is held: `connecting` while a socket opens, `registered`
 * once the server confirms the register, `offline` when a socket drops and the
 * client is retrying.
 */
export type HostConnection = "connecting" | "registered" | "offline";

export type HostSessionOptions = IceConfig & {
  url: string;
  hostId: string;
  /** This machine's key, from `npm run machine-key`. Without the right one the server refuses the room. */
  machineKey: string;
  /**
   * A host certificate from attestation, read afresh for each register and
   * session start: one starts a single session and expires in minutes. When it
   * gives one, the PC service's socket registers with it and the session start
   * bears it; otherwise the machine key does both, as before. A refused or
   * expired certificate is reported through onDenied, final as a refused key.
   * Sent only over `wss:` or to this machine: anyone who sees one can host with
   * it until it is spent or expires, so starting with it over a plain `ws:`
   * URL to another host throws.
   */
  hostCert?: () => string | undefined;
  stream: MediaStream;
  capture?: CaptureSettings;
  onPeerHere: (here: boolean) => void;
  onPeerConnection: (pc: RTCPeerConnection | null) => void;
  /** The server refused the machine key or host certificate. Final: the session does not retry. */
  onDenied?: () => void;
  /**
   * A renter has claimed this machine. The PC's service starts the host session
   * for exactly `sessionId` (POST /api/machines/:id/session); see
   * docs/system-design/session-keys.md.
   */
  onSessionClaimed?: (claim: SessionClaim) => void;
  /**
   * With `serveClaims`: the claimed session is over or could not be started,
   * and this machine waits for the next claim with its machine key again.
   */
  onClaimOver?: () => void;
  /**
   * Start each claimed session itself and serve it with its session key, as the
   * PC service will. Off, a claim is only reported.
   */
  serveClaims?: boolean;
  /**
   * Whether to take a claim: false ends the claimed session at once
   * (POST /api/sessions/:id/end) and reports it to onClaimRefused instead of
   * onSessionClaimed. Without it every claim is taken.
   */
  acceptClaim?: (claim: SessionClaim) => boolean;
  onClaimRefused?: (claim: SessionClaim) => void;
  /**
   * The room's connection, as it changes. A socket this session closes itself
   * (a handover between the machine key and a session key, or stop) reports
   * nothing, and neither does a refused credential: onDenied says that.
   */
  onConnection?: (state: HostConnection) => void;
  /** Each round trip to the server, in ms, timed on the signaling socket's pings. */
  onRtt?: (ms: number) => void;
  /**
   * Launch Steam game `appid`: the renter's first frame arrived and the session
   * started. Answered with `game-started` once it resolves, so it resolves only
   * once the game's own window is what is captured: the renter sees the stream
   * from then on. A rejection sends nothing, and the renter's page stays on
   * Ignition and offers another machine.
   * Called again for every start the renter's page makes, so it must be
   * idempotent. Without it, nothing is launched and nothing is answered: the
   * renter's page stays on Ignition. The desktop app has no launcher until the
   * PC session's streamer exists, so it never answers until then.
   */
  launchGame?: (appid: number) => Promise<void> | void;
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
  if (opts.hostCert) requireEncrypted(opts.url);
  let stopped = false;
  const capture = opts.capture ?? DEFAULT_CAPTURE;
  let pc: RTCPeerConnection | null = null;
  // Holds the renter's candidates until the answer has been applied.
  let inbox: IceInbox | null = null;
  // TURN from the server's `registered`, which always precedes `peer-joined`.
  let serverIce: RTCIceServer[] = [];

  /** Close the renter's peer connection, if any. */
  const teardown = () => {
    pc?.close();
    pc = null;
    inbox = null;
    opts.onPeerConnection(null);
  };

  /** A fresh peer connection with the screen's tracks, offered to the renter through `send`. */
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
   * the service's own between sessions, a session key during one.
   */
  const reconnect = (credential: Credential, claim: SessionClaim | null = null) => {
    leave();
    teardown();
    opts.onPeerHere(false);
    signaling = connect(credential, claim);
  };

  const machine = { url: opts.url, hostId: opts.hostId, machineKey: opts.machineKey };

  /**
   * Refused sessions the platform has not yet confirmed ended. While any is,
   * a renter who joins is not offered the screen: their ticket may be for it.
   */
  const refusing = new Set<string>();

  /** Retries of refused-claim ends still to run, cleared on stop. */
  const endRetries = new Set<ReturnType<typeof setTimeout>>();
  /** Refused sessions with an end call or a retry of it under way. */
  const ending = new Set<string>();

  /**
   * End refused session `sessionId`, trying again with backoff while the
   * platform is unreachable or failing: the screen stays closed until it
   * confirms. A session the platform does not know (404) cannot be served and
   * is let go; any other refusal keeps the screen closed, and the claim is
   * pushed again on the next register.
   */
  const endRefused = (sessionId: string, attempt = 0) => {
    ending.add(sessionId);
    endClaimed({ ...machine, sessionId })
      .then(() => {
        refusing.delete(sessionId);
        ending.delete(sessionId);
      })
      .catch((cause: unknown) => {
        ending.delete(sessionId);
        console.warn(
          "[swiff] could not turn the claim down:",
          cause instanceof Error ? cause.message : cause,
        );
        if (stopped || !refusing.has(sessionId)) return;
        if (cause instanceof SessionRefused && cause.status === 404) refusing.delete(sessionId);
        if (cause instanceof SessionRefused && cause.status < 500) return;
        const retry = setTimeout(
          () => {
            endRetries.delete(retry);
            if (!stopped && refusing.has(sessionId)) endRefused(sessionId, attempt + 1);
            else ending.delete(sessionId);
          },
          Math.min(REFUSE_RETRY_MAX_MS, REFUSE_RETRY_MS * 2 ** attempt),
        );
        endRetries.add(retry);
        ending.add(sessionId);
      });
  };

  /** Turn down a claimed session this machine will not serve, and end it on the platform. */
  const refuse = (claim: SessionClaim) => {
    opts.onClaimRefused?.(claim);
    refusing.add(claim.sessionId);
    // Pushed again while its end is under way: that end goes on.
    if (!ending.has(claim.sessionId)) endRefused(claim.sessionId);
  };

  /** The PC service's own credential: a host certificate when there is one, else the machine key. */
  const service = (): Credential => {
    const hostCert = opts.hostCert?.();
    return hostCert ? { hostCert } : { key: opts.machineKey };
  };

  /** Leave the claim behind and wait for the next one with the service's credential. */
  const waitForNextClaim = () => {
    opts.onClaimOver?.();
    reconnect(service());
  };

  /**
   * Start the claimed session's host session and serve it; with `restart`, end
   * the live one first for a fresh key. On failure, wait for the next claim.
   */
  const serve = (claim: SessionClaim, restart = false) => {
    leave();
    (restart ? endSession(machine) : Promise.resolve())
      .then(() => requestSessionKey({ ...machine, hostCert: opts.hostCert?.(), sessionId: claim.sessionId }))
      .then((sessionKey) => !stopped && reconnect({ sessionKey }, claim))
      .catch((cause: unknown) => {
        console.warn(
          "[swiff] could not start the claimed session:",
          cause instanceof Error ? cause.message : cause,
        );
        if (!stopped) waitForNextClaim();
      });
  };

  /** End the session holding the room, then register with the service's credential; the claim is pushed again. */
  const reclaim = () => {
    leave();
    endSession(machine)
      .then(() => !stopped && reconnect(service()))
      .catch((cause: unknown) => {
        if (stopped) return;
        if (cause instanceof SessionRefused && cause.status < 500) opts.onDenied?.();
        else reconnect(service());
      });
  };

  // Each socket reports under the generation it was opened in. Leaving one
  // starts a new generation, so a socket closed on purpose, or refused, cannot
  // report itself offline after the fact.
  let generation = 0;

  /** Close the socket holding the room now, on purpose. */
  const leave = () => {
    generation++;
    signaling?.close();
    signaling = null;
  };

  /** Register with `credential`; `claim` is the session served with it, null for the service's own. */
  const connect = (credential: Credential, claim: SessionClaim | null) => {
    const mine = ++generation;
    const report = (state: HostConnection) => {
      if (mine === generation && !stopped) opts.onConnection?.(state);
    };
    return connectSignaling({
      url: opts.url,
      onOpen: (send) => send({ type: "register", hostId: opts.hostId, ...credential }),
      onRtt: opts.onRtt,
      onMessage: (msg, send) => {
        if (msg.type === "registered") report("registered");
        // The server hangs up after a refusal; that close is not a drop.
        if (msg.type === "denied") generation++;
        onMessage(msg, send, claim);
      },
      onStatus: (status) => {
        if (status === "connecting") report("connecting");
        else if (status === "closed") report("offline");
      },
    });
  };

  const onMessage = (msg: SignalMessage, send: (m: SignalMessage) => void, claim: SessionClaim | null) => {
    switch (msg.type) {
      case "denied":
        // A session key refused may only have expired: end and start the
        // same session for a fresh one. Once the session is over, back to
        // waiting for the next renter. A machine key kept out by a session
        // this app no longer serves ends it; otherwise its refusal is final.
        if (claim) {
          if (msg.reason === "bad-session-key") serve(claim, true);
          else waitForNextClaim();
        } else if (opts.serveClaims && msg.reason === "session-active") reclaim();
        else opts.onDenied?.();
        break;
      case "registered":
        serverIce = msg.iceServers ?? [];
        break;
      case "session-claimed": {
        const next = { sessionId: msg.sessionId, appid: msg.appid, minutes: msg.minutes };
        if (!claim && opts.acceptClaim && !opts.acceptClaim(next)) {
          refuse(next);
          break;
        }
        opts.onSessionClaimed?.(next);
        if (opts.serveClaims && !claim) serve(next);
        break;
      }
      case "launch-game": {
        const { launchGame } = opts;
        if (!launchGame) break;
        void Promise.resolve()
          .then(() => launchGame(msg.appid))
          .then(
            () => send({ type: "game-started", sessionId: msg.sessionId }),
            // Only a fixed line: the launcher is the caller's, and what it
            // rejects with may carry a ticket or a token.
            () => console.warn(`[swiff] could not launch the game (app ${msg.appid})`),
          );
        break;
      }
      case "peer-joined":
        // With the machine key, a renter may hold a ticket for a session this
        // machine refused: nothing is offered until the platform has ended it.
        if (!claim && refusing.size) {
          console.warn("[swiff] a renter joined while a refused claim is still being ended; not offered");
          break;
        }
        opts.onPeerHere(true);
        void offerTo(send);
        break;
      case "answer":
        if (msg.sdp) {
          void inbox?.setRemote(msg.sdp).catch((cause) => {
            console.warn(
              "[swiff] could not apply the renter's answer:",
              cause instanceof Error ? cause.name : "error",
            );
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

  let signaling: Signaling | null = connect(service(), null);

  return {
    stop: () => {
      stopped = true;
      endRetries.forEach((retry) => clearTimeout(retry));
      endRetries.clear();
      leave();
      teardown();
    },
  };
}

/** Hosts a credential may be sent to unencrypted: this machine only. */
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/** Throws unless `url` is encrypted (`wss:` or `https:`) or on this machine: a host certificate may go there. */
function requireEncrypted(url: string): void {
  const { protocol, hostname } = new URL(url);
  if (protocol === "wss:" || protocol === "https:" || LOOPBACK.includes(hostname)) return;
  throw new Error("a host certificate is sent only over wss:// or to this machine");
}

/** What a host registers with: the machine key or a host certificate (the PC service), or a session key (the streamer). */
type Credential = { key: string } | { hostCert: string } | { sessionKey: string };

/** A session call the server answered with something other than success. Carries the status alone. */
class SessionRefused extends Error {
  readonly status: number;
  constructor(call: "start" | "end", status: number) {
    super(`session ${call} answered ${status}`);
    this.status = status;
  }
}

type MachineAuth = { url: string; hostId: string; machineKey: string };

/** The signaling server's own HTTP origin: `wss://x` → `https://x`. */
export function httpOrigin(url: string): string {
  const origin = new URL(url);
  origin.protocol = origin.protocol === "wss:" ? "https:" : "http:";
  return origin.origin;
}

/** The session route for `hostId` on the signaling server's own HTTP origin. */
const sessionRoute = (url: string, hostId: string): string =>
  `${httpOrigin(url)}/api/machines/${encodeURIComponent(hostId)}/session`;

/** Waits between tries of a session call that failed on the network or the server. */
const RETRY_DELAYS_MS = [500, 1_000];
/** The first wait before ending a refused claim again, doubling up to the second. */
const REFUSE_RETRY_MS = 5_000;
const REFUSE_RETRY_MAX_MS = 60_000;
/** How long ending a refused claim may take, tries included, before it counts as failed. */
const REFUSE_END_DEADLINE_MS = 15_000;

/**
 * `fetch`, tried again after a network error or a 5xx answer, up to three tries
 * in all. Any other answer, a refusal included, is returned at once.
 */
async function sessionFetch(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const last = attempt === RETRY_DELAYS_MS.length;
    try {
      const res = await fetch(url, init);
      if (res.status < 500 || last) return res;
    } catch (cause) {
      if (last) throw cause;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }
}

/**
 * End claimed platform session `sessionId` on this machine, before it was ever
 * served (POST /api/sessions/:id/end). A session already over (409) is ended.
 * Throws when it takes longer than REFUSE_END_DEADLINE_MS.
 */
async function endClaimed({
  url,
  machineKey,
  sessionId,
}: MachineAuth & { sessionId: string }): Promise<void> {
  // A request that hangs would hold the screen closed for good: past the
  // deadline it fails, and the refused claim's end is tried again.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("timed out")), REFUSE_END_DEADLINE_MS);
  let res: Response;
  try {
    res = await sessionFetch(`${httpOrigin(url)}/api/sessions/${encodeURIComponent(sessionId)}/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${machineKey}`, "content-type": "application/json" },
      body: "{}",
      signal: deadline.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (res.status !== 200 && res.status !== 409) throw new SessionRefused("end", res.status);
}

/** End this machine's live host session, if any. Throws with the status alone when refused. */
async function endSession({ url, hostId, machineKey }: MachineAuth): Promise<void> {
  const res = await sessionFetch(sessionRoute(url, hostId), {
    method: "DELETE",
    headers: { authorization: `Bearer ${machineKey}` },
  });
  if (res.status !== 204) throw new SessionRefused("end", res.status);
}

/**
 * Start the host session for claimed platform session `sessionId` with this
 * machine's host certificate when given one, else its key, and return its
 * session key. The HTTP origin is the signaling
 * server's. Tried again on a network error or a 5xx. Throws with the status
 * alone when the server refuses: the body is never surfaced.
 */
export async function requestSessionKey({
  url,
  hostId,
  machineKey,
  hostCert,
  sessionId,
}: MachineAuth & { hostCert?: string; sessionId: string }): Promise<string> {
  if (hostCert) requireEncrypted(url);
  const res = await sessionFetch(sessionRoute(url, hostId), {
    method: "POST",
    headers: { authorization: `Bearer ${hostCert ?? machineKey}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (res.status !== 201) throw new SessionRefused("start", res.status);
  const { sessionKey } = (await res.json()) as { sessionKey?: unknown };
  if (typeof sessionKey !== "string") throw new Error("session start answered no key");
  return sessionKey;
}
