import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "./Icon";

describe("Icon", () => {
  it("hides itself from assistive tech unless labelled", () => {
    const { container, rerender } = render(<Icon name="play" />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    rerender(<Icon name="play" label="Play" />);
    expect(screen.getByRole("img", { name: "Play" })).toBeInTheDocument();
  });
});
