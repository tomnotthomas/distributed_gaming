import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, machinesFor } from "./derive";
import { GAMES, MACHINES } from "./data";
import { GameMenu } from "./GameMenu";
import type { Swiff } from "./useSwiff";

const noop = () => {};

/** Baldur's Gate 3 runs on Tide (free) and Moss (busy until 21:30). */
const bg3 = GAMES.find((game) => game.id === "bg3")!;
const machines = machinesFor(bg3, MACHINES, "evening");

/** Just the slice of the hook the game page reads. */
const swiffWith = (phase: Swiff["phase"]) =>
  ({
    game: bg3,
    machines,
    picked: MACHINES.tide,
    pool: MACHINES,
    session: "evening",
    phase,
    ...DEFAULT_PREFS,
    launch: noop,
    setMachineId: noop,
  }) as unknown as Swiff;

describe("GameMenu", () => {
  it("counts the players behind the listed machines, not the busy one left out", () => {
    render(<GameMenu swiff={swiffWith("idle")} />);

    expect(screen.getByText(/1 machine from 1 player/)).toBeInTheDocument();
    expect(screen.getByText(/\+1 back at 21:30/)).toBeInTheDocument();
  });

  it("will not take a second hold while the launch is under way", () => {
    render(<GameMenu swiff={swiffWith("connecting")} />);

    expect(screen.getByRole("button", { name: "Hold to launch on Tide" })).toBeDisabled();
  });
});
