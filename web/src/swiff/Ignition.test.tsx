import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GAMES, MACHINES } from "./data";
import { Ignition } from "./Ignition";
import type { Swiff } from "./useSwiff";

/** Just the slice of the hook Ignition reads. */
const swiffAt = (progress: number, ignitionStep: string) =>
  ({
    game: GAMES[0],
    picked: MACHINES.glass,
    progress,
    ignitionStep,
    goHome: () => {},
  }) as unknown as Swiff;

describe("Ignition", () => {
  it("follows the launch's real step: the ones before it done, the ones after it next", () => {
    render(<Ignition swiff={swiffAt(0.5, "Negotiating stream")} />);

    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.dataset.state)).toEqual(["done", "done", "now", "next"]);
    expect(within(rows[2]!).getByText("Negotiating stream")).toBeInTheDocument();
  });

  it("names the game and the machine it is starting on", () => {
    render(<Ignition swiff={swiffAt(0, "Waking machine")} />);

    expect(screen.getByRole("dialog", { name: "Starting Elden Ring" })).toBeInTheDocument();
    expect(screen.getByText("Glasshouse")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });
});
