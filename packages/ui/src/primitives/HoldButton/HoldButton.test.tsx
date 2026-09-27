import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoldButton } from "./HoldButton";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// jsdom has no PointerEvent constructor, so fireEvent synthesises the one React
// actually listens for.
const press = () => fireEvent.pointerDown(screen.getByRole("button"), { button: 0 });
const release = () => fireEvent.pointerUp(screen.getByRole("button"));

describe("HoldButton", () => {
  it("fires once the press outlasts the hold", () => {
    const onFire = vi.fn();
    render(<HoldButton onFire={onFire}>Launch</HoldButton>);
    press();
    vi.advanceTimersByTime(599);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledOnce();
  });

  it("spends nothing when the press is released early", () => {
    const onFire = vi.fn();
    render(<HoldButton onFire={onFire}>Launch</HoldButton>);
    press();
    vi.advanceTimersByTime(300);
    release();
    vi.advanceTimersByTime(1000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("does not fire after unmounting mid-hold", () => {
    const onFire = vi.fn();
    const { unmount } = render(<HoldButton onFire={onFire}>Launch</HoldButton>);
    press();
    unmount();
    vi.advanceTimersByTime(1000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("ignores a press while disabled", () => {
    const onFire = vi.fn();
    render(<HoldButton disabled onFire={onFire}>Launch</HoldButton>);
    press();
    vi.advanceTimersByTime(1000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("holds on Enter and cancels on release", () => {
    const onFire = vi.fn();
    render(<HoldButton onFire={onFire}>Launch</HoldButton>);
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
    vi.advanceTimersByTime(300);
    fireEvent.keyUp(screen.getByRole("button"), { key: "Enter" });
    vi.advanceTimersByTime(1000);
    expect(onFire).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
    vi.advanceTimersByTime(600);
    expect(onFire).toHaveBeenCalledOnce();
  });
});
