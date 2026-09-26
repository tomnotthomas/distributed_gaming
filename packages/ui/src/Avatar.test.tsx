import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar } from "./Avatar";

describe("Avatar", () => {
  it("takes the gradient only at profile size", () => {
    const { rerender } = render(<Avatar initial="K" size={32} />);
    expect(screen.getByText("K").className).toBe("avatar");
    rerender(<Avatar initial="K" size={72} />);
    expect(screen.getByText("K").className).toContain("avatar-lg");
  });

  it("exposes the ring as data so one class carries both meanings", () => {
    render(<Avatar initial="K" ring="live" />);
    expect(screen.getByText("K")).toHaveAttribute("data-ring", "live");
  });
});
