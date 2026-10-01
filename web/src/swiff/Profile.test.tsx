import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Profile } from "./Profile";
import type { SteamProfile } from "./steam";
import type { Swiff } from "./useSwiff";

const noop = () => {};

/** Just the slice of the hook Profile reads. */
function swiffWith(profile: SteamProfile | null): Swiff {
  return {
    profile,
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

describe("Profile", () => {
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
