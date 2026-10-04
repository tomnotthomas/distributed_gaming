import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { GAMES, MACHINES } from "./data";
import { Ignition } from "./Ignition";
import type { Swiff } from "./useSwiff";

/** Just the slice of the hook Ignition reads. */
const swiffAt = (progress: number, ignitionStep: string, steamLogin: Swiff["steamLogin"] = null) =>
  ({
    game: GAMES[0],
    picked: MACHINES.glass,
    progress,
    ignitionStep,
    steamLogin,
    goHome: () => {},
  }) as unknown as Swiff;

const SIGN_IN = "https://s.team/q/1/1234567890123456789";

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

  it("announces the current step, not every eased percentage", () => {
    render(<Ignition swiff={swiffAt(0.25, "Syncing your save")} />);

    const live = document.querySelector('[aria-live="polite"]')!;
    expect(live).toHaveTextContent("Syncing your save");
    expect(live).not.toHaveTextContent("%");
  });

  it("takes focus while it is up and hands it back when it closes", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Launch</button>
          <button onClick={() => setOpen(false)}>Close</button>
          {open ? <Ignition swiff={swiffAt(0, "Waking machine")} /> : null}
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
    render(
      <Ignition swiff={swiffAt(0.5, "Launching game", { type: "steam-login", state: "qr", url: SIGN_IN })} />,
    );

    const panel = screen.getByRole("region", { name: "Sign in to Steam" });
    expect(within(panel).getByRole("img", { name: "Steam sign-in QR code" })).toBeInTheDocument();
    expect(panel).toHaveTextContent("Scan this with the Steam app");
    expect(document.querySelector(".ig-dial")).toBeNull();
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent("Sign in to Steam");
  });

  it("draws the code from the link it is given, with a scanner's quiet margin", () => {
    const { rerender } = render(
      <Ignition swiff={swiffAt(0.5, "Launching game", { type: "steam-login", state: "qr", url: SIGN_IN })} />,
    );
    const code = () => screen.getByRole("img", { name: "Steam sign-in QR code" });
    const first = code().querySelector("path")!.getAttribute("d");
    // 29 modules for this link at level M, plus 4 of white on each side.
    expect(code().getAttribute("viewBox")).toBe("0 0 37 37");
    expect(first).toMatch(/^M4 4h1v1h-1z/);

    rerender(
      <Ignition
        swiff={swiffAt(0.5, "Launching game", {
          type: "steam-login",
          state: "qr",
          url: `${SIGN_IN.slice(0, -1)}0`,
        })}
      />,
    );
    expect(code().querySelector("path")!.getAttribute("d")).not.toBe(first);
  });

  it("draws nothing to scan but a Steam sign-in link, and goes back to the dial once signed in", () => {
    const { rerender } = render(
      <Ignition
        swiff={swiffAt(0.5, "Launching game", {
          type: "steam-login",
          state: "qr",
          url: "https://evil.example/q/1/2",
        })}
      />,
    );
    expect(screen.queryByTestId("steam-sign-in")).toBeNull();
    expect(document.querySelector(".ig-dial")).not.toBeNull();

    rerender(
      <Ignition swiff={swiffAt(0.75, "Launching game", { type: "steam-login", state: "signed-in" })} />,
    );
    expect(screen.queryByTestId("steam-sign-in")).toBeNull();
    expect(document.querySelector(".ig-dial")).not.toBeNull();
  });

  it("says a failed Steam sign-in in the code's place, stops its step, and offers to try again", () => {
    const retrySignIn = vi.fn();
    const goHome = vi.fn();
    const at = (steamSignInFailed: boolean) =>
      ({
        ...swiffAt(0.25, "Syncing your save", { type: "steam-login", state: "qr", url: SIGN_IN }),
        steamSignInFailed,
        retrySignIn,
        goHome,
      }) as unknown as Swiff;
    // Ignition is up on the code first; the failure comes after.
    const { rerender } = render(<Ignition swiff={at(false)} />);
    rerender(<Ignition swiff={at(true)} />);

    const panel = screen.getByRole("region", { name: "Sign-in didn't work" });
    expect(screen.queryByRole("img", { name: "Steam sign-in QR code" })).toBeNull();
    expect(document.querySelector(".ig-dial")).toBeNull();
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
    expect(held).toHaveTextContent("Syncing your save");
    expect(held).toHaveTextContent("Stopped");
    expect(document.querySelector('.ig-legend [data-state="now"]')).toBeNull();
  });
});
