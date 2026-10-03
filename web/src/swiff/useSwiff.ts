import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import posthog, { isPostHogEnabled } from "../posthog";
import {
  bookMachine,
  book,
  endBooking,
  followBooking,
  storedBookingId,
  type Booking,
  type Claim,
  type NextBest,
} from "./booking";
import { chime } from "./chime";
import {
  GAMES,
  IGNITION_STEPS,
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
import { questionOf, useLive } from "./useLive";
import { pathOf, screenAt } from "./route";
import { fetchMedia, fetchPopular } from "./catalog";
import {
  applySteam,
  endSignIn,
  fetchRenter,
  nextCatalog,
  popularCards,
  readSteamFragment,
  refreshRenter,
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

/** One 340 ms beat of the ignition sequence; twelve of them reach a frame. */
const IGNITION_MS = 340;
const IGNITION_BEATS = 12;

/** Moss comes back mid-session, so the demo wall can show a machine freeing up. */
const MOSS_FREES_AFTER_MS = 12_000;

/** How long a game that just became playable pulses on the wall. */
const FREED_MS = 2_400;

/** The real clock is read this often; its minutes are all the page shows. */
const CLOCK_MS = 15_000;

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

  const [games, setGames] = useState<Game[]>(GAMES);
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
  const [ownerDropped, setOwnerDropped] = useState(false);

  // The renter's booking on the server, the room and ticket its claim handed
  // out, a picked machine that was taken first, and a booking call that failed.
  const [booking, setBooking] = useState<Booking | null>(null);
  const [claim, setClaim] = useState<Claim | null>(null);
  const [taken, setTaken] = useState<Taken | null>(null);
  const [bookingFailed, setBookingFailed] = useState(false);

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
  /** The open game's best machines are being probed for their real latency. */
  const measuring = !demo && game !== null && live.measuring === game.appid;
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
      const library = applySteam(next, sharedMachineIds, kept);
      setGames(withMedia(library, kept));
      const curated = GAMES.map((g) => g.appid);
      void Promise.all([fetchMedia([...library.map((g) => g.appid), ...curated]), fetchPopular()]).then(
        ([media, popular]) => {
          if (load !== libraryLoad.current) return;
          lastCatalog.current = nextCatalog(lastCatalog.current, media, popular);
          const catalog = storeGames(lastCatalog.current);
          setGames(withMedia(applySteam(next, sharedMachineIds, catalog), catalog));
        },
      );
    },
    [sharedMachineIds],
  );

  /** Read the renter's library from Steam again, after they have made it public. */
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
        // Signed out: lead with what people are actually playing on Steam. Until
        // it arrives, or if Steam is down, the hand-authored nine stay up.
        void fetchPopular().then((catalog) => {
          if (!catalog.length) return;
          const cards = popularCards(catalog, sharedMachineIds);
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
          // Over or gone from view, the booking is no longer followed: the queue can be joined again.
          if (!next || next.status === "ended" || next.status === "expired") following.current = null;
        },
        onClaimed: (claimed, next) => {
          following.current = null;
          track("booking_claimed", { game: next.gameId, machine: claimed.roomId });
          setBooking(next);
          setClaim(claimed);
          setBookingFailed(false);
          const claimedGame = gamesNow.current.find((g) => g.appid === next.gameId);
          if (claimedGame) setGameId(claimedGame.id);
          setScreen("game");
          setPhase((current) => (current === "idle" ? "connecting" : current));
        },
        onClaimFailed: () => {
          setBookingFailed(true);
          if (!launched) return;
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

  /** End the renter's booking, whatever it has come to, and stop following it. */
  const endCurrentBooking = useCallback(() => {
    launchRun.current += 1;
    stopFollowing();
    const current = bookingNow.current;
    if (current && current.status !== "ended" && current.status !== "expired") {
      void endBooking(current.bookingId).catch(() => {});
    }
    setBooking(null);
    setClaim(null);
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
      setPhase("connecting");
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
        () => {
          if (run !== launchRun.current) return;
          setBookingFailed(true);
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
    const { controls, picture } = askOf(0, prefsNow.current);
    book(game.appid, sessionMinutes(session), { ...rtts(), controls, picture })
      .then(
        (queued) => {
          setBooking(queued);
          follow(queued);
        },
        () => setBookingFailed(true),
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
  useEffect(() => {
    if (!steamId || demo) return;
    const stored = storedBookingId();
    if (stored && !following.current) follow(stored);
  }, [steamId, demo, follow]);

  useEffect(() => stopFollowing, [stopFollowing]);

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

  useEffect(() => {
    if (phase !== "connecting") return;
    const timer = window.setInterval(() => setBeat((b) => b + 1), IGNITION_MS);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "connecting" || beat < IGNITION_BEATS) return;
    track("session_started", { game: gameId, machine: machineId });
    setPhase("live");
    setElapsedMs(0);
  }, [phase, beat, gameId, machineId]);

  useEffect(() => {
    if (phase !== "live") return;
    const started = Date.now();
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
  const covered = useRef({ screen, phase });
  covered.current = { screen, phase };
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

  const goHome = useCallback(() => {
    // Leaving a launch or a session ends its booking; a queued one waits on.
    if (covered.current.phase !== "idle") endCurrentBooking();
    setScreen("home");
    setPhase("idle");
    setBeat(0);
  }, [endCurrentBooking]);

  const openGame = useCallback(
    (next: Game) => {
      track("game_opened", { game: next.id });
      setGameId(next.id);
      // rank() puts machines free all session first, so the first free one is
      // the best. Real hosts are not read yet; the effect below picks once they are.
      setMachineId(demo ? (machinesFor(next, pool, session, prefs).find((m) => !m.busy)?.id ?? null) : null);
      setTaken(null);
      setBookingFailed(false);
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

  const endSession = useCallback(() => {
    track("session_ended", { seconds: Math.round(elapsedMs / 1000) });
    // The server hears it: the session ends as the renter's, and the PC is told.
    endCurrentBooking();
    setPhase("idle");
    setBeat(0);
    setOwnerDropped(false);
  }, [elapsedMs, endCurrentBooking]);

  /**
   * The owner took their machine back mid-session. Nothing drives this yet: the
   * trigger is the host's `peer-left` on the signaling socket, which arrives
   * when the wall is wired to @swiff/rtc. Kept here so the recovery path is one
   * call away rather than a screen that has to be rebuilt then.
   */
  const reportOwnerDropped = useCallback(() => setOwnerDropped(true), []);

  const switchMachine = useCallback((id: string) => {
    track("machine_switched", { machine: id });
    setMachineId(id);
    setOwnerDropped(false);
    setPhase("connecting");
    setBeat(0);
  }, []);

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
      if (now.back && !previous.back) goHome();
      previous = now;
    }, 90);
    return () => window.clearInterval(timer);
  }, [goHome]);

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
    taken,
    bookingFailed,
    games,
    game,
    machines,
    machinesLoading,
    measuring,
    /** The renter's round trips, to the server and straight to each machine measured, for a booking. */
    rtts: live.rtts,
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
    /** 0 to 1 through the ignition sequence. */
    progress: Math.min(1, beat / IGNITION_BEATS),
    ignitionStep: IGNITION_STEPS[Math.min(IGNITION_STEPS.length - 1, Math.floor(beat / 3))]!,
    elapsedMs,
    ownerDropped,
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
    endSession,
    reportOwnerDropped,
    switchMachine,
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
