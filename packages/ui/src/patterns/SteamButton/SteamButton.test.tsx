import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SteamButton } from "./SteamButton";

describe("SteamButton", () => {
  it("uses Valve's published asset and alt text, not a lookalike", () => {
    render(<SteamButton />);
    const img = screen.getByAltText("Sign in through Steam");
    expect(img).toHaveAttribute(
      "src",
      "https://community.steamstatic.com/public/images/signinthroughsteam/sits_01.png",
    );
    // Explicit intrinsic size: the first-run hero must not shift on load.
    expect(img).toHaveAttribute("width", "180");
    expect(img).toHaveAttribute("height", "35");
  });

  it("points at the server route that starts OpenID", () => {
    render(<SteamButton />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/auth/steam/login");
  });

  it("swaps to the small variant with its own dimensions", () => {
    render(<SteamButton small />);
    const img = screen.getByAltText("Sign in through Steam");
    expect(img.getAttribute("src")).toContain("sits_small.png");
    expect(img).toHaveAttribute("width", "154");
    expect(img).toHaveAttribute("height", "23");
  });
});
