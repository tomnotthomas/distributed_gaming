import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Meter } from "./Meter";

describe("Meter", () => {
  it("lights the given number of segments and always draws four", () => {
    render(<Meter label="Picture" value={3} />);
    const bars = screen.getByRole("img", { name: "Picture 3 of 4" });
    expect(bars.querySelectorAll(".meter-seg")).toHaveLength(4);
    expect(bars.querySelectorAll(".meter-on")).toHaveLength(3);
  });

  it("draws no lit segment at zero", () => {
    render(<Meter label="Response" value={0} />);
    const bars = screen.getByRole("img", { name: "Response 0 of 4" });
    expect(bars.querySelectorAll(".meter-on")).toHaveLength(0);
  });
});

describe("Meter max", () => {
  it("draws as many segments as max and says so", () => {
    render(<Meter label="Download" value={10} max={24} />);
    const bars = screen.getByRole("img", { name: "Download 10 of 24" });
    expect(bars.querySelectorAll(".meter-seg")).toHaveLength(24);
    expect(bars.querySelectorAll(".meter-on")).toHaveLength(10);
  });

  it("keeps a hidden label readable by assistive tech", () => {
    render(<Meter label="Picture" value={2} labelPosition="none" />);
    expect(screen.getByText("Picture")).toHaveClass("visually-hidden");
  });
});
