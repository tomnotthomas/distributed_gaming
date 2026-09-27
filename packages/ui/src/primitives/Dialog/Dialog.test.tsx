import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";

const actions = (
  <>
    <button>Keep playing</button>
    <button>End session</button>
  </>
);

describe("Dialog", () => {
  it("is a labelled modal dialog", () => {
    render(<Dialog title="The owner needs their PC" actions={actions}>Body</Dialog>);
    expect(screen.getByRole("dialog", { name: "The owner needs their PC" })).toHaveAttribute("aria-modal", "true");
  });

  it("moves focus to the first action on open and returns it on close", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<Dialog title="T" actions={actions}>Body</Dialog>);
    expect(screen.getByRole("button", { name: "Keep playing" })).toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("traps Tab inside the panel", async () => {
    render(<Dialog title="T" actions={actions}>Body</Dialog>);
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "End session" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Keep playing" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "End session" })).toHaveFocus();
  });

  it("dismisses on Escape and backdrop click only when it can be dismissed", async () => {
    const onDismiss = vi.fn();
    const { container, rerender } = render(<Dialog title="T" actions={actions}>Body</Dialog>);
    await userEvent.keyboard("{Escape}");
    fireEvent.click(container.querySelector(".dialog-backdrop")!);
    expect(onDismiss).not.toHaveBeenCalled();

    rerender(<Dialog title="T" actions={actions} onDismiss={onDismiss}>Body</Dialog>);
    await userEvent.keyboard("{Escape}");
    fireEvent.click(container.querySelector(".dialog-backdrop")!);
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("ignores clicks inside the panel", () => {
    const onDismiss = vi.fn();
    render(<Dialog title="T" actions={actions} onDismiss={onDismiss}>Body</Dialog>);
    fireEvent.click(screen.getByText("Body"));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
