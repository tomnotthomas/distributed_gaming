import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Sheet } from "./Sheet";

describe("Sheet", () => {
  it("closes from its close button, Escape and the backdrop", async () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <Sheet title="How we got this number" closeLabel="Close" onDismiss={onDismiss}>
        Body
      </Sheet>,
    );
    expect(screen.getByRole("dialog", { name: "How we got this number" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.keyboard("{Escape}");
    fireEvent.click(container.querySelector(".sheet-backdrop")!);
    expect(onDismiss).toHaveBeenCalledTimes(3);
  });
});
