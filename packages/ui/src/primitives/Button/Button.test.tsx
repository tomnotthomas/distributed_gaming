import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";

describe("Button", () => {
  it("keeps the classes the app and e2e suite already rely on", () => {
    const { rerender } = render(<Button>Go</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("class", "btn btn-primary");
    rerender(<Button size="lg">Go</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("class", "btn btn-primary btn-lg");
    rerender(
      <Button variant="secondary" className="extra">
        Go
      </Button>,
    );
    expect(screen.getByRole("button")).toHaveAttribute("class", "btn btn-secondary extra");
  });

  it("renders an anchor with the same classes when given href", () => {
    render(
      <Button variant="ghost" href="https://store.steampowered.com">
        Browse Steam store
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Browse Steam store" });
    expect(link).toHaveAttribute("href", "https://store.steampowered.com");
    expect(link).toHaveClass("btn", "btn-ghost");
  });

  it("forwards clicks and refs", async () => {
    const onClick = vi.fn();
    const ref = { current: null as HTMLButtonElement | HTMLAnchorElement | null };
    render(
      <Button ref={ref} onClick={onClick}>
        Go
      </Button>,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
    expect(ref.current).toBe(screen.getByRole("button"));
  });
});
