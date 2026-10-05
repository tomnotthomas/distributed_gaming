// Real Play: from a claimed booking to the game on screen, inside Swiff.
//
//   claim ──► join with the ticket ──► offer ──► connected ──► first frame ──► POST /sessions/:id/start
//             Waking <host>            Negotiating stream     Launching <game>        │
//                                                                                     ▼
//                                          live ◄── game-started ◄── the PC launches the game
//
// Ignition's steps follow what actually happened on the connection, not a
// clock, and each has a timeout of its own: the PC that never offers is slow
// (60 s: the renter is offered another machine), a connection that does not
// come up is retried through TURN (20 s, then it is slow too), and a game that
// has not said it runs in 90 s is slow too. Nothing but Ignition shows until
// the PC says the game runs: the frames before it are the PC's desktop or
// Steam, which the renter never sees. Reserving a machine comes before all of
// this, while the booking is made: it is the page's, not the stream's.
//
// The stream itself is @swiff/rtc's renter session, the same one /rtc plays;
// this only turns its events into Ignition's steps and the HUD's numbers.
//
// A rental-mode PC (Swiff OS) signs the renter in to Steam first: it sends
// Steam's sign-in code as `steam-login` as soon as the renter is in the room,
// before the stream connects, and Ignition shows it to scan. Its game-started
// comes only once the renter approved it and the game is on screen. While a
// code is up the launch is not slow: the renter is busy with their phone.

import { startRenterSession, type RenterSession, type RenterStats, type SteamLogin } from "@swiff/rtc";
import type { Claim } from "./booking";

/** Ignition's steps, in order. */
export const IGNITION_STEPS = ["reserving", "waking", "negotiating", "launching"] as const;
export type IgnitionStep = (typeof IGNITION_STEPS)[number];

/** How long the PC has to offer its stream before the renter is offered another machine. */
export const WAKE_TIMEOUT_MS = 60_000;
/** How long a connection has to come up before it is tried again through TURN, and then called slow. */
export const NEGOTIATE_TIMEOUT_MS = 20_000;
/** How long the game has to say it runs before the launch is slow: Ignition stays, and offers another machine. */
export const LAUNCH_TIMEOUT_MS = 90_000;
/** How long a session start lost on the network or the server waits before it is tried again. */
export const START_RETRY_MS = 2_000;

/** Ignition's legend: each step as the renter reads it, for this host and game. */
export function ignitionLabels(host: string | null | undefined, game: string | null | undefined): string[] {
  return [
    "Reserving a machine",
    `Waking ${host || "the machine"}`,
    "Negotiating stream",
    `Launching ${game || "your game"}`,
  ];
}

/**
 * 0 to 1 through Ignition: each step is a quarter, and the current one creeps
 * on with the time spent in it, never reaching the next on time alone.
 */
export function ignitionProgress(step: IgnitionStep, msInStep: number): number {
  const creep = 0.85 * (1 - Math.exp(-Math.max(0, msInStep) / 4_000));
  return (IGNITION_STEPS.indexOf(step) + creep) / IGNITION_STEPS.length;
}

export type PlayState = {
  /** Where Ignition is, or live once the game is on screen. */
  step: Exclude<IgnitionStep, "reserving"> | "live";
  /** When that step began, Unix ms. */
  since: number;
  /** Taking longer than usual: offer another machine. */
  slow: boolean;
  /** The connection was tried again through TURN. */
  relayed: boolean;
  /** The latest reading of the connection, for the HUD. */
  stats: RenterStats | null;
  /** The browser refused sound, so the stream plays muted until the renter turns it on. */
  muted: boolean;
  /** The server refused the ticket: the session is over. */
  denied: boolean;
  /** The server took the session start: its clock runs, so leaving ends a session. */
  started: boolean;
  /** Rental mode: Steam's sign-in code for the renter to scan, or their approval of it. */
  steamLogin: SteamLogin | null;
  /** Rental mode: the PC's Steam sign-in or launch stopped short. Never live on it. */
  signInFailed: boolean;
};

export type PlayOptions = {
  claim: Claim;
  /** Plays the stream; input is read from it too. */
  video: HTMLVideoElement;
  /** Every change of state. */
  onChange: (state: PlayState) => void;
  /** The first frame arrived, once per play: the funnel's session_started. */
  onFirstFrame?: () => void;
  /** Stand-ins for tests. */
  start?: typeof startRenterSession;
  fetch?: typeof fetch;
  now?: () => number;
};

export type Play = {
  /** The state as it stands. */
  state: () => PlayState;
  /** Rental mode: ask the PC for a fresh Steam sign-in code after a failed one; the claim stays. */
  retrySignIn: () => void;
  /** Hang up and stop every timer. Idempotent. Ending the booking is the caller's. */
  stop: () => void;
};

/**
 * Join the claimed room, play its stream into `video`, and report Ignition's
 * steps as they happen. On the first frame the session is started with the
 * join ticket, which has the PC launch the game; it is live once it has a
 * frame and the PC says the game runs, never before: a launch past
 * LAUNCH_TIMEOUT_MS stays on Ignition and is slow.
 */
export function startPlay(opts: PlayOptions): Play {
  const { claim, video, onChange, onFirstFrame } = opts;
  const start = opts.start ?? startRenterSession;
  const get = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = opts.now ?? Date.now;

  let state: PlayState = {
    step: "waking",
    since: now(),
    slow: false,
    relayed: false,
    stats: null,
    muted: false,
    denied: false,
    started: false,
    steamLogin: null,
    signInFailed: false,
  };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let session: RenterSession | null = null;
  let framed = false;
  let gameStarted = false;
  let counted = false;
  let connection = 0;
  let startRetry: ReturnType<typeof setTimeout> | undefined;

  const set = (next: Partial<PlayState>) => {
    state = { ...state, ...next };
    onChange(state);
  };

  /** Move to `step`, with its own timeout armed. */
  const enter = (step: PlayState["step"]) => {
    clearTimeout(timer);
    set({ step, since: now(), slow: false });
    if (step === "waking") timer = setTimeout(() => set({ slow: true }), WAKE_TIMEOUT_MS);
    if (step === "negotiating") armNegotiate();
    // Never shown anyway: what the PC captures before its game runs is its desktop.
    if (step === "launching" && !signingIn()) armLaunch();
  };

  const armLaunch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => set({ slow: true }), LAUNCH_TIMEOUT_MS);
  };

  /** A Steam code is up, or the sign-in failed: the launch waits on the renter, so it is not slow. */
  const signingIn = () => state.steamLogin?.state === "qr" || state.signInFailed;

  /** A connection that does not come up is tried once more through TURN, then called slow. */
  const armNegotiate = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (state.relayed) return set({ slow: true });
      set({ relayed: true });
      join(true);
      armNegotiate();
    }, NEGOTIATE_TIMEOUT_MS);
  };

  /** The stream is shown once it has a frame and the PC says the game runs, and not before. */
  const maybeLive = () => {
    if (framed && gameStarted && state.step !== "live") enter("live");
  };

  /**
   * Start the session with the join ticket: the clock starts, and the PC
   * launches the game. One lost on the network or the server is tried again
   * every START_RETRY_MS while its connection lasts; one refused (the session
   * is over, or the ticket is not its own) ends the launch as a refused ticket
   * does.
   */
  const startSession = () => {
    clearTimeout(startRetry);
    const at = connection;
    const retry = () => {
      if (!stopped && at === connection) startRetry = setTimeout(startSession, START_RETRY_MS);
    };
    void get(`/api/sessions/${encodeURIComponent(claim.sessionId)}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${claim.ticket}` },
    }).then((response) => {
      if (stopped) return;
      if (response.ok) {
        if (!state.started) set({ started: true });
        return;
      }
      if (response.status >= 400 && response.status < 500) {
        clearTimeout(timer);
        return set({ denied: true });
      }
      retry();
    }, retry);
  };

  /** Join the room, through TURN alone when `relay`; a session already in the room makes way. */
  const join = (relay: boolean) => {
    // A new connection earns the stream again: a frame and a fresh game-started.
    framed = false;
    gameStarted = false;
    connection += 1;
    clearTimeout(startRetry);
    session?.end();
    const current = start({ url: claim.signalingUrl, ticket: claim.ticket, video, forceRelay: relay });
    session = current;
    current.on((event) => {
      if (stopped || session !== current) return;
      switch (event.type) {
        case "peer-connection":
          // The PC's offer: it is awake.
          if (event.pc && state.step === "waking") enter("negotiating");
          break;
        case "connected":
          if (state.step === "waking" || state.step === "negotiating") enter("launching");
          break;
        case "first-frame":
          framed = true;
          if (state.step === "waking" || state.step === "negotiating") enter("launching");
          if (!counted) {
            counted = true;
            onFirstFrame?.();
          }
          startSession();
          maybeLive();
          break;
        case "game-started":
          gameStarted = true;
          maybeLive();
          break;
        case "steam-login":
          if (event.state === "failed") {
            // The sign-in or the launch stopped short: no game-started is coming.
            if (state.step === "launching") clearTimeout(timer);
            set({ steamLogin: null, signInFailed: true, slow: false });
          } else {
            set({ steamLogin: event, signInFailed: false });
            if (state.step !== "launching") break;
            if (event.state === "qr") {
              clearTimeout(timer);
              set({ slow: false });
            } else armLaunch();
          }
          break;
        case "peer-left":
          // The PC is handing the room over (to the session's streamer) or
          // went away: wait for its next offer. A live session goes back
          // behind Ignition too, since a new connection's first frames may be
          // the desktop: it is shown again only on a new frame and a fresh
          // game-started.
          framed = false;
          gameStarted = false;
          connection += 1;
          clearTimeout(startRetry);
          enter("waking");
          break;
        case "stats":
          set({ stats: event.stats });
          break;
        case "autoplay-muted":
          set({ muted: true });
          break;
        case "denied":
          clearTimeout(timer);
          set({ denied: true });
          break;
      }
    });
  };

  join(false);
  enter("waking");

  return {
    state: () => state,
    retrySignIn() {
      if (stopped || !state.signInFailed) return;
      session?.retrySteamLogin();
      set({ signInFailed: false });
      // A PC that never answers with a new code is slow like any other launch.
      if (state.step === "launching") armLaunch();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      clearTimeout(startRetry);
      session?.end();
      session = null;
    },
  };
}
