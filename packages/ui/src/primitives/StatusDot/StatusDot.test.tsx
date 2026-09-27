import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusDot } from "./StatusDot";

describe("StatusDot", () => {
  it("is decoration unless labelled", () => {
    const { container, rerender } = render(<StatusDot />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    rerender(<StatusDot tone="danger" label="Failed" />);
    expect(screen.getByRole("img", { name: "Failed" })).toHaveAttribute("data-tone", "danger");
  });
});
