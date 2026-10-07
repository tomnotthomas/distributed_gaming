import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { GAMES, MACHINES } from "./data";
import { Ignition } from "./Ignition";
import { ignitionLabels } from "./play";
import { screenText } from "./screenCopy";
import type { Swiff } from "./useSwiff";

/** Just the slice of the hook Ignition reads, at step `ignitionIndex`. */
const swiffAt = (progress: number, ignitionIndex: number, more: Partial<Swiff> = {}) =>
  ({
    game: GAMES[0],
    picked: MACHINES.glass,
    progress,
    ignitionSteps: ignitionLabels(screenText("en"), MACHINES.glass!.name, GAMES[0]!.title),
    ignitionIndex,
    slow: false,
    goHome: () => {},
    tryAnother: () => {},
    ...more,
  }) as unknown as Swiff;

const SIGN_IN = "https://s.team/q/1/1234567890123456789";
const qr = (url = SIGN_IN): Partial<Swiff> => ({ steamLogin: { type: "steam-login", state: "qr", url } });

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

  it("shows the PC's Steam sign-in code in the dial's place, to scan with the Steam app", () => {
    render(<Ignition swiff={swiffAt(0.75, 3, qr())} />);

    const panel = screen.getByRole("region", { name: "Sign in to Steam" });
    expect(within(panel).getByRole("img", { name: "Steam sign-in QR code" })).toBeInTheDocument();
    expect(panel).toHaveTextContent("Scan this with the Steam app");
    expect(document.querySelector(".ig-dial")).toBeNull();
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent("Sign in to Steam");
  });

  it("does not call the renter scanning a code slow", () => {
    render(<Ignition swiff={swiffAt(0.75, 3, { ...qr(), slow: true })} />);

    expect(screen.getByRole("region", { name: "Sign in to Steam" })).toBeInTheDocument();
    expect(screen.queryByTestId("ignition-slow")).toBeNull();
  });

  it("draws the code from the link it is given, with a scanner's quiet margin", () => {
    const { rerender } = render(<Ignition swiff={swiffAt(0.75, 3, qr())} />);
    const code = () => screen.getByRole("img", { name: "Steam sign-in QR code" });
    const first = code().querySelector("path")!.getAttribute("d");
    // 29 modules for this link at level M, plus 4 of white on each side.
    expect(code().getAttribute("viewBox")).toBe("0 0 37 37");
    expect(first).toMatch(/^M4 4h1v1h-1z/);

    rerender(<Ignition swiff={swiffAt(0.75, 3, qr(`${SIGN_IN.slice(0, -1)}0`))} />);
    expect(code().querySelector("path")!.getAttribute("d")).not.toBe(first);
  });

  it("draws nothing to scan but a Steam sign-in link, and goes back to the dial once signed in", () => {
    const { rerender } = render(<Ignition swiff={swiffAt(0.75, 3, qr("https://evil.example/q/1/2"))} />);
    expect(screen.queryByTestId("steam-sign-in")).toBeNull();
    expect(document.querySelector(".ig-dial")).not.toBeNull();

    rerender(
      <Ignition swiff={swiffAt(0.8, 3, { steamLogin: { type: "steam-login", state: "signed-in" } })} />,
    );
    expect(screen.queryByTestId("steam-sign-in")).toBeNull();
    expect(document.querySelector(".ig-dial")).not.toBeNull();
  });

  it("says a failed Steam sign-in in the code's place, stops its step, and offers to try again", () => {
    const retrySignIn = vi.fn();
    const goHome = vi.fn();
    const at = (steamSignInFailed: "sign-in-timeout" | null) =>
      swiffAt(0.75, 3, { ...qr(), steamSignInFailed, retrySignIn, goHome, slow: steamSignInFailed !== null });
    // Ignition is up on the code first; the failure comes after.
    const { rerender } = render(<Ignition swiff={at(null)} />);
    rerender(<Ignition swiff={at("sign-in-timeout")} />);

    const panel = screen.getByRole("region", { name: "Sign-in didn't work" });
    expect(screen.queryByRole("img", { name: "Steam sign-in QR code" })).toBeNull();
    expect(document.querySelector(".ig-dial")).toBeNull();
    expect(screen.queryByTestId("ignition-slow")).toBeNull();
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent("Sign-in didn't work");
    const retry = within(panel).getByRole("button", { name: "Try again" });
    expect(retry).toHaveFocus();

    fireEvent.click(retry);
    expect(retrySignIn).toHaveBeenCalledOnce();
    // Ignition's own Cancel is the one way out; the panel adds no second one.
    expect(within(panel).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(goHome).toHaveBeenCalledOnce();
    // The step it held at is stopped: no live percentage beside it.
    const held = document.querySelector('.ig-legend [data-state="stopped"]');
    expect(held).toHaveTextContent("Launching Elden Ring");
    expect(held).toHaveTextContent("Stopped");
    expect(document.querySelector('.ig-legend [data-state="now"]')).toBeNull();
  });

  it("says the sign-in time ran out, and offers to book again rather than a new code", () => {
    const retrySignIn = vi.fn();
    const launch = vi.fn();
    const at = (steamSignInFailed: "sign-in-timeout" | "time-up") =>
      swiffAt(0.75, 3, { steamSignInFailed, retrySignIn, launch, slow: false });
    // Try again was up when the time ran out.
    const { rerender } = render(<Ignition swiff={at("sign-in-timeout")} />);
    rerender(<Ignition swiff={at("time-up")} />);

    const panel = screen.getByRole("region", { name: "Sign-in time ran out" });
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent("Sign-in time ran out");
    expect(within(panel).queryByRole("button", { name: "Try again" })).toBeNull();
    const again = within(panel).getByRole("button", { name: "Book again" });
    expect(again).toHaveFocus();
    expect(within(panel).getAllByRole("button")).toHaveLength(1);

    fireEvent.click(again);
    expect(launch).toHaveBeenCalledOnce();
    expect(retrySignIn).not.toHaveBeenCalled();
  });

  it("says the game didn't start when it never came up after sign-in, and offers another machine, not a new code", () => {
    const retrySignIn = vi.fn();
    const tryAnother = vi.fn();
    const at = (steamSignInFailed: "launch-timeout" | null) =>
      swiffAt(0.75, 3, { steamSignInFailed, retrySignIn, tryAnother, slow: steamSignInFailed !== null });
    // Ignition is up first; the failure comes after.
    const { rerender } = render(<Ignition swiff={at(null)} />);
    rerender(<Ignition swiff={at("launch-timeout")} />);

    const panel = screen.getByRole("region", { name: "Your game didn't start" });
    expect(panel).not.toHaveTextContent("new code");
    expect(panel.textContent).not.toMatch(/\u2014/);
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent("Your game didn't start");
    expect(screen.queryByTestId("ignition-slow")).toBeNull();
    const another = within(panel).getByRole("button", { name: "Try another machine" });
    expect(another).toHaveFocus();
    expect(within(panel).getAllByRole("button")).toHaveLength(1);

    fireEvent.click(another);
    expect(tryAnother).toHaveBeenCalledOnce();
    expect(retrySignIn).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });
});
