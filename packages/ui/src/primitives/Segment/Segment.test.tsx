import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Segment } from "./Segment";

const options = [
  { value: "auto", label: "Best available" },
  { value: "fps", label: "Prefer 120 fps" },
] as const;

describe("Segment", () => {
  it("checks exactly the selected option", () => {
    render(<Segment name="pq" aria-label="Picture" options={options} value="fps" onChange={() => {}} />);
    expect(screen.getByRole("radio", { name: "Prefer 120 fps" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Best available" })).not.toBeChecked();
  });

  it("reports the chosen value", async () => {
    const onChange = vi.fn();
    render(<Segment name="pq" aria-label="Picture" options={options} value="auto" onChange={onChange} />);
    await userEvent.click(screen.getByRole("radio", { name: "Prefer 120 fps" }));
    expect(onChange).toHaveBeenCalledWith("fps");
  });

  it("names the group", () => {
    render(<Segment name="pq" aria-label="Picture" options={options} value="auto" onChange={() => {}} />);
    expect(screen.getByRole("radiogroup", { name: "Picture" })).toBeInTheDocument();
  });
});
