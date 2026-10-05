import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { GAMES, MACHINES } from "./data";
import { Ignition } from "./Ignition";
import { ignitionLabels } from "./play";
import type { Swiff } from "./useSwiff";

/** Just the slice of the hook Ignition reads, at step `ignitionIndex`. */
const swiffAt = (progress: number, ignitionIndex: number, more: Partial<Swiff> = {}) =>
  ({
    game: GAMES[0],
    picked: MACHINES.glass,
    progress,
    ignitionSteps: ignitionLabels(MACHINES.glass!.name, GAMES[0]!.title),
    ignitionIndex,
    slow: false,
    goHome: () => {},
    tryAnother: () => {},
    ...more,
  }) as unknown as Swiff;

describe("Ignition", () => {
  it("follows the launch's real step: the ones before it done, the ones after it next", () => {
    render(<Ignition swiff={swiffAt(0.5, 2)} />);

    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.dataset.state)).toEqual(["done", "done", "now", "next"]);
    expect(within(rows[2]!).getByText("Negotiating stream")).toBeInTheDocument();
  });

  it("names the game and the machine it is starting on, in its steps too, with no save step", () => {
    render(<Ignition swiff={swiffAt(0, 0)} />);

    expect(screen.getByRole("dialog", { name: "Starting Elden Ring" })).toBeInTheDocument();
    expect(screen.getByText("Glasshouse")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((row) => row.children[1]!.textContent)).toEqual([
      "Reserving a machine",
      "Waking Glasshouse",
      "Negotiating stream",
      "Launching Elden Ring",
    ]);
  });

  it("says which machine a session carried on from a lost one moved from, and the one it is on now", () => {
    const lost = { host: "Basement rig", taken: false, next: null, failed: false };
    const { rerender } = render(
      <Ignition
        swiff={swiffAt(0.25, 1, {
          picked: null,
          booking: { machine: { name: "Attic box" } },
          lost,
        } as unknown as Partial<Swiff>)}
      />,
    );
    expect(screen.getByTestId("ignition-kicker")).toHaveTextContent("Basement rig went offline");
    expect(screen.getByText("Attic box")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent("now on Attic box");

    rerender(
      <Ignition swiff={swiffAt(0.25, 1, { lost: { ...lost, taken: true } } as unknown as Partial<Swiff>)} />,
    );
    expect(screen.getByTestId("ignition-kicker")).toHaveTextContent("Basement rig was taken back");
    rerender(<Ignition swiff={swiffAt(0.25, 1)} />);
    expect(screen.getByTestId("ignition-kicker")).toHaveTextContent("Starting");
  });

  it("announces the current step, not every eased percentage", () => {
    render(<Ignition swiff={swiffAt(0.25, 1)} />);

    const live = document.querySelector('[aria-live="polite"]')!;
    expect(live).toHaveTextContent("Waking Glasshouse");
    expect(live).not.toHaveTextContent("%");
  });

  it("says a slow step is taking longer than usual and offers another machine", () => {
    const tryAnother = vi.fn();
    const { rerender } = render(<Ignition swiff={swiffAt(0.3, 1, { tryAnother })} />);
    expect(screen.queryByText("Taking longer than usual")).not.toBeInTheDocument();

    rerender(<Ignition swiff={swiffAt(0.3, 1, { tryAnother, slow: true })} />);
    expect(screen.getByText("Taking longer than usual")).toBeInTheDocument();
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
      "Waking Glasshouse: taking longer than usual",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try another machine" }));
    expect(tryAnother).toHaveBeenCalledTimes(1);
  });

  it("reads End once the session's clock runs, and ends it", () => {
    const goHome = vi.fn();
    render(<Ignition swiff={swiffAt(0.9, 3, { goHome, play: { started: true } as Swiff["play"] })} />);
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    expect(goHome).toHaveBeenCalledTimes(1);
  });

  it("cancels with Cancel", () => {
    const goHome = vi.fn();
    render(<Ignition swiff={swiffAt(0.1, 0, { goHome })} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(goHome).toHaveBeenCalledTimes(1);
  });

  it("takes focus while it is up and hands it back when it closes", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Launch</button>
          <button onClick={() => setOpen(false)}>Close</button>
          {open ? <Ignition swiff={swiffAt(0, 0)} /> : null}
        </>
      );
    }
    render(<Harness />);
    const launch = screen.getByRole("button", { name: "Launch" });
    launch.focus();
    fireEvent.click(launch);

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(launch).toHaveFocus();
  });
});
