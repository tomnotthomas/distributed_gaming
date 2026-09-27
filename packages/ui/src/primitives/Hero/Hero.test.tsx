import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Hero } from "./Hero";

describe("Hero", () => {
  it("renders the title at the heading level it is given", () => {
    const { rerender } = render(<Hero title="Moss" />);
    expect(screen.getByRole("heading", { level: 1, name: "Moss" })).toBeInTheDocument();
    rerender(<Hero title="Moss" as="h2" />);
    expect(screen.getByRole("heading", { level: 2, name: "Moss" })).toBeInTheDocument();
  });

  it("leaves out the slots it is not given", () => {
    const { container } = render(<Hero title="Moss" body="A mouse with a sword." />);
    expect(container.querySelector('[data-part="meta"]')).toBeNull();
    expect(container.querySelector('[data-part="actions"]')).toBeNull();
    expect(screen.getByText("A mouse with a sword.")).toBeInTheDocument();
  });
});
