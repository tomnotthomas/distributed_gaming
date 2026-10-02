import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "./derive";
import { GAMES, MACHINES, type Game } from "./data";
import { applySteam, type CatalogGame, type SteamProfile } from "./steam";
import type { Swiff } from "./useSwiff";
import { Wall } from "./Wall";

const noop = () => {};
const pool = ["glass", "ember", "tide", "moss"];

/** Just the slice of the hook the wall reads. */
function swiffWith(games: Game[], profile: SteamProfile | null, retryLibrary = noop, motion = true): Swiff {
  return {
    motion,
    games,
    profile,
    signedIn: profile !== null,
    libraryRetrying: false,
    retryLibrary,
    pool: MACHINES,
    session: "evening",
    prefs: DEFAULT_PREFS,
    showAll: true,
    hoverId: null,
    steamDenied: false,
    openGame: noop,
    setHoverId: noop,
    setShowAll: noop,
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

  it("shows still art in the hero, drifting, never a trailer", () => {
    const { container } = render(<Wall swiff={swiffWith(GAMES, null)} />);
    expect(container.querySelector('[data-testid="hero"] video')).toBeNull();
    expect(container.querySelector('[data-testid="hero"] .backdrop-still.backdrop-drift')).not.toBeNull();
  });

  it("drafts a signed-out visitor's hero as tonight's game, with the pitch and the free count in the strip", () => {
    render(<Wall swiff={swiffWith(GAMES, null)} />);
    const hero = within(screen.getByTestId("hero"));
    expect(hero.getByText("Tonight on Swiff")).toBeInTheDocument();
    expect(hero.getByText(/We read your Steam library/)).toBeInTheDocument();
    expect(hero.getByText(/PCs? free near you/)).toBeInTheDocument();
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
});
