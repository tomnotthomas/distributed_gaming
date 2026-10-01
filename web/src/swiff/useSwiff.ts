import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import posthog, { isPostHogEnabled } from "../posthog";
import { GAMES, IGNITION_STEPS, MACHINES, type Game, type Machine, type SessionLength } from "./data";
import { closeCall, freeFor, machinesFor } from "./derive";
import { fetchMedia, fetchPopular } from "./catalog";
import {
  applySteam,
  endSignIn,
  fetchRenter,
  popularCards,
  readSteamFragment,
  refreshRenter,
  withMedia,
  type SteamProfile,
} from "./steam";

export type Screen = "home" | "game" | "profile";
export type Phase = "idle" | "connecting" | "live";
export type Quality = "auto" | "fps" | "resolution";
export type Device = "kb" | "mouse" | "pad";

/** One 340 ms beat of the ignition sequence; twelve of them reach a frame. */
const IGNITION_MS = 340;
const IGNITION_BEATS = 12;

/** Moss comes back mid-session, so the wall can show a machine freeing up. */
const MOSS_FREES_AFTER_MS = 12_000;

const track = (event: string, props?: Record<string, unknown>) => {
  if (isPostHogEnabled) posthog.capture(event, props);
};

export function useSwiff() {
  const [screen, setScreen] = useState<Screen>("home");
  const [phase, setPhase] = useState<Phase>("idle");
  const [gameId, setGameId] = useState<string | null>(null);
  const [machineId, setMachineId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [machinesOpen, setMachinesOpen] = useState(true);

  const [games, setGames] = useState<Game[]>(GAMES);
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

  // Moss is busy in the seed data; freeing it later is the only mutation, so the
  // pool stays derived rather than kept in state.
  const pool = useMemo<Record<string, Machine>>(
    () => (mossFree ? { ...MACHINES, moss: { ...MACHINES.moss!, busy: false } } : MACHINES),
    [mossFree],
  );

  const sharedMachineIds = useMemo(
    () =>
      Object.values(pool)
        .filter((m) => !m.self)
        .map((m) => m.id),
    [pool],
  );

  const prefs = useMemo(() => ({ quality, devices }), [quality, devices]);

  const game = useMemo(() => games.find((g) => g.id === gameId) ?? null, [games, gameId]);
  const machines = useMemo(
    () => (game ? machinesFor(game, pool, session, prefs) : []),
    [game, pool, session, prefs],
  );
  const picked = useMemo(() => machines.find((m) => m.id === machineId) ?? null, [machines, machineId]);

  const libraryConnected = profile !== null;

  // --- Steam sign-in ---------------------------------------------------------

  // The game open right now, so a late catalog answer never swaps it out from
  // under the player.
  const openGameId = useRef(gameId);
  openGameId.current = gameId;

  // Which showLibrary call is current, so a slow catalog answer for a profile a
  // retry has since replaced never puts the old wall back.
  const libraryLoad = useRef(0);
  /**
   * Put a signed-in renter's wall up: their own games at once, then, once
   * Steam's store data says which games are free to play, those too, with
   * every card's real art and trailers.
   */
  const showLibrary = useCallback(
    (next: SteamProfile) => {
      const load = ++libraryLoad.current;
      setProfile(next);
      const library = applySteam(next, sharedMachineIds);
      setGames(library);
      const curated = GAMES.map((g) => g.appid);
      void Promise.all([fetchMedia([...library.map((g) => g.appid), ...curated]), fetchPopular()]).then(
        ([media, popular]) => {
          if (load !== libraryLoad.current) return;
          const catalog = [...media, ...popular];
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
      if (renter) showLibrary(renter.profile);
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
      showLibrary(profile);
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
    const timer = window.setTimeout(() => setMossFree(true), MOSS_FREES_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);

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

  const goHome = useCallback(() => {
    setScreen("home");
    setPhase("idle");
    setBeat(0);
  }, []);

  const openGame = useCallback(
    (next: Game) => {
      track("game_opened", { game: next.id });
      const free = freeFor(next, pool, session, prefs);
      const best = free[0] ?? machinesFor(next, pool, session, prefs).find((m) => !m.busy);
      setGameId(next.id);
      setMachineId(best?.id ?? null);
      setScreen("game");
      setPhase("idle");
      setBeat(0);
      // Fold the selector away unless the top two are close enough that the
      // choice is genuinely the player's.
      setMachinesOpen(closeCall(free));
    },
    [pool, session, prefs],
  );

  const launch = useCallback(() => {
    if (!picked) return;
    track("launch_confirmed", { game: gameId, machine: picked.id });
    setPhase("connecting");
    setBeat(0);
  }, [picked, gameId]);

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
        goHome();
        return;
      }
      if (screen !== "game" || phase !== "idle") return;
      if (event.key === "ArrowRight") moveSelection.current(1);
      if (event.key === "ArrowLeft") moveSelection.current(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, phase, goHome]);

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

  return {
    screen,
    phase,
    games,
    game,
    machines,
    picked,
    pool,
    session,
    prefs,
    hoverId,
    machinesOpen,
    libraryConnected,
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
    goHome,
    openGame,
    launch,
    endSession,
    reportOwnerDropped,
    switchMachine,
    cycleSession,
    toggleDevice,
    setHoverId,
    setMachineId,
    setMachinesOpen,
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
