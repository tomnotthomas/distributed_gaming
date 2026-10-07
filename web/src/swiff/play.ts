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
// A connection that drops once the game is on screen is not a new launch: the
// game keeps running on the PC, which holds the session for two minutes
// (server/src/grace.ts), and the page joins again with the same ticket, so
// the server hands the seat back and the PC sends a new offer. No Ignition:
// the session shows Reconnecting with how long it has been, retries by itself
// for RECONNECT_AUTO_MS, then leaves the next try to the renter. A join that
// the PC has answered with an offer is left to finish rather than joined over;
// only one with no offer yet is replaced on the beat. It is back
// when the same connection comes back by itself, or when a new one has a
// frame and a fresh game-started, as any new connection must. A page coming
// back to a session already playing (resume) starts the same way.
//
//   live ──► disconnected ──► (RECONNECT_WAIT_MS) join again, every RECONNECT_EVERY_MS until an offer
//                 │                       │
//                 └──────── back ◄────────┘   ── RECONNECT_AUTO_MS ──► gave up: retry()
//
// The stream itself is @swiff/rtc's renter session, the same one /rtc plays;
// this only turns its events into Ignition's steps and the HUD's numbers.
//
// A rental-mode PC (Swiff OS) signs the renter in to Steam first: it sends
// Steam's sign-in code as `steam-login` as soon as the renter is in the room,
// before the stream connects, and Ignition shows it to scan. Its game-started
// comes only once the renter approved it and the game is on screen. While a
// code is up the launch is not slow: the renter is busy with their phone.
// Sign-in time is not billed: on a rental-mode claim, or once the PC sent a
// `steam-login`, the session starts only on a frame after `signed-in` (or at
// it, when a frame came first). The claim's sign-in time is capped
// (signInBy): past it the code is gone and Try again with it, and the renter
// books again.

import { startRenterSession, type RenterSession, type RenterStats, type SteamLogin } from "@swiff/rtc";
import type { Claim } from "./booking";
import type { ScreenText } from "./screenCopy";

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
/** How long a dropped connection has to come back by itself before the room is joined again. */
export const RECONNECT_WAIT_MS = 2_000;
/** How often the room is joined again while the connection stays down. */
export const RECONNECT_EVERY_MS = 4_000;
/** How long the page reconnects by itself before it leaves the next try to the renter. */
export const RECONNECT_AUTO_MS = 15_000;
/** How long the PC holds the session for a renter who dropped (server/src/grace.ts). */
export const RECONNECT_GRACE_MS = 120_000;

/** Ignition's legend: each step as the renter reads it in `t`'s language, for this host and game. */
export function ignitionLabels(
  t: ScreenText,
  host: string | null | undefined,
  game: string | null | undefined,
): string[] {
  return [
    t("ig.reserving"),
    host ? t("ig.waking", { host }) : t("ig.wakingAny"),
    t("ig.negotiating"),
    game ? t("ig.launching", { game }) : t("ig.launchingAny"),
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
  /** Another page of this renter's joined with the same ticket and took the seat: this one stops, the session goes on there. */
  replaced: boolean;
  /** The server took the session start: its clock runs, so leaving ends a session. */
  started: boolean;
  /** Rental mode: Steam's sign-in code for the renter to scan, or their approval of it. */
  steamLogin: SteamLogin | null;
  /**
   * Rental mode: the PC's Steam sign-in (its code was never approved) or the
   * game's launch after it stopped short, or null. Never live on it.
   */
  signInFailed: SignInFailure | null;
  /**
   * When reconnecting began, Unix ms: the drop, or the renter's latest retry;
   * null while the stream plays. A resumed play starts dropped, until it is back.
   */
  lostAt: number | null;
  /**
   * When the connection first dropped, Unix ms, kept across retries: the PC
   * holds the session RECONNECT_GRACE_MS from then. Null while the stream plays.
   */
  droppedAt: number | null;
  /** Reconnecting by itself ran out (RECONNECT_AUTO_MS): the next try is the renter's (retry). */
  gaveUp: boolean;
};

/**
 * Why a rental-mode PC's Steam sign-in stopped short; a PC that does not say
 * counts as the sign-in. `time-up` is the page's own: the claim's sign-in time
 * (signInBy) ran out, and the server ends the claim.
 */
export type SignInFailure = NonNullable<Extract<SteamLogin, { state: "failed" }>["reason"]> | "time-up";

export type PlayOptions = {
  claim: Claim;
  /** Plays the stream; input is read from it too. */
  video: HTMLVideoElement;
  /** Every change of state. */
  onChange: (state: PlayState) => void;
  /** The first frame arrived, once per play: the funnel's session_started. */
  onFirstFrame?: () => void;
  /**
   * The session already plays (a page coming back to it): no Ignition, the
   * game runs on the PC already, and the play starts as a dropped connection does.
   */
  resume?: boolean;
  /** When a resumed session's connection dropped, Unix ms, if known; now if not. */
  droppedAt?: number;
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
  /** After reconnecting gave up, or to try again at once: join the room again and reconnect for RECONNECT_AUTO_MS more. */
  retry: () => void;
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
  const { claim, video, onChange, onFirstFrame, resume = false } = opts;
  const start = opts.start ?? startRenterSession;
  const get = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = opts.now ?? Date.now;

  let state: PlayState = {
    step: resume ? "live" : "waking",
    since: now(),
    slow: false,
    relayed: false,
    stats: null,
    muted: false,
    denied: false,
    replaced: false,
    started: resume,
    lostAt: resume ? now() : null,
    droppedAt: resume ? (opts.droppedAt ?? now()) : null,
    gaveUp: false,
    steamLogin: null,
    signInFailed: null,
  };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let session: RenterSession | null = null;
  let framed = false;
  let gameStarted = false;
  let counted = false;
  /** Rental mode: the claim says so, or the PC sent a steam-login, so the session waits for signed-in. */
  let steamSeen = claim.rentalMode;
  // A resumed session was started, so its renter signed in already.
  let signedIn = resume;
  let connection = 0;
  // The PC offered on the latest join and it has not failed: under way, so not joined over.
  let offered = false;
  let startRetry: ReturnType<typeof setTimeout> | undefined;
  // Joining again while the connection is down, and giving that up.
  let rejoinTimer: ReturnType<typeof setTimeout> | undefined;
  let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
  // A resumed session signed in already.
  const signInBy = resume ? undefined : claim.signInBy;
  let signInTimer: ReturnType<typeof setTimeout> | undefined;

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

  /** (Re)start the clock after which a launch counts as slow. */
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

  /** The claim's sign-in time ran out before the renter signed in: the code and Try again are gone. */
  const timeUp = () => {
    if (stopped || signedIn || state.started) return;
    clearTimeout(timer);
    clearTimeout(startRetry);
    set({ steamLogin: null, signInFailed: "time-up", slow: false });
  };

  /** Not while a Steam sign-in is pending: its time is not billed. */
  const mayStart = () => !steamSeen || signedIn;

  /**
   * The stream is shown once it has a frame and the PC says the game runs, and
   * not before; a connection dropped while live is back then too.
   */
  const maybeLive = () => {
    if (!framed || !gameStarted) return;
    if (state.step !== "live") enter("live");
    else recovered();
  };

  /**
   * The connection dropped while live: say so, and join the room again after
   * RECONNECT_WAIT_MS (at once when it `failed` and cannot come back by
   * itself), then every RECONNECT_EVERY_MS while no offer came, until
   * RECONNECT_AUTO_MS from the drop. A drop while already reconnecting changes nothing.
   */
  const lost = (failed: boolean) => {
    if (state.lostAt !== null) return;
    const at = now();
    offered = false;
    set({ lostAt: at, droppedAt: at, gaveUp: false, stats: null });
    reconnect(failed ? 0 : RECONNECT_WAIT_MS);
  };

  /**
   * Join again after `waitMs`, then on the beat while the PC has not offered
   * on the latest join, until reconnecting by itself runs out.
   */
  const reconnect = (waitMs: number) => {
    clearTimeout(rejoinTimer);
    clearTimeout(giveUpTimer);
    const again = () => {
      if (!offered) join(state.relayed);
      rejoinTimer = setTimeout(again, RECONNECT_EVERY_MS);
    };
    rejoinTimer = setTimeout(again, waitMs);
    giveUpTimer = setTimeout(() => {
      clearTimeout(rejoinTimer);
      session?.end();
      session = null;
      set({ gaveUp: true });
    }, RECONNECT_AUTO_MS);
  };

  /** The stream is back. */
  const recovered = () => {
    if (state.lostAt === null) return;
    clearTimeout(rejoinTimer);
    clearTimeout(giveUpTimer);
    set({ lostAt: null, droppedAt: null, gaveUp: false });
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
      if (stopped || at !== connection) return;
      startRetry = setTimeout(() => mayStart() && startSession(), START_RETRY_MS);
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
    offered = false;
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
          offered = event.pc !== null;
          if (event.pc && state.step === "waking") enter("negotiating");
          break;
        case "connected":
          if (state.step === "waking" || state.step === "negotiating") enter("launching");
          // The same connection, back by itself: it had its frame and game-started.
          maybeLive();
          break;
        case "disconnected":
          // A join that fails while reconnecting is replaced on the next beat.
          if (event.failed) offered = false;
          if (state.step === "live") lost(event.failed);
          break;
        case "first-frame":
          framed = true;
          if (state.step === "waking" || state.step === "negotiating") enter("launching");
          if (!counted) {
            counted = true;
            onFirstFrame?.();
          }
          if (mayStart()) startSession();
          maybeLive();
          break;
        case "game-started":
          gameStarted = true;
          maybeLive();
          break;
        case "steam-login":
          if (state.signInFailed === "time-up") break;
          steamSeen = true;
          signedIn = event.state === "signed-in";
          if (!signedIn) clearTimeout(startRetry);
          else if (framed) startSession();
          if (event.state === "failed") {
            // The sign-in or the launch stopped short: no game-started is coming.
            if (state.step === "launching") clearTimeout(timer);
            set({ steamLogin: null, signInFailed: event.reason ?? "sign-in-timeout", slow: false });
          } else {
            set({ steamLogin: event, signInFailed: null });
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
          // While reconnecting, the PC leaving is the old connection going; the next joins anew.
          if (state.lostAt === null) enter("waking");
          break;
        case "stats":
          set({ stats: event.stats });
          break;
        case "autoplay-muted":
          set({ muted: true });
          break;
        case "denied":
          clearTimeout(timer);
          clearTimeout(rejoinTimer);
          clearTimeout(giveUpTimer);
          // The server ended a claim whose sign-in time ran out: that is the time-up, not a refusal.
          if (
            event.reason !== "replaced" &&
            signInBy !== undefined &&
            now() >= signInBy &&
            !signedIn &&
            !state.started
          ) {
            timeUp();
            break;
          }
          set(event.reason === "replaced" ? { replaced: true } : { denied: true });
          break;
      }
    });
  };

  join(false);
  if (signInBy !== undefined) signInTimer = setTimeout(timeUp, Math.max(0, signInBy - now()));
  if (resume) {
    onChange(state);
    reconnect(RECONNECT_EVERY_MS);
  } else enter("waking");

  return {
    state: () => state,
    /** Try again after a failed Steam sign-in, until the claim's sign-in time is up. */
    retrySignIn() {
      if (stopped || !state.signInFailed || state.signInFailed === "time-up") return;
      if (signInBy !== undefined && now() >= signInBy && !state.started) return timeUp();
      session?.retrySteamLogin();
      set({ signInFailed: null });
      // A PC that never answers with a new code is slow like any other launch.
      if (state.step === "launching") armLaunch();
    },
    retry() {
      if (stopped || state.denied || state.replaced || state.step !== "live") return;
      // The PC's hold still runs from the first drop.
      set({ lostAt: now(), droppedAt: state.droppedAt ?? now(), gaveUp: false });
      join(state.relayed);
      reconnect(RECONNECT_EVERY_MS);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      clearTimeout(startRetry);
      clearTimeout(rejoinTimer);
      clearTimeout(giveUpTimer);
      clearTimeout(signInTimer);
      session?.end();
      session = null;
    },
  };
}
