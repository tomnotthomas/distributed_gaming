import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KeyValueList } from "./KeyValueList";

describe("KeyValueList", () => {
  it("renders one term/value pair per row and marks the total", () => {
    const { container } = render(
      <KeyValueList
        rows={[
          { term: "Hours shared", value: "42 h" },
          { term: "Rate", value: "€0.40", indent: true },
          { term: "This month", value: "€16.80", emphasis: true },
        ]}
      />,
    );
    expect(container.querySelectorAll("dt")).toHaveLength(3);
    expect(screen.getByText("€16.80").parentElement).toHaveAttribute("data-emphasis");
    expect(screen.getByText("Rate").parentElement).toHaveAttribute("data-indent");
  });
});
