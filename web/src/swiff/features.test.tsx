// Crews only: the app with paid gaming off (server/src/features.ts), as the
// server serves it by default.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { setPaidGaming } from "../test/features";
import { paidGaming, PLAY_PATH } from "./features";
import { Profile } from "./Profile";
import { pathOf, screenAt } from "./route";
import type { Swiff } from "./useSwiff";

describe("paid gaming off", () => {
  beforeEach(() => setPaidGaming(false));

  it("reads the switch from the page, off unless the server says on", () => {
    expect(paidGaming()).toBe(false);
    setPaidGaming(true);
    expect(paidGaming()).toBe(true);
    document.querySelector('meta[name="paid-gaming"]')!.remove();
    expect(paidGaming()).toBe(false);
  });

  it("keeps the wall at /play, since / is the start page, and has no estimate at /share", () => {
    expect(pathOf("home")).toBe(PLAY_PATH);
    expect(screenAt(PLAY_PATH)).toBe("home");
    expect(screenAt("/share")).toBe("crew");
    setPaidGaming(true);
    expect(pathOf("home")).toBe("/");
    expect(screenAt("/share")).toBe("share");
  });

  it("says nothing about getting paid for a PC on the profile", () => {
    const swiff = {
      profile: null,
      signedIn: false,
      steamId: null,
      signOutFailed: false,
      games: [],
      devices: [],
      quality: "auto",
      motion: true,
      sound: true,
    } as unknown as Swiff;
    render(<Profile swiff={swiff} />);
    expect(screen.queryByText(/get paid/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Share your PC/ })).toBeNull();
  });
});
