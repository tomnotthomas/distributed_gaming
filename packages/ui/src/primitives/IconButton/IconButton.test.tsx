import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IconButton } from "./IconButton";

describe("IconButton", () => {
  it("names itself from the label and exposes pressed state", () => {
    const { rerender } = render(<IconButton icon="keyboard" label="Keyboard" />);
    const button = screen.getByRole("button", { name: "Keyboard" });
    expect(button).not.toHaveAttribute("aria-pressed");
    rerender(<IconButton icon="keyboard" label="Keyboard" pressed />);
    expect(button).toHaveAttribute("aria-pressed", "true");
  });
});
