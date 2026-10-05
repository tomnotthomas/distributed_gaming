import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import posthog, { isPostHogEnabled } from "../posthog";
import {
  bookMachine,
  book,
  BookingRefused,
  continueBooking,
  endBooking,
  fetchBooking,
  followBooking,
  forgetPlay,
  forgetStoredTicket,
  holdPlay,
  machineLost,
  playedElsewhere,
  resumeTicket,
  storedBookingId,
  storedPlay,
  watchBooking,
  type Booking,
  type Claim,
  type NextBest,
  type Refusal,
} from "./booking";
import { chime } from "./chime";
import {
  GAMES,
  MACHINES,
  type Game,
  type Machine,
  type SeedMachine,
  type SessionLength,
  type Spot,
} from "./data";
import { demoNow, machinesFor, readyFor, reason, seedSpots, sessionMinutes } from "./derive";
import { DEFAULT_WEEK, type Week } from "./estimate";
import { askOf, machinesOf, spotOf } from "./live";
import {
  IGNITION_STEPS,
  ignitionLabels,
  ignitionProgress,
  RECONNECT_GRACE_MS,
  startPlay,
  type Play,
  type PlayState,
} from "./play";
import { questionOf, useLive } from "./useLive";
import { pathOf, screenAt } from "./route";
import { fetchMedia, fetchPopular, type Popular } from "./catalog";
import {
  applySteam,
  endSignIn,
  fetchRenter,
  nextCatalog,
  popularCards,
  readSteamFragment,
  refreshRenter,
  sameGames,
  signInNote,
  withMedia,
  storeGames,
  type Renter,
  type SteamProfile,
  type StoreData,
} from "./steam";

export type Screen = "home" | "game" | "profile" | "share";
export type Phase = "idle" | "connecting" | "live";
export type Quality = "auto" | "fps" | "resolution";
export type Device = "kb" | "mouse" | "pad";
/** A machine picked to launch on that was taken first, and the server's next best instead. */
export type Taken = { nextBest: NextBest | null };
/**
 * A session this browser was playing when it went away, still running on the
 * PC: the booking, and until when the PC holds it (Unix ms) once it has
 * missed the renter.
 */
export type Away = { booking: Booking; heldUntil: number | null };
/**
 * A session whose machine was lost (it went offline, or its owner took it
 * back), being carried on elsewhere: the lost booking, its machine's name,
 * whether the owner took it back, when the page heard (Unix ms), the booking
 * carrying it on once the server has made it (matched to the next machine, or
 * queued for one), and whether there turned out to be none.
 */
export type Lost = {
  booking: Booking;
  host: string;
  taken: boolean;
  at: number;
  next: Booking | null;
  failed: boolean;
};

/** The demo's ignition: one 340 ms beat at a time; twelve of them reach a frame. */
const IGNITION_MS = 340;
const IGNITION_BEATS = 12;

/** How often Ignition's dial creeps on while a real launch waits on its next step. */
const IGNITION_TICK_MS = 250;

/** Moss comes back mid-session, so the demo wall can show a machine freeing up. */
const MOSS_FREES_AFTER_MS = 12_000;

/** How long a game that just became playable pulses on the wall. */
const FREED_MS = 2_400;

/** The real clock is read this often; its minutes are all the page shows. */
const CLOCK_MS = 15_000;

/** While the server is still checking a renter's games, their profile is read again this often... */
const CHECKING_READ_MS = 5_000;
/** ...this many times: five minutes... */
const CHECKING_READS = 60;
/** ...then this often, for as long as the server is still checking. */
const CHECKING_SLOW_READ_MS = 30_000;

/**
 * The demo: the five invented machines and the evening pinned to 20:00, at
 * /?demo=1. Everywhere else the wall runs on the real hosts and the real clock.
 */
export const isDemo = (search: string = location.search) => new URLSearchParams(search).get("demo") === "1";

/** Unix ms: pinned to 20:00 today in the demo, else the real clock, kept current. */
function useClock(demo: boolean): number {
  const [now, setNow] = useState(() => (demo ? demoNow() : Date.now()));
  useEffect(() => {
    if (demo) return;
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, [demo]);
  return now;
}

const track = (event: string, props?: Record<string, unknown>) => {
  if (isPostHogEnabled) posthog.capture(event, props);
};

/** No machines at all: what the wall is outside the demo before any host is read. */
const NO_MACHINES: Record<string, SeedMachine> = {};

export function useSwiff({ demo = isDemo() }: { demo?: boolean } = {}) {
  const [screen, setScreen] = useState<Screen>(() => screenAt(location.pathname));
  const [phase, setPhase] = useState<Phase>("idle");
  const [gameId, setGameId] = useState<string | null>(null);
  const [machineId, setMachineId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Outside the demo, a game reaches the wall only once the server says Swiff
  // can run it (server/src/playable.ts): until it answers, the wall is empty.
  const [games, setGames] = useState<Game[]>(demo ? GAMES : []);
  // Who the session cookie signs in. The profile can be empty (no Steam Web API
  // key, or Steam did not answer), so being signed in is read from this alone.
  const [steamId, setSteamId] = useState<string | null>(null);
  const [profile, setProfile] = useState<SteamProfile | null>(null);
  const [steamDenied, setSteamDenied] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [libraryRetrying, setLibraryRetrying] = useState(false);

  const [session, setSession] = useState<SessionLength>("evening");
  // Start still for anyone who has asked their OS for less motion.
  const [motion, setMotion] = useState(
    () => !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  const [sound, setSound] = useState(false);
  const [quality, setQuality] = useState<Quality>("auto");
  const [devices, setDevices] = useState<Device[]>(["kb", "mouse", "pad"]);

  const [mossFree, setMossFree] = useState(false);
  const [beat, setBeat] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [showAll, setShowAll] = useState(false);

  // The renter's booking on the server, the room and ticket its claim handed
  // out, a picked machine that was taken first, and a booking call that failed,
  // with why when the server refused the game (not the renter's to play).
  const [booking, setBooking] = useState<Booking | null>(null);
  const [claim, setClaim] = useState<Claim | null>(null);
  const [taken, setTaken] = useState<Taken | null>(null);
  const [bookingFailed, setBookingFailed] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // Coming back: a session still running from before the page went away
  // (screen A), and a queued booking picked up where it was (screen C).
  const [away, setAway] = useState<Away | null>(null);
  const [queueBack, setQueueBack] = useState(false);
  const [rejoining, setRejoining] = useState(false);
  // A session whose machine was lost, being carried on elsewhere.
  const [lost, setLost] = useState<Lost | null>(null);

  // Real play: the stream's video element, where Ignition stands on the
  // connection (play.ts), when the launch began, and the clock its dial creeps on.
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [play, setPlay] = useState<PlayState | null>(null);
  const [launchedAt, setLaunchedAt] = useState(() => Date.now());
  const [ignitionNow, setIgnitionNow] = useState(() => Date.now());

  // Share your PC: the week the owner describes, and whether How we got this number is open.
  const [week, setWeek] = useState<Week>(DEFAULT_WEEK);
  const [estimateOpen, setEstimateOpen] = useState(false);

  const clock = useClock(demo);

  // The demo's machines. Moss is busy in them; freeing it later is the only
  // mutation, so the pool stays derived rather than kept in state. Outside the
  // demo there are none: the real hosts come from the server.
  const pool = useMemo<Record<string, SeedMachine>>(
    () =>
      !demo ? NO_MACHINES : mossFree ? { ...MACHINES, moss: { ...MACHINES.moss!, busy: false } } : MACHINES,
    [demo, mossFree],
  );

  // Library and chart games are spread across the demo machines; outside the
  // demo there are none, and the real hosts say what they have installed.
  const sharedMachineIds = useMemo(
    () =>
      Object.values(pool)
        .filter((m) => !m.self)
        .map((m) => m.id),
    [pool],
  );

  const prefs = useMemo(() => ({ quality, devices }), [quality, devices]);

  const game = useMemo(() => games.find((g) => g.id === gameId) ?? null, [games, gameId]);
  const signedIn = steamId !== null;
  // Signed out there is no availability anywhere: working it out for every
  // visitor would cost too much. The demo shows its invented machines to anyone.
  const seesAvailability = demo || signedIn;

  const live = useLive({
    enabled: signedIn && !demo,
    appids: useMemo(() => games.map((g) => g.appid), [games]),
    appid: screen === "game" ? (game?.appid ?? null) : null,
    minutes: sessionMinutes(session),
    prefs,
  });

  /** What the wall knows about each game, by game id; empty while nothing is known. */
  const spots = useMemo<Map<string, Spot>>(() => {
    if (demo) return seedSpots(games, pool, session, prefs);
    const wall = live.wall;
    if (!signedIn || !wall) return new Map();
    return new Map(
      games.flatMap((g) => {
        const known = wall.games.get(g.appid);
        return known ? [[g.id, spotOf(known, wall.at)] as const] : [];
      }),
    );
  }, [demo, games, pool, session, prefs, signedIn, live.wall]);

  /** The open game's machines as the server ranked them, once read; null until then. */
  const liveGame = !demo && signedIn && game && live.game?.machines.appid === game.appid ? live.game : null;
  const machines = useMemo<Machine[]>(() => {
    if (!game) return [];
    if (demo) return machinesFor(game, pool, session, prefs);
    return liveGame ? machinesOf(liveGame.machines, liveGame.at) : [];
  }, [demo, game, pool, session, prefs, liveGame]);
  /** Why the first machine is ranked first, in rank()'s words. */
  const why = useMemo(() => {
    if (!game) return undefined;
    if (demo) return reason(game, pool, session, prefs);
    return liveGame?.machines.reason?.label;
  }, [demo, game, pool, session, prefs, liveGame]);
  /** Signed in, the open game's machines have not been read yet. */
  const machinesLoading = !demo && signedIn && game !== null && liveGame === null;
  const picked = useMemo(
    () => machines.find((m) => m.id === machineId && (phase !== "idle" || !m.busy)) ?? null,
    [machines, machineId, phase],
  );

  // --- Steam sign-in ---------------------------------------------------------

  // The game open right now, so a late catalog answer never swaps it out from
  // under the player.
  const openGameId = useRef(gameId);
  openGameId.current = gameId;

  // Which showLibrary call is current, so a slow catalog answer for a profile a
  // retry has since replaced never puts the old wall back.
  const libraryLoad = useRef(0);
  // The last store data read, so a retry swaps games in place rather than
  // blanking the free-to-play tiles until the store answers again.
  const lastCatalog = useRef<StoreData>({ media: [], popular: [] });
  // Which of the hand-authored nine the server says Swiff can run; null in the
  // demo, where all nine stand in.
  const vouched = useRef<ReadonlySet<number> | null>(demo ? null : new Set());
  /** Take the server's word on the hand-authored nine from a popular read. */
  const vouch = useCallback(
    (popular: Popular | null) => {
      if (popular && !demo) vouched.current = new Set(popular.wall.map((entry) => entry.appid));
    },
    [demo],
  );
  /**
   * Put a signed-in renter's wall up: their own games at once, beside whatever
   * free-to-play games the last store read found, then, once Steam's store data
   * says which games are free to play, those, with every card's real art and
   * trailers.
   */
  const showLibrary = useCallback(
    ({ steamId, profile: next }: Renter) => {
      const load = ++libraryLoad.current;
      setSteamId(steamId);
      setProfile(next);
      const kept = storeGames(lastCatalog.current);
      const library = applySteam(next, sharedMachineIds, kept, vouched.current);
      setGames(withMedia(library, kept));
      const curated = GAMES.map((g) => g.appid);
      void Promise.all([fetchMedia([...library.map((g) => g.appid), ...curated]), fetchPopular()]).then(
        ([media, popular]) => {
          if (load !== libraryLoad.current) return;
          vouch(popular);
          lastCatalog.current = nextCatalog(lastCatalog.current, media, popular ? popular.games : null);
          const catalog = storeGames(lastCatalog.current);
          setGames(withMedia(applySteam(next, sharedMachineIds, catalog, vouched.current), catalog));
        },
      );
    },
    [sharedMachineIds, vouch],
  );

  // While the server is still checking games the renter's wall could show, read
  // their profile again, so each game turns up once it is found playable: often
  // at first, then slower, but never stopping while anything is unchecked.
  const checkingReads = useRef(0);
  useEffect(() => {
    if (!profile?.checking || !steamId) return;
    const wait = checkingReads.current < CHECKING_READS ? CHECKING_READ_MS : CHECKING_SLOW_READ_MS;
    const timer = setTimeout(() => {
      checkingReads.current++;
      void fetchRenter().then((renter) => {
        // An unanswered read keeps the profile, and tries again on the next turn.
        if (!renter) setProfile({ ...profile });
        else if (sameGames(renter.profile, profile)) setProfile(renter.profile);
        else showLibrary(renter);
      });
    }, wait);
    return () => clearTimeout(timer);
  }, [profile, steamId, showLibrary]);

  /** Read the renter's library from Steam again, after they have made it public or to check on it now. */
  const retryLibrary = useCallback(() => {
    setLibraryRetrying(true);
    track("library_retried");
    void refreshRenter().then((renter) => {
      setLibraryRetrying(false);
      if (renter) showLibrary(renter);
    });
  }, [showLibrary]);

  useEffect(() => {
    const result = readSteamFragment();
    if (result === "denied") {
      setSteamDenied(true);
      track("steam_sign_in_denied");
    }
    // The session cookie, not the URL, says who is signed in.
    void fetchRenter().then((renter) => {
      if (!renter) {
        // Signed out: lead with what people are actually playing on Steam that
        // Swiff can run. If Steam is down, the hand-authored nine the server
        // vouches for stand in; in the demo they are up until it arrives.
        void fetchPopular().then((popular) => {
          vouch(popular);
          const catalog = popular?.games ?? [];
          const accounts = new Map(popular?.wall.map((entry) => [entry.appid, entry]));
          const curated = GAMES.filter((g) => !vouched.current || vouched.current.has(g.appid)).map((g) => {
            const entry = accounts.get(g.appid);
            return entry ? { ...g, signIn: signInNote(entry) } : g;
          });
          if (!catalog.length && (demo || !popular)) return;
          const cards = catalog.length ? popularCards(catalog, sharedMachineIds) : curated;
          setGames((prev) => {
            const open = prev.find((g) => g.id === openGameId.current);
            return open && !cards.some((c) => c.id === open.id) ? [...cards, open] : cards;
          });
        });
        return;
      }
      const { profile } = renter;
      showLibrary(renter);
      // Counted once per sign-in, not on every page load of a signed-in renter.
      if (result === "ok") {
        track("library_matched", {
          owned_here: profile.owned.length,
          library_rendered: profile.games.length,
          library_size: profile.size,
        });
      }
    });
    // sharedMachineIds is stable for the seed pool; re-running on Moss freeing
    // would re-read a fragment that has already been cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Sign out, then start over on the signed-out wall; if it fails, say so and stay signed in. */
  const signOut = useCallback(() => {
    setSignOutFailed(false);
    void endSignIn(
      () => {
        track("steam_signed_out");
        window.location.assign("/");
      },
      () => setSignOutFailed(true),
    );
  }, []);

  // --- booking ---------------------------------------------------------------

  // The games as they stand, for a claim that comes in on a resumed booking.
  const gamesNow = useRef(games);
  gamesNow.current = games;
  // The booking being followed to its claim (booking.ts), and stopping that.
  const following = useRef<(() => void) | null>(null);
  // A queue request on its way, so a second click books nothing more.
  const queueing = useRef(false);
  const bookingNow = useRef(booking);
  bookingNow.current = booking;
  // The loss being carried on, as it stands; set at once, ahead of the render.
  const lostNow = useRef<Lost | null>(null);
  // Which launch is current, so one cancelled while its booking call was in
  // flight hands its machine back rather than claiming it.
  const launchRun = useRef(0);
  // The renter's measured round trip to the server, which bookings carry so
  // the server judges each machine's latency from where they are.
  const rttNow = useRef(live.rttMs);
  rttNow.current = live.rttMs;
  const rtts = () => (rttNow.current === null ? {} : { rtts: { server: rttNow.current } });
  // How the renter plays, which bookings carry so the server ranks machines as their list was.
  const prefsNow = useRef(prefs);
  prefsNow.current = prefs;

  const stopFollowing = useCallback(() => {
    following.current?.();
    following.current = null;
  }, []);

  /**
   * Follow the booking until the page claims its machine (booking.ts): at once
   * for a picked machine, on its match for a queued one. A claim puts the
   * launch up for the booking's game. A claim that fails or is refused says so;
   * for a `launched` booking (a picked machine) it also stops the launch and
   * hands the machine back.
   */
  const follow = useCallback(
    (first: Booking | string, launched = false) => {
      stopFollowing();
      const bookingId = typeof first === "string" ? first : first.bookingId;
      following.current = followBooking(first, {
        onUpdate: (next) => {
          setBooking(next);
          if (next?.status !== "queued") setQueueBack(false);
          // Over or gone from view, the booking is no longer followed: the queue can be joined again.
          if (!next || next.status === "ended" || next.status === "expired") following.current = null;
        },
        onClaimed: (claimed, next) => {
          following.current = null;
          track("booking_claimed", { game: next.gameId, machine: claimed.roomId });
          setBooking(next);
          setClaim(claimed);
          setBookingFailed(false);
          setRefusal(null);
          const claimedGame = gamesNow.current.find((g) => g.appid === next.gameId);
          if (claimedGame) setGameId(claimedGame.id);
          if (next.machine) setMachineId(next.machine.id);
          setScreen("game");
          setPhase((current) => (current === "idle" ? "connecting" : current));
        },
        onClaimFailed: (refused) => {
          setBookingFailed(true);
          setRefusal(refused ?? null);
          // A refused game is never going to be claimed: its machine goes back at once.
          if (!launched && !refused) return;
          stopFollowing();
          void endBooking(bookingId).catch(() => {});
          setBooking(null);
          setClaim(null);
          setPhase("idle");
          setBeat(0);
        },
      });
    },
    [stopFollowing],
  );

  // When the session first went live, for its clock; forgotten once it is over.
  const liveSince = useRef<number | null>(null);

  /** End the renter's booking, whatever it has come to, and stop following it. */
  const endCurrentBooking = useCallback(() => {
    launchRun.current += 1;
    liveSince.current = null;
    setElapsedMs(0);
    stopFollowing();
    setQueueBack(false);
    const current = bookingNow.current;
    if (current && current.status !== "ended" && current.status !== "expired") {
      void endBooking(current.bookingId).catch(() => {});
    }
    setBooking(null);
    setClaim(null);
    lostNow.current = null;
    setLost(null);
  }, [stopFollowing]);

  /** Book `machineId` for the open game and launch on it; the claim follows by itself. */
  const launchOn = useCallback(
    (machineId: string) => {
      if (!game) return;
      // A booking already waiting (in the queue) gives way to this one.
      endCurrentBooking();
      const run = ++launchRun.current;
      setTaken(null);
      setBookingFailed(false);
      setRefusal(null);
      setPhase("connecting");
      setLaunchedAt(Date.now());
      setBeat(0);
      const { controls, picture } = askOf(0, prefsNow.current);
      bookMachine(machineId, game.appid, sessionMinutes(session), { ...rtts(), controls, picture }).then(
        (result) => {
          if (run !== launchRun.current) {
            // Cancelled meanwhile: the machine goes back rather than to a renter who left.
            if (result.kind === "booked") void endBooking(result.booking.bookingId).catch(() => {});
            return;
          }
          if (result.kind === "taken") {
            track("machine_taken", { game: game.id, machine: machineId });
            setTaken({ nextBest: result.nextBest });
            setPhase("idle");
            setBeat(0);
            return;
          }
          setBooking(result.booking);
          follow(result.booking, true);
        },
        (error: unknown) => {
          if (run !== launchRun.current) return;
          setBookingFailed(true);
          setRefusal(error instanceof BookingRefused ? error.refusal : null);
          setPhase("idle");
          setBeat(0);
        },
      );
    },
    [game, session, follow, endCurrentBooking],
  );

  /** Queue for the open game: the server matches it, and the page claims the match by itself. */
  const joinQueue = useCallback(() => {
    // The demo's machines are invented: there is no queue to join for them.
    if (demo || !game || !signedIn || following.current || queueing.current) return;
    queueing.current = true;
    track("queue_joined", { game: game.id });
    setTaken(null);
    setBookingFailed(false);
    setRefusal(null);
    const { controls, picture } = askOf(0, prefsNow.current);
    book(game.appid, sessionMinutes(session), { ...rtts(), controls, picture })
      .then(
        (queued) => {
          setBooking(queued);
          follow(queued);
        },
        (error: unknown) => {
          setBookingFailed(true);
          setRefusal(error instanceof BookingRefused ? error.refusal : null);
        },
      )
      .finally(() => {
        queueing.current = false;
      });
  }, [demo, game, signedIn, session, follow]);

  /** Leave the queue, or hand back a machine matched and not yet claimed. */
  const leaveQueue = useCallback(() => {
    track("queue_left");
    endCurrentBooking();
  }, [endCurrentBooking]);

  // A renter who comes back within the server's two minutes picks up their
  // booking where it was, and a match waiting for them is claimed the moment
  // the page hears of it again.
  // Screen C says so while it is still queued; matched meanwhile, it is
  // claimed by itself instead.
  useEffect(() => {
    if (!steamId || demo) return;
    const stored = storedBookingId();
    if (!stored || following.current) return;
    setQueueBack(true);
    follow(stored);
  }, [steamId, demo, follow]);

  // A session this browser was playing when the page went away (closed, a
  // reload, a laptop that died) may still run on the PC, which holds it for
  // two minutes once it misses the renter: screen A offers to go back to it.
  // One another open page of this browser still plays is that page's, and is
  // not offered: going back to it would take its seat.
  useEffect(() => {
    if (!steamId || demo) return;
    const stored = storedPlay();
    if (!stored) return;
    let current = true;
    Promise.all([fetchBooking(stored.bookingId), playedElsewhere(stored.sessionId)]).then(
      ([found, elsewhere]) => {
        if (!current || elsewhere) return;
        if (found && (found.status === "claimed" || found.status === "playing")) {
          setAway({ booking: found, heldUntil: found.heldUntil ?? null });
        } else forgetPlay(stored.bookingId);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [steamId, demo]);

  useEffect(() => stopFollowing, [stopFollowing]);

  // A play that comes back to a session already on screen before: no Ignition.
  // When its connection dropped, if the PC said.
  const resumeNext = useRef<{ droppedAt?: number } | null>(null);

  /**
   * Go back to the session the page left (screen A): its seat again, then
   * straight to the game, reconnecting, when it was playing, or through
   * Ignition when it had not got that far. One that is over by now is let go.
   */
  const reconnect = useCallback(() => {
    const current = away;
    if (!current || rejoining) return;
    const { booking: was, heldUntil } = current;
    setRejoining(true);
    track("session_rejoined", { game: was.gameId });
    // Another page that took the session up meanwhile keeps it.
    const seat = async () =>
      was.sessionId && (await playedElsewhere(was.sessionId)) ? null : resumeTicket(was.bookingId);
    seat().then(
      (claimed) => {
        setRejoining(false);
        setAway(null);
        if (!claimed) return;
        const resumed = was.status === "playing";
        resumeNext.current = resumed
          ? { droppedAt: heldUntil === null ? undefined : heldUntil - RECONNECT_GRACE_MS }
          : null;
        // Its clock runs on from when the session started, not from now.
        if (resumed && was.startedAt !== undefined) liveSince.current = was.startedAt;
        setBooking(was);
        setClaim(claimed);
        const claimedGame = gamesNow.current.find((g) => g.appid === was.gameId);
        if (claimedGame) setGameId(claimedGame.id);
        if (was.machine) setMachineId(was.machine.id);
        setScreen("game");
        setLaunchedAt(Date.now());
        setPhase(resumed ? "live" : "connecting");
      },
      () => setRejoining(false),
    );
  }, [away, rejoining]);

  /** Let the session the page left go (screen A): it ends now, rather than when the PC stops holding it. */
  const endAway = useCallback(() => {
    const current = away;
    if (!current) return;
    track("session_ended", { away: true });
    setAway(null);
    void endBooking(current.booking.bookingId).catch(() => {});
  }, [away]);

  /** Keep waiting in the queue (screen C). */
  const keepQueue = useCallback(() => setQueueBack(false), []);

  // No join ticket stays on disk, even one kept before tickets stopped being stored.
  useEffect(() => forgetStoredTicket(), []);

  // --- timers ----------------------------------------------------------------

  useEffect(() => {
    if (!demo) return;
    const timer = window.setTimeout(() => setMossFree(true), MOSS_FREES_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [demo]);

  // --- a machine frees up ----------------------------------------------------

  // Games that just became playable: they pulse on the wall, and with sounds
  // on, the chime plays. Only a game that was known to have nothing ready and
  // now has something counts; the first answer is not news.
  // A different session length or setting changes what is ready without any
  // machine freeing, so counts are only compared with counts for the same question.
  const [freed, setFreed] = useState<ReadonlySet<string>>(() => new Set());
  const question = demo ? questionOf(sessionMinutes(session), prefs) : (live.wall?.question ?? "");
  const readyBefore = useRef({ question, ready: new Map<string, number>() });
  const soundOn = useRef(sound);
  soundOn.current = sound;
  useEffect(() => {
    const before = readyBefore.current;
    const now = new Map([...spots].map(([id, spot]) => [id, spot.ready]));
    readyBefore.current = { question, ready: now };
    if (before.question !== question) return;
    const ids = [...now].filter(([id, ready]) => ready > 0 && before.ready.get(id) === 0).map(([id]) => id);
    if (!ids.length) return;
    setFreed(new Set(ids));
    if (soundOn.current) chime();
    track("machine_freed", { games: ids.length });
  }, [spots, question]);

  useEffect(() => {
    if (!freed.size) return;
    const timer = window.setTimeout(() => setFreed(new Set()), FREED_MS);
    return () => window.clearTimeout(timer);
  }, [freed]);

  // The demo's machines are invented, so its launch plays out on beats alone.
  useEffect(() => {
    if (!demo || phase !== "connecting") return;
    const timer = window.setInterval(() => setBeat((b) => b + 1), IGNITION_MS);
    return () => window.clearInterval(timer);
  }, [demo, phase]);

  useEffect(() => {
    if (!demo || phase !== "connecting" || beat < IGNITION_BEATS) return;
    track("session_started", { game: gameId, machine: machineId });
    setPhase("live");
    setElapsedMs(0);
  }, [demo, phase, beat, gameId, machineId]);

  // --- real play -------------------------------------------------------------

  // The claimed room is joined once its video is on the page, and left when
  // the claim goes (the booking ended, or the page closed).
  const playNow = useRef<Play | null>(null);
  const funnel = useRef({ gameId, machineId });
  funnel.current = { gameId, machineId };
  useEffect(() => {
    if (demo || !claim || !video) return;
    const resume = resumeNext.current;
    resumeNext.current = null;
    const current = startPlay({
      claim,
      video,
      resume: resume !== null,
      droppedAt: resume?.droppedAt,
      onChange: setPlay,
      // The funnel counts a session from its first frame.
      onFirstFrame: () =>
        track("session_started", { game: funnel.current.gameId, machine: funnel.current.machineId }),
    });
    playNow.current = current;
    return () => {
      current.stop();
      if (playNow.current === current) playNow.current = null;
      setPlay(null);
    };
  }, [demo, claim, video]);

  // While this page plays a session, no other page of this browser offers to go back to it.
  const playingSession = claim?.sessionId ?? null;
  useEffect(() => (playingSession ? holdPlay(playingSession) : undefined), [playingSession]);

  /** Reconnect now, after the page gave up reconnecting by itself (screen B). */
  const retryConnection = useCallback(() => {
    track("session_reconnect_retried");
    playNow.current?.retry();
  }, []);

  // Live once the game is on screen; back behind Ignition when the PC leaves
  // mid-session, until its new connection shows the game again. The session
  // clock runs from the first time it went live.
  useEffect(() => {
    if (!play) return;
    if (phase === "connecting" && play.step === "live") setPhase("live");
    if (phase === "live" && play.step !== "live") setPhase("connecting");
  }, [phase, play]);

  useEffect(() => {
    if (demo || phase !== "connecting") return;
    const timer = window.setInterval(() => setIgnitionNow(Date.now()), IGNITION_TICK_MS);
    return () => window.clearInterval(timer);
  }, [demo, phase]);

  useEffect(() => {
    if (phase === "idle") liveSince.current = null;
  }, [phase]);
  useEffect(() => {
    if (phase !== "live") return;
    const started = (liveSince.current ??= Date.now());
    setElapsedMs(Date.now() - started);
    const timer = window.setInterval(() => setElapsedMs(Date.now() - started), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  // --- navigation ------------------------------------------------------------

  // Only Share your PC changes the address: /share while it is up, / once it
  // is left, so Back and Forward move between it and the wall.
  useEffect(() => {
    const path = pathOf(screen);
    if (screenAt(location.pathname) !== screenAt(path)) history.pushState(null, "", path + location.search);
    if (screen !== "share") setEstimateOpen(false);
  }, [screen]);

  // While Ignition or a session covers the page, Back and Forward leave the
  // screen behind it alone and put its address back.
  // Once the server took the session start, or it went live, leaving ends a session.
  const covered = useRef({ screen, phase, started: false });
  covered.current = { screen, phase, started: Boolean(play?.started) || phase === "live" };
  useEffect(() => {
    const onPop = () => {
      const { screen, phase } = covered.current;
      if (phase === "idle") setScreen(screenAt(location.pathname));
      else if (screenAt(location.pathname) !== screenAt(pathOf(screen)))
        history.pushState(null, "", pathOf(screen) + location.search);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openShare = useCallback(() => {
    track("share_opened");
    setScreen("share");
  }, []);

  const elapsedNow = useRef(elapsedMs);
  elapsedNow.current = elapsedMs;
  const endSession = useCallback(() => {
    track("session_ended", { seconds: Math.round(elapsedNow.current / 1000) });
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    // The server hears it: the session ends as the renter's, and the PC is told.
    endCurrentBooking();
    setPhase("idle");
    setBeat(0);
  }, [endCurrentBooking]);

  const goHome = useCallback(() => {
    // Leaving a launch or a session ends its booking; a queued one waits on.
    if (covered.current.started) endSession();
    else if (covered.current.phase !== "idle") endCurrentBooking();
    setScreen("home");
    setPhase("idle");
    setBeat(0);
  }, [endSession, endCurrentBooking]);

  const openGame = useCallback(
    (next: Game) => {
      track("game_opened", { game: next.id });
      setGameId(next.id);
      // rank() puts machines free all session first, so the first free one is
      // the best. Real hosts are not read yet; the effect below picks once they are.
      setMachineId(demo ? (machinesFor(next, pool, session, prefs).find((m) => !m.busy)?.id ?? null) : null);
      setTaken(null);
      setBookingFailed(false);
      setRefusal(null);
      setScreen("game");
      setPhase("idle");
      setBeat(0);
    },
    [demo, pool, session, prefs],
  );

  // The chosen machine was taken, or none is chosen yet: choose the best free
  // one, as opening the game does. A launch under way keeps its machine.
  useEffect(() => {
    if (screen !== "game" || phase !== "idle") return;
    if (machines.some((m) => m.id === machineId && !m.busy)) return;
    setMachineId(machines.find((m) => !m.busy)?.id ?? null);
  }, [screen, phase, machines, machineId]);

  const launch = useCallback(() => {
    // Playing needs a signed-in renter: the server books for nobody else.
    if (!picked || !signedIn) return;
    track("launch_confirmed", { game: gameId, machine: picked.id });
    if (demo) {
      // The demo's machines are invented: the launch plays out on the page alone.
      setPhase("connecting");
      setBeat(0);
      return;
    }
    launchOn(picked.id);
  }, [demo, picked, gameId, signedIn, launchOn]);

  /** Launch on the machine the server offered in place of one that was taken. */
  const launchNextBest = useCallback(() => {
    const next = taken?.nextBest;
    if (!next || !signedIn) return;
    track("launch_confirmed", { game: gameId, machine: next.id, nextBest: true });
    setMachineId(next.id);
    launchOn(next.id);
  }, [taken, gameId, signedIn, launchOn]);

  /**
   * Ignition is taking longer than usual: give this machine back and launch on
   * the best other one free, or, with none, go back to the game's machines.
   * A session already started on it ends as End ends it.
   */
  const tryAnother = useCallback(() => {
    const next = machines.find((m) => !m.busy && m.id !== machineId);
    track("machine_switched", { machine: next?.id ?? null, slow: true });
    if (covered.current.started) endSession();
    else endCurrentBooking();
    if (next && signedIn) {
      setMachineId(next.id);
      launchOn(next.id);
      return;
    }
    setPhase("idle");
    setBeat(0);
  }, [machines, machineId, signedIn, endSession, endCurrentBooking, launchOn]);

  // --- machine lost ----------------------------------------------------------

  /**
   * The session's machine was lost (it went offline, or its owner took it
   * back): carry it on elsewhere at once, with nothing to press. The stream
   * is let go, and the server makes a booking for the time left (continue),
   * matched to the best other machine with the game, which is claimed by
   * itself and goes through Ignition there, or queued for one, claimed the
   * moment it is matched. Heard of once per booking.
   */
  const carryOn = useCallback(
    (was: Booking) => {
      if (lostNow.current?.booking.bookingId === was.bookingId) return;
      launchRun.current += 1;
      stopFollowing();
      const taken = was.endReason === "owner_kill";
      const host = was.machine?.name || "your machine";
      track("machine_lost", { game: was.gameId, reason: was.endReason });
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
      const entered: Lost = { booking: was, host, taken, at: Date.now(), next: null, failed: false };
      lostNow.current = entered;
      setLost(entered);
      setBooking(null);
      setClaim(null);
      setTaken(null);
      setBookingFailed(false);
      setScreen("game");
      setPhase("idle");
      setBeat(0);
      /** Settle this loss with what the server answered, unless it was stopped meanwhile; false then. */
      const settle = (patch: Partial<Lost>) => {
        if (lostNow.current !== entered) return false;
        lostNow.current = { ...entered, ...patch };
        setLost(lostNow.current);
        return true;
      };
      continueBooking(was.bookingId).then(
        (next) => {
          if (!next) return void settle({ failed: true });
          if (!settle({ next })) {
            // Stopped meanwhile: the machine goes back rather than to a renter who left.
            void endBooking(next.bookingId).catch(() => {});
            return;
          }
          track("session_continued", { game: next.gameId, queued: next.status === "queued" });
          setBooking(next);
          if (next.machine) setMachineId(next.machine.id);
          setLaunchedAt(Date.now());
          follow(next, next.status === "matched");
        },
        () => void settle({ failed: true }),
      );
    },
    [stopFollowing, follow],
  );
  const carryOnNow = useRef(carryOn);
  carryOnNow.current = carryOn;

  // A running session's booking is followed on to its end, so a machine lost
  // mid-session is heard of the moment the server gives up on it, whether the
  // stream is still trying to reconnect or has left that to the renter.
  const runningId = !demo && claim ? (booking?.bookingId ?? null) : null;
  useEffect(() => {
    if (!runningId) return;
    return watchBooking(
      runningId,
      (next) => {
        if (next && machineLost(next)) carryOnNow.current(next);
      },
      { toEnd: true },
    );
  }, [runningId]);

  // Refused at the door, the ticket opens nothing. The server says why: a
  // machine lost is carried on elsewhere. Otherwise, before the session
  // started the launch failed; once it has, even behind Ignition after the PC
  // dropped, the server ended the session (its time ran out, or the PC ended
  // it), which is a session end like End. A loss already being carried on was
  // heard first: the ticket refused is the lost session's, and ends nothing.
  useEffect(() => {
    if (!play?.denied) return;
    const ended = () => {
      if (lostNow.current) return;
      if (covered.current.started) return endSession();
      endCurrentBooking();
      setBookingFailed(true);
      setPhase("idle");
    };
    const current = bookingNow.current;
    if (!current) return ended();
    let asking = true;
    fetchBooking(current.bookingId).then(
      (found) => {
        if (!asking) return;
        if (found && machineLost(found)) carryOnNow.current(found);
        else ended();
      },
      () => asking && ended(),
    );
    return () => {
      asking = false;
    };
  }, [play?.denied, endCurrentBooking, endSession]);

  // Another page of this renter's took the session's seat: it plays on there,
  // so this page lets it go without ending it.
  useEffect(() => {
    if (!play?.replaced) return;
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    launchRun.current += 1;
    liveSince.current = null;
    stopFollowing();
    setBooking(null);
    setClaim(null);
    setElapsedMs(0);
    setPhase("idle");
    setBeat(0);
  }, [play?.replaced, stopFollowing]);

  /** Stop for now, rather than carry the lost session on: the booking carrying it on ends too. */
  const stopLost = useCallback(() => {
    track("machine_lost_stopped");
    endCurrentBooking();
    setPhase("idle");
    setBeat(0);
  }, [endCurrentBooking]);

  /** No machine to carry the lost session on: back to the game's machines, to choose one. */
  const chooseMachine = useCallback(() => {
    endCurrentBooking();
    setBookingFailed(false);
  }, [endCurrentBooking]);

  // Once the game is on screen again, the loss is behind the renter.
  useEffect(() => {
    if (phase === "live") setLost(null);
  }, [phase]);

  const cycleSession = useCallback(
    () =>
      setSession((current) => (current === "quick" ? "evening" : current === "evening" ? "night" : "quick")),
    [],
  );

  const toggleDevice = useCallback(
    (id: Device) =>
      setDevices((current) => (current.includes(id) ? current.filter((d) => d !== id) : [...current, id])),
    [],
  );

  /** Move the machine selection, for arrow keys and the d-pad. */
  const moveSelection = useRef<(step: number) => void>(() => {});
  moveSelection.current = (step) => {
    const free = machines.filter((m) => !m.busy);
    const at = free.findIndex((m) => m.id === machineId);
    const next = Math.max(0, Math.min(free.length - 1, at + step));
    if (next !== at && free[next]) setMachineId(free[next]!.id);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // In a session, every key is the game's, behind Ignition too after the
      // PC dropped: End is the way out.
      if (covered.current.started) return;
      if (event.key === "Escape") {
        // An open sheet closes first; the next Escape goes home.
        if (estimateOpen) setEstimateOpen(false);
        else goHome();
        return;
      }
      if (screen !== "game" || phase !== "idle") return;
      if (event.key === "ArrowRight") moveSelection.current(1);
      if (event.key === "ArrowLeft") moveSelection.current(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, phase, goHome, estimateOpen]);

  // A gamepad is the point of a couch product, so d-pad left/right selects a
  // machine and B goes back. Edge-triggered: a held stick must not scroll away.
  useEffect(() => {
    if (!navigator.getGamepads) return;
    let previous = { left: false, right: false, back: false };
    const timer = window.setInterval(() => {
      const pad = Array.from(navigator.getGamepads()).find(Boolean);
      if (!pad) return;
      const axis = pad.axes[0] ?? 0;
      const now = {
        left: Boolean(pad.buttons[14]?.pressed) || axis < -0.6,
        right: Boolean(pad.buttons[15]?.pressed) || axis > 0.6,
        back: Boolean(pad.buttons[1]?.pressed),
      };
      if (now.left && !previous.left) moveSelection.current(-1);
      if (now.right && !previous.right) moveSelection.current(1);
      // In a session, B is the game's, behind Ignition too.
      if (now.back && !previous.back && !covered.current.started) goHome();
      previous = now;
    }, 90);
    return () => window.clearInterval(timer);
  }, [goHome]);

  // Ignition: the demo's beats, or where the real launch stands on its connection.
  // A machine carried on to may not be on the list the game's page last read.
  const labels = ignitionLabels(picked?.name ?? booking?.machine?.name, game?.title);
  let ignition: { ignitionSteps: string[]; ignitionIndex: number; progress: number; slow: boolean };
  if (demo) {
    ignition = {
      ignitionSteps: labels,
      ignitionIndex: Math.min(labels.length - 1, Math.floor(beat / 3)),
      progress: Math.min(1, beat / IGNITION_BEATS),
      slow: false,
    };
  } else {
    const step = !play ? "reserving" : play.step === "live" ? "launching" : play.step;
    ignition = {
      ignitionSteps: labels,
      ignitionIndex: IGNITION_STEPS.indexOf(step),
      progress: play?.step === "live" ? 1 : ignitionProgress(step, ignitionNow - (play?.since ?? launchedAt)),
      slow: play?.slow ?? false,
    };
  }

  // The live count in the top bar; signed out there is none.
  let liveLine: string | undefined;
  if (seesAvailability) {
    if (screen === "game") {
      if (!machinesLoading) liveLine = `${machines.filter((m) => !m.busy).length} free for this game`;
    } else if (demo) {
      liveLine = `${Object.values(pool).filter((m) => !m.busy && !m.self).length} free near you`;
    } else if (spots.size) {
      const ready = games.filter((g) => readyFor(spots, g) > 0).length;
      liveLine = `${ready} ${ready === 1 ? "game" : "games"} ready now`;
    }
  }

  return {
    demo,
    screen,
    phase,
    booking,
    claim,
    play,
    taken,
    bookingFailed,
    refusal,
    away,
    rejoining,
    queueBack,
    games,
    game,
    machines,
    machinesLoading,
    reason: why,
    picked,
    pool,
    spots,
    freed,
    clock,
    seesAvailability,
    liveLine,
    session,
    prefs,
    hoverId,
    signedIn,
    steamId,
    steamDenied,
    signOutFailed,
    profile,
    libraryRetrying,
    motion,
    sound,
    quality,
    devices,
    showAll,
    ...ignition,
    elapsedMs,
    lost,
    week,
    estimateOpen,
    goHome,
    openShare,
    setWeek,
    setEstimateOpen,
    openGame,
    launch,
    launchNextBest,
    joinQueue,
    leaveQueue,
    reconnect,
    endAway,
    keepQueue,
    retryConnection,
    endSession,
    tryAnother,
    attachVideo: setVideo,
    stopLost,
    chooseMachine,
    cycleSession,
    toggleDevice,
    setHoverId,
    setMachineId,
    setScreen,
    setMotion,
    setSound,
    setQuality,
    setShowAll,
    signOut,
    retryLibrary,
  };
}

export type Swiff = ReturnType<typeof useSwiff>;
