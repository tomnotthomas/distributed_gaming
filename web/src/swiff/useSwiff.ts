import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import posthog, { isPostHogEnabled } from "../posthog";
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
import {
  clockMinutes,
  machinesFor,
  NOW_MINUTES,
  readyFor,
  reason,
  seedSpots,
  sessionMinutes,
} from "./derive";
import { DEFAULT_WEEK, type Week } from "./estimate";
import { machinesOf, spotOf } from "./live";
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

/** Minutes since midnight: pinned to 20:00 in the demo, else the real clock, kept current. */
function useClock(demo: boolean): number {
  const [now, setNow] = useState(() => (demo ? NOW_MINUTES : clockMinutes()));
  useEffect(() => {
    if (demo) return;
    const timer = window.setInterval(() => setNow(clockMinutes()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, [demo]);
  return demo ? NOW_MINUTES : now;
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
    () => machines.find((m) => m.id === machineId && !m.busy) ?? null,
    [machines, machineId],
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
    setScreen("home");
    setPhase("idle");
    setBeat(0);
  }, []);

  const openGame = useCallback(
    (next: Game) => {
      track("game_opened", { game: next.id });
      setGameId(next.id);
      // rank() puts machines free all session first, so the first free one is
      // the best. Real hosts are not read yet; the effect below picks once they are.
      setMachineId(demo ? (machinesFor(next, pool, session, prefs).find((m) => !m.busy)?.id ?? null) : null);
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
    setPhase("connecting");
    setBeat(0);
  }, [picked, gameId, signedIn]);

  const endSession = useCallback(() => {
    track("session_ended", { seconds: Math.round(elapsedMs / 1000) });
    setPhase("idle");
    setBeat(0);
    setOwnerDropped(false);
  }, [elapsedMs]);

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
