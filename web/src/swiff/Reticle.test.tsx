import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_MS, Reticle } from "./Reticle";

const FAKE = [
  "setTimeout",
  "clearTimeout",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "performance",
] as const;

/** Let the hold run for `ms` of fake time, a frame at a time. */
const run = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("Reticle", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKE] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("launches once the press has been held all the way", () => {
    const fire = vi.fn();
    render(<Reticle onFire={fire} label="Hold to launch on Glasshouse" />);
    const button = screen.getByRole("button", { name: "Hold to launch on Glasshouse" });

    fireEvent.pointerDown(button, { button: 0 });
    run(HOLD_MS / 2);
    expect(fire).not.toHaveBeenCalled();
    expect(button).toHaveAttribute("data-phase", "hold");

    run(HOLD_MS / 2 + 100);
    expect(fire).toHaveBeenCalledOnce();
    expect(button).toHaveAttribute("data-phase", "done");
  });

  it("drains with nothing launched when released early", () => {
    const fire = vi.fn();
    render(<Reticle onFire={fire} label="Hold to launch on Glasshouse" />);
    const button = screen.getByRole("button");

    fireEvent.pointerDown(button, { button: 0 });
    run(HOLD_MS / 2);
    // Released anywhere, not only over the button.
    fireEvent.pointerUp(window);
    run(HOLD_MS);

    expect(fire).not.toHaveBeenCalled();
    expect(button).toHaveAttribute("data-phase", "idle");
    expect(button.querySelector(".reticle-arc")).toHaveAttribute("stroke-dashoffset", "100.00");
  });

  it("holds from the keyboard with Space", () => {
    const fire = vi.fn();
    render(<Reticle onFire={fire} label="Hold to launch on Glasshouse" />);
    const button = screen.getByRole("button");

    fireEvent.keyDown(button, { key: " " });
    run(HOLD_MS + 100);
    fireEvent.keyUp(button, { key: " " });

    expect(fire).toHaveBeenCalledOnce();
  });

  it("does nothing without a machine to launch on", () => {
    const fire = vi.fn();
    render(<Reticle onFire={fire} disabled label="Pick a machine to launch" />);
    const button = screen.getByRole("button");

    fireEvent.pointerDown(button, { button: 0 });
    fireEvent.keyDown(button, { key: "Enter" });
    run(HOLD_MS * 2);

    expect(fire).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
  });

  it("stays on Launching and takes no new hold while a launch is under way", () => {
    const fire = vi.fn();
    render(<Reticle onFire={fire} launching label="Hold to launch on Glasshouse" />);
    const button = screen.getByRole("button");

    fireEvent.keyDown(button, { key: " " });
    fireEvent.pointerDown(button, { button: 0 });
    run(HOLD_MS * 2);

    expect(fire).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("data-phase", "done");
    expect(button).toHaveTextContent("Launching");
  });

  it("never fires once unmounted mid-hold", () => {
    const fire = vi.fn();
    const { unmount } = render(<Reticle onFire={fire} label="Hold to launch on Glasshouse" />);

    fireEvent.pointerDown(screen.getByRole("button"), { button: 0 });
    run(HOLD_MS / 2);
    unmount();
    run(HOLD_MS);

    expect(fire).not.toHaveBeenCalled();
  });
});
