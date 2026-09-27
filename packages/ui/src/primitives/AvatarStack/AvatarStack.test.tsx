import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AvatarStack } from "./AvatarStack";

const people = ["A", "B", "C", "D", "E"].map((initial) => ({ initial }));

describe("AvatarStack", () => {
  it("shows up to max avatars and counts the rest", () => {
    render(<AvatarStack people={people} max={3} label="Owners" />);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.queryByText("D")).not.toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("drops the overflow bubble when everyone fits", () => {
    render(<AvatarStack people={people.slice(0, 2)} label="Owners" />);
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Owners" })).toBeInTheDocument();
  });
});
