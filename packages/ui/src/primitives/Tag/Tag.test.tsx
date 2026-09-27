import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tag } from "./Tag";

describe("Tag", () => {
  it("renders the label/value form the RTC pages use", () => {
    const { container } = render(<Tag label="Room" value="demo" />);
    expect(container.firstElementChild).toHaveAttribute("class", "tag");
    expect(container.firstElementChild).toHaveAttribute("data-tone", "neutral");
    expect(screen.getByText("Room")).toHaveClass("tag-label");
    expect(screen.getByText("demo")).toBeInTheDocument();
  });

  it("keeps shape separate from colour", () => {
    const { container } = render(
      <Tag tone="time" variant="dashed">
        back at 21:30
      </Tag>,
    );
    expect(container.firstElementChild).toHaveAttribute("data-tone", "time");
    expect(container.firstElementChild).toHaveAttribute("data-variant", "dashed");
  });
});
