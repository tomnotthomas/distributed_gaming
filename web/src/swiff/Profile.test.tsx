import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Profile } from "./Profile";
import type { SteamProfile } from "./steam";
import type { Swiff } from "./useSwiff";

const noop = () => {};

/** Just the slice of the hook Profile reads. */
function swiffWith(profile: SteamProfile | null, signOutFailed = false, openShare = noop): Swiff {
  return {
    profile,
    signedIn: profile !== null,
    steamId: profile ? "76561198000000001" : null,
    signOutFailed,
    games: [],
    devices: [],
    quality: "auto",
    motion: true,
    sound: true,
    signOut: noop,
    setQuality: noop,
    toggleDevice: noop,
    setMotion: noop,
    setSound: noop,
    goHome: noop,
    openShare,
  } as unknown as Swiff;
}

const signedIn: SteamProfile = {
  id: "76561198000000001",
  persona: "kai_nx",
  avatar: "",
  hours: 0,
  size: 0,
  owned: [],
  games: [],
  lib: false,
};

describe("Profile", () => {
  it("tells a renter whose sign-out failed that they are still signed in", () => {
    render(<Profile swiff={swiffWith(signedIn, true)} />);
    expect(screen.getByRole("alert")).toHaveTextContent("still signed in");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("shows no sign-out error until a sign-out has failed", () => {
    render(<Profile swiff={swiffWith(signedIn)} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // /api/me answers an empty persona when Steam cannot be read (no key, an
  // error or the timeout); the signed-in renter must still see the page.
  it("renders a signed-in renter whose Steam persona is empty", () => {
    const profile: SteamProfile = {
      id: "76561198000000001",
      persona: "",
      avatar: "",
      hours: 0,
      size: 0,
      owned: [],
      games: [],
      lib: false,
    };
    render(<Profile swiff={swiffWith(profile)} />);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByText("?")).toBeInTheDocument();
    expect(screen.getByText("Signed in with Steam")).toBeInTheDocument();
    expect(screen.getByText(/Steam id …0001/)).toBeInTheDocument();
    expect(screen.queryByText("Not signed in")).toBeNull();
    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull();
  });

  it("offers a signed-out visitor Sign in with Steam", () => {
    render(<Profile swiff={swiffWith(null)} />);
    expect(screen.getByText("Not signed in")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in with Steam" })).toHaveAttribute(
      "href",
      "/auth/steam/login",
    );
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  // The bar's nav cells fold away on a phone; the profile is where Share your PC is found there.
  it("leads to Share your PC", () => {
    const openShare = vi.fn();
    render(<Profile swiff={swiffWith(null, false, openShare)} />);
    fireEvent.click(screen.getByRole("button", { name: "Share your PC" }));
    expect(openShare).toHaveBeenCalledOnce();
  });
});
