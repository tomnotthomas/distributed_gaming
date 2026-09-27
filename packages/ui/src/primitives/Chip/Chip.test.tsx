import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Chip } from "./Chip";

describe("Chip", () => {
  it("reports the next pressed state", async () => {
    const onPressedChange = vi.fn();
    const { rerender } = render(
      <Chip pressed={false} onPressedChange={onPressedChange}>
        RTX 4080
      </Chip>,
    );
    const chip = screen.getByRole("button", { name: "RTX 4080" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(chip);
    expect(onPressedChange).toHaveBeenLastCalledWith(true);

    rerender(
      <Chip pressed onPressedChange={onPressedChange}>
        RTX 4080
      </Chip>,
    );
    expect(chip).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(chip);
    expect(onPressedChange).toHaveBeenLastCalledWith(false);
  });
});
