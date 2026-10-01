import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "./derive";
import { GAMES, MACHINES, type Game } from "./data";
import { applySteam, type CatalogGame, type SteamProfile } from "./steam";
import type { Swiff } from "./useSwiff";
import { Wall } from "./Wall";

const noop = () => {};
const pool = ["glass", "ember", "tide", "moss"];

/** Just the slice of the hook the wall reads. */
function swiffWith(games: Game[], profile: SteamProfile | null, retryLibrary = noop): Swiff {
  return {
    games,
    profile,
    libraryConnected: profile !== null,
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

describe("Wall", () => {
  // jsdom has no media queries; every display reads as normal.
  beforeAll(() => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: noop,
      removeEventListener: noop,
    })) as unknown as typeof window.matchMedia;
  });

  it("tells a renter with a private library why, and shows them no games", () => {
    render(<Wall swiff={swiffWith(applySteam(privateLibrary, pool), privateLibrary)} />);
    expect(screen.getByTestId("library-state").textContent).toMatch(/Game details to Public/);
    expect(screen.queryByText("Cyberpunk 2077")).toBeNull();
    expect(screen.queryByText("Counter-Strike 2")).toBeNull();
  });

  it("still offers a private library the free-to-play games, marked Free", () => {
    render(<Wall swiff={swiffWith(applySteam(privateLibrary, pool, [cs2]), privateLibrary)} />);
    expect(screen.getByTestId("library-state")).toBeTruthy();
    expect(screen.getAllByText("Counter-Strike 2").length).toBeGreaterThan(0);
    expect(screen.queryByText("Cyberpunk 2077")).toBeNull();
    expect(screen.getByRole("button", { name: "Play free" })).toBeTruthy();
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
});
