import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS, demoNow, seedSpots, wallOrder } from "./derive";
import { GAMES, MACHINES, type Game, type SeedMachine, type Spot } from "./data";
import { applySteam, type CatalogGame, type SteamProfile } from "./steam";
import type { Swiff } from "./useSwiff";
import { ScreenLang } from "./screenCopy";
import { Wall } from "./Wall";
import { setPaidGaming } from "../test/features";

const noop = () => {};
const pool = ["glass", "ember", "tide", "moss"];

/**
 * Just the slice of the hook the wall reads, on the demo machines (`pool`) at
 * the demo's 20:00, or with `spots` given, on whatever those say.
 */
function swiffWith(
  games: Game[],
  profile: SteamProfile | null,
  retryLibrary = noop,
  motion = true,
  {
    pool = MACHINES,
    spots,
    clock = demoNow(),
    freed = [],
  }: { pool?: Record<string, SeedMachine>; spots?: Map<string, Spot>; clock?: number; freed?: string[] } = {},
): Swiff {
  return {
    motion,
    games,
    profile,
    signedIn: profile !== null,
    libraryRetrying: false,
    retryLibrary,
    spots: spots ?? seedSpots(games, pool, "evening", DEFAULT_PREFS),
    freed: new Set(freed),
    clock,
    showAll: true,
    hoverId: null,
    steamDenied: false,
    openGame: noop,
    setHoverId: noop,
    setShowAll: noop,
    crewLive: [],
    watch: noop,
  } as unknown as Swiff;
}

const privateLibrary: SteamProfile = {
  id: "0001",
  persona: "kai_nx",
  avatar: "",
  hours: 0,
  size: 0,
  owned: [],
  games: [],
  lib: false,
};

const cs2: CatalogGame = {
  appid: 730,
  name: "Counter-Strike 2",
  free: true,
  art: { hero: null, capsule: null },
  preview: null,
  trailer: null,
};

/**
 * jsdom has no media queries: answer every one as not matching, except `reduce`
 * when asked. The returned function flips `reduce` and tells the listeners.
 */
function mediaQueries({ reduce = false } = {}) {
  const listeners = new Set<() => void>();
  window.matchMedia = ((query: string) => ({
    get matches() {
      return reduce && query.includes("prefers-reduced-motion: reduce");
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  })) as unknown as typeof window.matchMedia;
  return (next: boolean) => {
    reduce = next;
    listeners.forEach((fn) => fn());
  };
}

/** The hero's game title. */
const heroTitle = () => screen.getByRole("heading", { level: 1 }).textContent;

describe("Wall", () => {
  beforeAll(() => mediaQueries());

  it("tells a renter with a private library why, and still offers the curated free games with no store data", () => {
    render(<Wall swiff={swiffWith(applySteam(privateLibrary, pool), privateLibrary)} />);
    expect(screen.getByTestId("library-state").textContent).toMatch(/Game details to Public/);
    expect(screen.getAllByText("Counter-Strike 2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("THE FINALS").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Play" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("Cyberpunk 2077")).toBeNull();
  });

  it("still offers a private library the free-to-play games, marked Free", () => {
    render(<Wall swiff={swiffWith(applySteam(privateLibrary, pool, [cs2]), privateLibrary)} />);
    expect(screen.getByTestId("library-state")).toBeTruthy();
    expect(screen.getAllByText("Counter-Strike 2").length).toBeGreaterThan(0);
    expect(screen.queryByText("Cyberpunk 2077")).toBeNull();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });

  it("reads the library again when the renter retries", () => {
    const retry = vi.fn();
    render(<Wall swiff={swiffWith([], privateLibrary, retry)} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("explains a readable library with nothing playable, without a retry that would read the same", () => {
    const profile = { ...privateLibrary, lib: true };
    render(<Wall swiff={swiffWith(applySteam(profile, pool, [cs2]), profile)} />);
    expect(screen.getByTestId("library-state").textContent).toMatch(/None of your Steam games/);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("says a library still being checked is being checked, not that none of it can be played", () => {
    const profile = { ...privateLibrary, lib: true, checking: 3 };
    const retry = vi.fn();
    render(<Wall swiff={swiffWith(applySteam(profile, pool, [cs2]), profile, retry)} />);
    expect(screen.getByTestId("library-state").textContent).toMatch(/Checking your games/);
    expect(screen.queryByText(/None of your Steam games/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("says nothing about a library that reads fine", () => {
    const profile = { ...privateLibrary, lib: true, owned: [[1245620, 12]] as [number, number][] };
    render(<Wall swiff={swiffWith(applySteam(profile, pool), profile)} />);
    expect(screen.queryByTestId("library-state")).toBeNull();
    expect(screen.getAllByText("Elden Ring").length).toBeGreaterThan(0);
    expect(screen.queryByText("Cyberpunk 2077")).toBeNull();
  });

  it("keeps the signed-out wall as it was: browsing, not ownership", () => {
    render(<Wall swiff={swiffWith(GAMES, null)} />);
    expect(screen.queryByTestId("library-state")).toBeNull();
    expect(screen.getAllByText("Cyberpunk 2077").length).toBeGreaterThan(0);
  });

  it("offers a signed-out visitor one way in, Sign in with Steam, and no way to play from the hero", () => {
    render(<Wall swiff={swiffWith(GAMES, null)} />);
    const signIn = screen.getAllByRole("link", { name: /sign in/i });
    expect(signIn).toHaveLength(1);
    expect(signIn[0]).toHaveTextContent("Sign in with Steam");
    expect(signIn[0]).toHaveAttribute("href", "/auth/steam/login");
    expect(screen.queryByRole("button", { name: /play free/i })).toBeNull();
    expect(screen.queryByAltText("Sign in through Steam")).toBeNull();
  });

  describe("with every shared machine busy", () => {
    const busy = Object.fromEntries(Object.entries(MACHINES).map(([id, m]) => [id, { ...m, busy: true }]));
    const emptyWall = (profile: SteamProfile | null, games: Game[]) =>
      render(<Wall swiff={swiffWith(games, profile, noop, true, { pool: busy })} />);

    it("still offers a signed-out visitor the one Sign in with Steam", () => {
      emptyWall(null, GAMES);
      expect(screen.getByText("Nothing is ready right now")).toBeTruthy();
      const signIn = screen.getAllByRole("link", { name: /sign in/i });
      expect(signIn).toHaveLength(1);
      expect(signIn[0]).toHaveTextContent("Sign in with Steam");
      expect(signIn[0]).toHaveAttribute("href", "/auth/steam/login");
      expect(screen.getByText(/Sign in with Steam and we'll tell you when a PC frees up\./)).toBeTruthy();
      expect(screen.queryByText(/We'll tell you the moment something frees up/)).toBeNull();
    });

    it("says nothing about what is free to a crew, with paid gaming off: the games show anyway", () => {
      setPaidGaming(false);
      const profile = { ...privateLibrary, lib: true, owned: [[1245620, 12]] as [number, number][] };
      emptyWall(profile, applySteam(profile, pool));
      expect(screen.queryByText("Nothing is ready right now")).toBeNull();
      expect(screen.queryByText(/No PC is free|Every PC on Lanterel is in use/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Notify me" })).toBeNull();
      expect(screen.getByTestId("hero")).toBeInTheDocument();
    });

    it("asks a signed-in renter for nothing more", () => {
      const profile = { ...privateLibrary, lib: true, owned: [[1245620, 12]] as [number, number][] };
      emptyWall(profile, applySteam(profile, pool));
      expect(screen.getByText("Nothing is ready right now")).toBeTruthy();
      expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull();
      expect(
        screen.getByText(
          "Every PC on Lanterel is in use. Moss is back at 21:30. We'll tell you the moment something frees up.",
        ),
      ).toBeTruthy();
    });
  });

  it("shows still art in the hero, drifting, never a trailer", () => {
    const { container } = render(<Wall swiff={swiffWith(GAMES, null)} />);
    expect(container.querySelector('[data-testid="hero"] video')).toBeNull();
    expect(container.querySelector('[data-testid="hero"] .backdrop-still.backdrop-drift')).not.toBeNull();
  });

  it("drafts a signed-out visitor's hero as the game on now, with the pitch and no live machine count", () => {
    render(<Wall swiff={swiffWith(GAMES, null)} />);
    const hero = within(screen.getByTestId("hero"));
    expect(hero.getByText("Now on Lanterel")).toBeInTheDocument();
    expect(hero.getByText(/We read your Steam library/)).toBeInTheDocument();
    expect(hero.queryByText(/free near you/)).toBeNull();
    expect(hero.queryByRole("button", { name: /resume|play/i })).toBeNull();
  });

  it("puts a signed-in renter's own game in the hero, with its machine and Resume in the strip", () => {
    const openGame = vi.fn();
    const profile = { ...privateLibrary, lib: true, owned: [[1245620, 12]] as [number, number][] };
    render(<Wall swiff={{ ...swiffWith(applySteam(profile, pool), profile), openGame }} />);
    const hero = within(screen.getByTestId("hero"));
    expect(hero.getByRole("heading", { level: 1 })).toHaveTextContent("Elden Ring");
    expect(hero.getByText("From your library")).toBeInTheDocument();
    expect(hero.getByText("Response")).toBeInTheDocument();
    expect(hero.queryByRole("link", { name: /sign in/i })).toBeNull();

    fireEvent.click(hero.getByRole("button", { name: "Resume" }));
    expect(openGame).toHaveBeenCalledOnce();
    expect((openGame.mock.calls[0]![0] as Game).title).toBe("Elden Ring");
  });

  describe("signed out, the hero turns through games", () => {
    afterEach(() => {
      vi.useRealTimers();
      mediaQueries();
    });

    it("moves to the next game every few seconds and keeps the one sign-in", () => {
      vi.useFakeTimers();
      render(<Wall swiff={swiffWith(GAMES, null)} />);
      const first = heroTitle();
      act(() => vi.advanceTimersByTime(7000));
      expect(heroTitle()).not.toBe(first);
      expect(screen.getAllByRole("link", { name: /sign in/i })).toHaveLength(1);
    });

    it("holds while the pointer is on the hero or focus is in it", () => {
      vi.useFakeTimers();
      render(<Wall swiff={swiffWith(GAMES, null)} />);
      const first = heroTitle();
      fireEvent.mouseEnter(screen.getByTestId("hero"));
      act(() => vi.advanceTimersByTime(21_000));
      expect(heroTitle()).toBe(first);

      fireEvent.mouseLeave(screen.getByTestId("hero"));
      fireEvent.focus(screen.getByRole("link", { name: "Sign in with Steam" }));
      act(() => vi.advanceTimersByTime(21_000));
      expect(heroTitle()).toBe(first);
    });

    it("stays on one game under reduced motion or with motion off", () => {
      vi.useFakeTimers();
      mediaQueries({ reduce: true });
      const { unmount } = render(<Wall swiff={swiffWith(GAMES, null)} />);
      const first = heroTitle();
      act(() => vi.advanceTimersByTime(21_000));
      expect(heroTitle()).toBe(first);
      unmount();

      mediaQueries();
      render(<Wall swiff={swiffWith(GAMES, null, noop, false)} />);
      act(() => vi.advanceTimersByTime(21_000));
      expect(heroTitle()).toBe(first);
    });

    it("stops turning as soon as the OS asks for reduced motion", () => {
      vi.useFakeTimers();
      const setReduce = mediaQueries();
      render(<Wall swiff={swiffWith(GAMES, null)} />);
      act(() => setReduce(true));
      const first = heroTitle();
      act(() => vi.advanceTimersByTime(21_000));
      expect(heroTitle()).toBe(first);
    });

    it("paints every game in the turn so the next image is loaded before it shows", () => {
      const { container } = render(<Wall swiff={swiffWith(GAMES, null)} />);
      expect(container.querySelectorAll(".hero-slide").length).toBeGreaterThan(1);
      expect(container.querySelectorAll(".hero-slide.on")).toHaveLength(1);
    });

    it("drifts only the game on show and the one fading out", () => {
      vi.useFakeTimers();
      const { container } = render(<Wall swiff={swiffWith(GAMES, null)} />);
      const slides = () => [...container.querySelectorAll(".hero-slide")];
      const drifting = () => slides().filter((s) => s.querySelector(".backdrop-drift"));
      expect(slides().length).toBeGreaterThan(2);
      act(() => vi.advanceTimersByTime(7000));
      const on = container.querySelector(".hero-slide.on")!;
      expect(drifting()).toEqual([slides()[0], on]);
    });
  });

  it("keeps a signed-in renter's hero on their own lead game", () => {
    vi.useFakeTimers();
    const profile = { ...privateLibrary, lib: true, owned: [[1245620, 12]] as [number, number][] };
    const { container } = render(<Wall swiff={swiffWith(applySteam(profile, pool), profile)} />);
    const first = heroTitle();
    act(() => vi.advanceTimersByTime(21_000));
    expect(heroTitle()).toBe(first);
    expect(container.querySelectorAll(".hero-slide")).toHaveLength(1);
    vi.useRealTimers();
  });

  describe("on the real hosts", () => {
    const owner = { ...privateLibrary, lib: true, owned: [[1245620, 12]] as [number, number][] };
    const rig = { id: "h1", name: "Basement rig", gpu: "RTX 4070", ping: 23, quality: "", busy: false };
    /** Every game known, with nothing ready and `back` (or nobody) coming back. */
    const nothingReady = (games: Game[], back: Spot["back"], { free = 0, busy = back ? 1 : 0 } = {}) =>
      new Map(games.map((g) => [g.id, { free, ready: 0, busy, best: null, back }]));
    const ready = (best: Spot["best"]): Spot => ({ free: 1, ready: 1, busy: 0, best, back: null });

    it("shows a signed-out visitor no availability anywhere", () => {
      render(<Wall swiff={swiffWith(GAMES, null, noop, true, { spots: new Map() })} />);
      expect(screen.queryByText("Nothing is ready right now")).toBeNull();
      expect(screen.queryAllByText(/free near you|Back at|In use|free until|12 h\+|Finding/)).toHaveLength(0);
      // A free game can be started once signed in; a paid one if you own it.
      expect(screen.getAllByText("Sign in to play").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Sign in to play if you own it").length).toBeGreaterThan(0);
      expect(within(screen.getByTestId("hero")).getByText(/player's PC/)).toBeInTheDocument();
    });

    it("tells a signed-in renter machines are being found until the server answers", () => {
      render(<Wall swiff={swiffWith(applySteam(owner, []), owner, noop, true, { spots: new Map() })} />);
      expect(screen.queryByText("Nothing is ready right now")).toBeNull();
      expect(within(screen.getByTestId("hero")).getByText("Finding you a PC…")).toBeInTheDocument();
      expect(screen.getAllByText("Finding a PC…").length).toBeGreaterThan(0);
    });

    it("offers the host the server ranked first, with its time left by the real clock", () => {
      const games = applySteam(owner, []);
      const spots = new Map([[games[0]!.id, ready({ ...rig, until: "23:30" })]]);
      render(
        <Wall
          swiff={swiffWith(games, owner, noop, true, { spots, clock: new Date(2026, 9, 3, 22, 0).getTime() })}
        />,
      );
      const hero = within(screen.getByTestId("hero"));
      expect(hero.getByRole("heading", { level: 1 })).toHaveTextContent("Elden Ring");
      expect(hero.getByText(/free until 23:30/)).toBeInTheDocument();
      expect(hero.getByText("1 h 30 free")).toBeInTheDocument();
      expect(hero.getByText("23 ms")).toBeInTheDocument();
    });

    it("says which host is back, and when, when nothing is ready", () => {
      const games = applySteam(owner, []);
      const back = { name: "Basement rig", at: "23:10", backAt: new Date(2026, 9, 3, 23, 10).getTime() };
      render(<Wall swiff={swiffWith(games, owner, noop, true, { spots: nothingReady(games, back) })} />);
      expect(
        screen.getByText(
          "Every PC on Lanterel is in use. Basement rig is back at 23:10. We'll tell you the moment something frees up.",
        ),
      ).toBeInTheDocument();
    });

    it("says which host is back soonest across games, not the first in wall order", () => {
      const games = applySteam(owner, []);
      const late = { name: "Loft", at: "23:00", backAt: new Date(2026, 9, 3, 23, 0).getTime() };
      const soon = { name: "Basement rig", at: "21:15", backAt: new Date(2026, 9, 3, 21, 15).getTime() };
      const spots = new Map(
        games.map((g, i) => [g.id, { free: 0, ready: 0, busy: 1, best: null, back: i === 0 ? late : soon }]),
      );
      render(<Wall swiff={swiffWith(games, owner, noop, true, { spots })} />);
      expect(
        screen.getByText(/Every PC on Lanterel is in use\. Basement rig is back at 21:15\./),
      ).toBeInTheDocument();
    });

    it("labels the busy tab with the soonest back, not the first busy game's", () => {
      const games = GAMES;
      const late = { name: "Loft", at: "23:00", backAt: new Date(2026, 9, 3, 23, 0).getTime() };
      const soon = { name: "Basement rig", at: "21:15", backAt: new Date(2026, 9, 3, 21, 15).getTime() };
      const taken = (back: Spot["back"]): Spot => ({ free: 0, ready: 0, busy: 1, best: null, back });
      const [lead, ...others] = wallOrder(games, new Map(games.map((g) => [g.id, taken(null)])));
      // The first busy game in wall order is back last.
      const spots = new Map<string, Spot>([
        [lead!.id, ready({ ...rig, until: "late" })],
        [others[0]!.id, taken(late)],
        [others[1]!.id, taken(soon)],
      ]);
      const { container } = render(<Wall swiff={swiffWith(games, owner, noop, true, { spots })} />);
      const tabs = [...container.querySelectorAll(".band-tab")].map((t) => t.textContent ?? "");
      expect(tabs.some((t) => t.startsWith("Back at 21:15"))).toBe(true);
      expect(tabs.some((t) => t.startsWith("Back at 23:00"))).toBe(false);
    });

    it("pairs a clock end with Free until and an open end with Free for, in either language", () => {
      const games = applySteam(owner, []);
      const facts = () => screen.getByTestId("hero").querySelector(".hero-kv")!;
      const at = (until: string) => new Map([[games[0]!.id, ready({ ...rig, until })]]);
      const clock = new Date(2026, 9, 3, 22, 0).getTime();
      const { rerender } = render(
        <Wall swiff={swiffWith(games, owner, noop, true, { spots: at("23:30"), clock })} />,
      );
      expect(facts()).toHaveTextContent("Free until23:30");
      rerender(<Wall swiff={swiffWith(games, owner, noop, true, { spots: at("late"), clock })} />);
      expect(facts()).toHaveTextContent("Free for12 h+");
      expect(facts()).not.toHaveTextContent("Free until");
      rerender(
        <ScreenLang.Provider value="de">
          <Wall swiff={swiffWith(games, owner, noop, true, { spots: at("late"), clock })} />
        </ScreenLang.Provider>,
      );
      expect(facts()).toHaveTextContent("Frei für12+ Std.");
      expect(facts()).not.toHaveTextContent("Frei bis");
      rerender(
        <ScreenLang.Provider value="de">
          <Wall swiff={swiffWith(games, owner, noop, true, { spots: at("23:30"), clock })} />
        </ScreenLang.Provider>,
      );
      expect(facts()).toHaveTextContent("Frei bis23:30");
    });

    it("leaves a host whose offer has passed since it was read no time, not 12 h+", () => {
      const games = applySteam(owner, []);
      const until = new Date(2026, 9, 3, 21, 30, 40).getTime();
      const spots = new Map([[games[0]!.id, ready({ ...rig, until: "21:30", untilAt: until })]]);
      render(
        <Wall
          swiff={swiffWith(games, owner, noop, true, {
            spots,
            clock: new Date(2026, 9, 3, 21, 31).getTime(),
          })}
        />,
      );
      const hero = within(screen.getByTestId("hero"));
      expect(hero.getByText("0 min free")).toBeInTheDocument();
      expect(hero.queryByText(/12 h\+/)).toBeNull();
    });

    it("says what is free does not last the session, rather than that nothing is free", () => {
      const games = applySteam(owner, []);
      render(
        <Wall
          swiff={swiffWith(games, owner, noop, true, { spots: nothingReady(games, null, { free: 1 }) })}
        />,
      );
      expect(
        screen.getByText(/No free PC lasts your whole play time\. Try a shorter play time/),
      ).toBeInTheDocument();
    });

    it("tells apart a game a host is busy with, one only free for less, and one no host has", () => {
      const games = GAMES;
      const [lead, busy, short, none] = games;
      const spots = new Map<string, Spot>([
        [lead!.id, ready({ ...rig, until: "late" })],
        [busy!.id, { free: 0, ready: 0, busy: 1, best: null, back: null }],
        [short!.id, { free: 1, ready: 0, busy: 0, best: null, back: null }],
        [none!.id, { free: 0, ready: 0, busy: 0, best: null, back: null }],
      ]);
      render(<Wall swiff={swiffWith(games, owner, noop, true, { spots })} />);
      const meta = (game: Game) =>
        screen
          .getAllByText(game.title)
          .find((el) => el.closest(".band-tile"))!
          .closest(".band-tile")!;
      expect(meta(busy!)).toHaveTextContent("In use");
      expect(meta(short!)).toHaveTextContent("Free, not long enough");
      expect(meta(none!)).toHaveTextContent("Not on a PC yet");
    });

    it("invents no machine coming back when none is on offer", () => {
      const games = applySteam(owner, []);
      render(<Wall swiff={swiffWith(games, owner, noop, true, { spots: nothingReady(games, null) })} />);
      expect(
        screen.getByText("No PC is free right now. We'll tell you the moment something frees up."),
      ).toBeInTheDocument();
      expect(screen.queryAllByText(/Moss/)).toHaveLength(0);
    });

    it("pulses a game that just became playable, and only with motion on", () => {
      const games = applySteam(owner, []);
      const spots = new Map([[games[0]!.id, ready({ ...rig, until: "late" })]]);
      const freed = [games[0]!.id];
      const { unmount } = render(<Wall swiff={swiffWith(games, owner, noop, true, { spots, freed })} />);
      expect(screen.getByTestId("hero")).toHaveClass("freed");
      unmount();
      render(<Wall swiff={swiffWith(games, owner, noop, false, { spots, freed })} />);
      expect(screen.getByTestId("hero")).not.toHaveClass("freed");
    });
  });
});
