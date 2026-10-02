import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Chrome, initials } from "./Chrome";

const noop = () => {};

describe("Chrome", () => {
  it("opens Share your PC from the top bar", () => {
    const onShare = vi.fn();
    render(<Chrome screen="home" onHome={noop} onProfile={noop} onShare={onShare} live="4 free near you" />);
    fireEvent.click(screen.getByRole("button", { name: "Share your PC" }));
    expect(onShare).toHaveBeenCalledOnce();
  });

  it("marks the screen that is up", () => {
    const { rerender } = render(
      <Chrome screen="home" onHome={noop} onProfile={noop} onShare={noop} live="4 free near you" />,
    );
    // The wordmark is a Home button too; the nav cell is the one that marks the screen.
    const nav = () => within(screen.getByRole("navigation"));
    expect(nav().getByRole("button", { name: "Home" })).toHaveAttribute("aria-current", "page");
    expect(nav().getByRole("button", { name: "Share your PC" })).not.toHaveAttribute("aria-current");

    rerender(<Chrome screen="share" onHome={noop} onProfile={noop} onShare={noop} live="4 free near you" />);
    expect(nav().getByRole("button", { name: "Share your PC" })).toHaveAttribute("aria-current", "page");
    expect(nav().getByRole("button", { name: "Home" })).not.toHaveAttribute("aria-current");
  });
});

describe("initials", () => {
  it("takes the first letter and the first after a separator", () => {
    expect(initials("kai_nx")).toBe("KN");
    expect(initials("sable")).toBe("S");
  });
});
