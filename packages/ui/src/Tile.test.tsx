import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Tile } from "./Tile";

describe("Tile", () => {
  it("keeps the caption off the hero, which carries its own title", () => {
    const { rerender } = render(<Tile title="Elden Ring" art="a.jpg" size="small" />);
    expect(screen.getByText("Elden Ring")).toBeInTheDocument();
    rerender(
      <Tile title="Elden Ring" art="a.jpg" size="hero">
        <span>hero overlay</span>
      </Tile>,
    );
    expect(screen.queryByText("Elden Ring")).not.toBeInTheDocument();
    expect(screen.getByText("hero overlay")).toBeInTheDocument();
  });

  it("does not make the hero a button, because it contains its own controls", () => {
    // A <button> may not contain a link, and the hero holds Valve's sign-in
    // link: nesting them made signing in also open the game.
    const { container } = render(
      <Tile title="Elden Ring" art="a.jpg" size="hero" onOpen={() => {}}>
        <a href="/auth/steam/login">Sign in through Steam</a>
      </Tile>,
    );
    expect(container.querySelector("button")).toBeNull();
    expect(screen.getByRole("link")).toBeInTheDocument();
  });

  it("renders the trailer only when one is given", () => {
    const { container, rerender } = render(<Tile title="A" art="a.jpg" />);
    expect(container.querySelector(".tile-video")).toBeNull();
    rerender(<Tile title="A" art="a.jpg" video="clip.webm" />);
    expect(container.querySelector(".tile-video")).not.toBeNull();
  });

  it("reports hover both ways so the wall can tint behind it", async () => {
    const onHoverChange = vi.fn();
    render(<Tile title="A" art="a.jpg" onHoverChange={onHoverChange} />);
    await userEvent.hover(screen.getByRole("button"));
    await userEvent.unhover(screen.getByRole("button"));
    expect(onHoverChange.mock.calls).toEqual([[true], [false]]);
  });
});
