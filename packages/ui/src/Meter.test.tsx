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
