// The PC session handoff: what this app does, as the PC service of
// docs/system-design/session-keys.md, from a renter's claim to the PC being the
// owner's again.
//
//   machine-key socket ── session-claimed { sessionId, appid, minutes }
//     POST /api/machines/:id/session ──► session key
//     host.logon()     the renter's Windows account signs in at the console
//     host.launch()    the streamer starts in it, the session key on its stdin
//       registered ─► peer-joined ─► offer / answer / ICE ─► first-frame
//     POST /api/sessions/:id/start, then launch-game: steam://rungameid/<appid>
//       game-started
//     peer-left { grace }   the renter dropped: the game keeps running and the
//                           streamer lets go of held input; the server ends the
//                           session as grace_expired if they do not come back
//     denied session-ended  the platform session is over, however it ended
//     host.end()       streamer stopped, account signed out and wiped, the
//                      console back with the owner
//     DELETE /api/machines/:id/session, and the machine key again
//
// Where the streamer runs is the SessionHost's business: in the renter's
// account through the Windows session service, or, where that is not
// installed, as a second process in this one (session-host.cjs). The machine
// key never leaves this process: the streamer only ever holds session keys.

import {
  endClaimed,
  endSession,
  requestSessionKey,
  SessionRefused,
  startClaimed,
  type DeniedReason,
  type HostConnection,
  type MachineAuth,
  type SessionClaim,
} from "@swiff/rtc";

/** What the streamer is started with: one line on its stdin. */
export type StreamerInit = { url: string; hostId: string; sessionKey: string; appid: number };

/** What the PC tells a running streamer. */
export type StreamerCommand =
  /** Register again with this fresh session key. */
  | { type: "key"; sessionKey: string }
  /** Launch the booked game: the session has started. */
  | { type: "launch-game" }
  | { type: "stop" };

/** What the streamer, or the session host it runs under, reports. */
export type StreamerEvent =
  | { type: "registered" }
  | { type: "peer-joined" }
  | { type: "peer-left"; grace: number | null }
  | { type: "first-frame" }
  | { type: "game-started"; appid: number }
  | { type: "denied"; reason?: DeniedReason }
  /** The streamer exited. */
  | { type: "exit"; code: number | null }
  /** The session host lost the renter's session: the account signed out, the service went away. */
  | { type: "lost"; why: string };

/** Where a session's streamer runs (session-host.cjs, behind the preload). */
export type SessionHost = {
  /** Sign the renter's account in at the console. Nothing to do where the streamer runs here. */
  logon(): Promise<void>;
  /** Start the streamer, `init` on its stdin. */
  launch(init: StreamerInit): Promise<void>;
  send(command: StreamerCommand): void;
  /** Stop the streamer; sign the renter's account out, wipe it and give the owner the console back. */
  end(): Promise<void>;
  onEvent(listener: (event: StreamerEvent) => void): () => void;
};

/** How far a session has come. */
export type HandoffStep =
  /** Asking the platform for the session key. */
  | "starting"
  /** Signing the renter's account in. */
  | "logging-on"
  /** Starting the streamer. */
  | "launching"
  /** The streamer holds the room; the player has not joined yet. */
  | "waiting-player"
  /** The player joined; the stream is being set up. */
  | "connecting"
  /** The first frame went out: the session has started and the game is launching. */
  | "launching-game"
  | "game-started"
  /** The player dropped and has until `graceUntil` to come back. */
  | "grace"
  /** Giving the PC back to the owner. */
  | "ending";

export type HandoffSession = {
  claim: SessionClaim;
  step: HandoffStep;
  playerHere: boolean;
  /** When a player who dropped runs out of time to come back (ms). */
  graceUntil: number | null;
};

/** The machine-key socket: holds the room between sessions and hears claims. */
export type MachineSocket = { stop: () => void };

export type MachineSocketEvents = {
  onClaim: (claim: SessionClaim) => void;
  onDenied: (reason?: DeniedReason) => void;
  onConnection: (state: HostConnection) => void;
};

export type HandoffOptions = MachineAuth & {
  host: SessionHost;
  /** Open the machine-key socket (startHostSession with no stream, in the app). */
  openMachineSocket: (events: MachineSocketEvents) => MachineSocket;
  /** Whether to take a claim. One turned down is ended at once and never served. */
  acceptClaim?: (claim: SessionClaim) => boolean;
  onClaimRefused?: (claim: SessionClaim) => void;
  /** The session as it moves, and null once the PC is the owner's again. */
  onSession?: (session: HandoffSession | null) => void;
  onConnection?: (state: HostConnection) => void;
  /** The machine key was refused. Final. */
  onDenied?: () => void;
};

export type Handoff = {
  /** Stop holding the room. A session running is ended and the PC given back first. */
  stop: () => Promise<void>;
};

/** A fresh key or a relaunched streamer, at most this many times in one session. */
export const MAX_RESTARTS = 3;
/** How long past the server's grace the PC waits before ending the session itself. */
export const GRACE_SLACK_MS = 15_000;
/** Tries at revoking the session's keys before going back to the machine key regardless. */
const REVOKE_TRIES = 5;
const REVOKE_RETRY_MS = 2_000;

const why = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function startHandoff(opts: HandoffOptions): Handoff {
  const auth: MachineAuth = { url: opts.url, hostId: opts.hostId, machineKey: opts.machineKey };
  let stopped = false;
  let socket: MachineSocket | null = null;
  let current: Live | null = null;

  type Live = HandoffSession & {
    started: boolean;
    gameStarted: boolean;
    restarts: number;
    ending: Promise<void> | null;
    graceTimer: ReturnType<typeof setTimeout> | undefined;
  };

  const report = () => {
    if (!current) return opts.onSession?.(null);
    const { claim, step, playerHere, graceUntil } = current;
    opts.onSession?.({ claim, step, playerHere, graceUntil });
  };

  const move = (session: Live, step: HandoffStep) => {
    if (current !== session || session.ending) return;
    session.step = step;
    report();
  };

  const listen = () => {
    socket?.stop();
    socket = opts.openMachineSocket({
      onClaim: (claim) => void claimed(claim),
      onDenied: (reason) => {
        // A session this app lost (it restarted mid-session) keeps the machine
        // key out: end it, and the claim is pushed again on the next register.
        if (reason === "session-active" && !current) return void reclaim();
        if (current) return; // the session start put the socket out: expected
        socket = null;
        opts.onDenied?.();
      },
      onConnection: (state) => opts.onConnection?.(state),
    });
  };

  const reclaim = async () => {
    socket?.stop();
    socket = null;
    try {
      await endSession(auth);
    } catch (cause) {
      if (cause instanceof SessionRefused && cause.status < 500) return opts.onDenied?.();
    }
    if (!stopped && !current) listen();
  };

  const claimed = async (claim: SessionClaim) => {
    if (current || stopped) return; // the same claim, pushed again while it is served
    if (opts.acceptClaim && !opts.acceptClaim(claim)) {
      opts.onClaimRefused?.(claim);
      await endClaimed({ ...auth, sessionId: claim.sessionId }).catch((cause: unknown) => {
        console.warn("[swiff] could not turn the claim down:", why(cause));
      });
      return;
    }
    const session: Live = {
      claim,
      step: "starting",
      playerHere: false,
      graceUntil: null,
      started: false,
      gameStarted: false,
      restarts: 0,
      ending: null,
      graceTimer: undefined,
    };
    current = session;
    report();
    // Starting the host session puts the machine-key socket out; leave first.
    socket?.stop();
    socket = null;
    const gone = () => current !== session || Boolean(session.ending);
    try {
      const sessionKey = await requestSessionKey({ ...auth, sessionId: claim.sessionId });
      if (gone()) return;
      move(session, "logging-on");
      await opts.host.logon();
      if (gone()) return;
      move(session, "launching");
      await opts.host.launch({ url: opts.url, hostId: opts.hostId, sessionKey, appid: claim.appid });
    } catch (cause) {
      console.warn("[swiff] could not start the claimed session:", why(cause));
      // A refused start leaves nothing to end; anything later ends the
      // platform session too, so the player is not left waiting on this PC.
      void end(session, !(cause instanceof SessionRefused));
    }
  };

  /** A fresh session key for the running streamer, or a fresh streamer. */
  const restart = async (session: Live, relaunch: boolean) => {
    if (++session.restarts > MAX_RESTARTS) return end(session, true);
    try {
      await endSession(auth);
      const sessionKey = await requestSessionKey({ ...auth, sessionId: session.claim.sessionId });
      if (current !== session || session.ending) return;
      if (relaunch) {
        await opts.host.launch({
          url: opts.url,
          hostId: opts.hostId,
          sessionKey,
          appid: session.claim.appid,
        });
      } else {
        opts.host.send({ type: "key", sessionKey });
      }
    } catch (cause) {
      console.warn("[swiff] could not restart the streamer:", why(cause));
      void end(session, !(cause instanceof SessionRefused));
    }
  };

  const arrived = async (session: Live) => {
    if (session.started) return;
    session.started = true;
    move(session, "launching-game");
    try {
      await startClaimed({ ...auth, sessionId: session.claim.sessionId });
    } catch (cause) {
      // Over already (409): its session-ended is on its way. Anything else
      // leaves the session running; the game is launched all the same.
      console.warn("[swiff] could not mark the session started:", why(cause));
      if (cause instanceof SessionRefused && cause.status === 409) return;
    }
    if (current === session && !session.ending) opts.host.send({ type: "launch-game" });
  };

  const onEvent = (event: StreamerEvent) => {
    const session = current;
    if (!session || session.ending) return;
    switch (event.type) {
      case "registered":
        if (!session.playerHere && !session.started) move(session, "waiting-player");
        break;
      case "peer-joined":
        clearTimeout(session.graceTimer);
        session.playerHere = true;
        session.graceUntil = null;
        move(
          session,
          session.gameStarted ? "game-started" : session.started ? "launching-game" : "connecting",
        );
        break;
      case "first-frame":
        void arrived(session);
        break;
      case "game-started":
        session.gameStarted = true;
        move(session, "game-started");
        break;
      case "peer-left":
        session.playerHere = false;
        clearTimeout(session.graceTimer);
        if (event.grace === null) {
          session.graceUntil = null;
          move(session, session.started ? session.step : "waiting-player");
          break;
        }
        session.graceUntil = Date.now() + event.grace * 1000;
        // The server ends the session when the grace runs out; should it not,
        // the PC does, shortly after.
        session.graceTimer = setTimeout(
          () => {
            if (current === session && session.step === "grace") void end(session, true);
          },
          event.grace * 1000 + GRACE_SLACK_MS,
        );
        move(session, "grace");
        break;
      case "denied":
        // An expired key after a drop: a fresh one. Anything else: the session is over.
        if (event.reason === "bad-session-key") void restart(session, false);
        else void end(session, false);
        break;
      case "exit":
        void restart(session, true);
        break;
      case "lost":
        console.warn("[swiff] the renter's session was lost:", event.why);
        void end(session, true);
        break;
    }
  };
  const unlisten = opts.host.onEvent(onEvent);

  /**
   * Give the PC back: stop the streamer, sign the renter out and wipe the
   * account, revoke the session's keys, then wait for the next claim. With
   * `endPlatform` the platform session is ended too (the PC cannot serve it).
   */
  const end = (session: Live, endPlatform: boolean): Promise<void> => {
    if (session.ending) return session.ending;
    clearTimeout(session.graceTimer);
    session.step = "ending";
    report();
    session.ending = (async () => {
      opts.host.send({ type: "stop" });
      await opts.host.end().catch((cause: unknown) => {
        console.warn("[swiff] could not give the PC back:", why(cause));
      });
      if (endPlatform) {
        await endClaimed({ ...auth, sessionId: session.claim.sessionId }).catch((cause: unknown) => {
          console.warn("[swiff] could not end the session:", why(cause));
        });
      }
      await revoke();
      if (current === session) current = null;
      report();
      if (!stopped) listen();
    })();
    return session.ending;
  };

  /** End the room's host session, so every key of it is dead. Tried a few times. */
  const revoke = async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await endSession(auth);
      } catch (cause) {
        if (attempt >= REVOKE_TRIES || (cause instanceof SessionRefused && cause.status < 500)) {
          console.warn("[swiff] could not revoke the session's keys:", why(cause));
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, REVOKE_RETRY_MS));
    }
  };

  listen();

  return {
    stop: async () => {
      stopped = true;
      socket?.stop();
      socket = null;
      if (current) await end(current, false);
      unlisten();
    },
  };
}
