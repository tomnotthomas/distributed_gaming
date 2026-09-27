import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SplitButton } from "./SplitButton";

describe("SplitButton", () => {
  it("reflects expanded on the toggle and reports clicks", async () => {
    const onToggle = vi.fn();
    render(
      <SplitButton expanded={false} onToggle={onToggle} toggleLabel="Choose a different machine">
        <button>Launch</button>
      </SplitButton>,
    );
    const toggle = screen.getByRole("button", { name: "Choose a different machine" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
