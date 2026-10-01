import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Profile } from "./Profile";
import type { SteamProfile } from "./steam";
import type { Swiff } from "./useSwiff";

const noop = () => {};

/** Just the slice of the hook Profile reads. */
function swiffWith(profile: SteamProfile | null, signOutFailed = false): Swiff {
  return {
    profile,
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
  });
});
