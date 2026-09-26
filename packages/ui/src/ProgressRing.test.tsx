import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProgressRing } from "./ProgressRing";

describe("ProgressRing", () => {
  it("reports progress as a percentage", () => {
    render(<ProgressRing pct={0.25}>25%</ProgressRing>);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  });

  it("clamps out-of-range values so the arc never overdraws", () => {
    const { rerender } = render(<ProgressRing pct={1.8} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    rerender(<ProgressRing pct={-0.5} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });
});
