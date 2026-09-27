import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProgressRing } from "./ProgressRing";

describe("ProgressRing", () => {
  it("reports progress as a percentage", () => {
    render(<ProgressRing label="Starting" pct={0.25}>25%</ProgressRing>);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  });

  it("clamps out-of-range values so the arc never overdraws", () => {
    const { rerender } = render(<ProgressRing label="Starting" pct={1.8} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    rerender(<ProgressRing label="Starting" pct={-0.5} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });

  it("takes its accessible name from the label", () => {
    render(<ProgressRing label="Starting Moss" pct={0.5} />);
    expect(screen.getByRole("progressbar", { name: "Starting Moss" })).toBeInTheDocument();
  });
});
