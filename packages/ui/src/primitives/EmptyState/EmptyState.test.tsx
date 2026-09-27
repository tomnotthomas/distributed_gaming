import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("offers the action it is given", () => {
    render(<EmptyState title="Nothing is ready right now" action={<button>Show everything</button>} />);
    expect(screen.getByRole("heading", { name: "Nothing is ready right now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show everything" })).toBeInTheDocument();
  });
});
