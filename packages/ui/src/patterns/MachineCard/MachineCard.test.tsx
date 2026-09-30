import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MachineCard } from "./MachineCard";

const base = {
  name: "Glasshouse",
  ping: 9,
  owner: "shared by m0th",
  picture: 4,
  response: 4,
  left: "4 h left",
};

describe("MachineCard", () => {
  it("shows both meters and marks the selected card for assistive tech", () => {
    render(<MachineCard {...base} selected onPick={() => {}} />);
    expect(screen.getByRole("img", { name: "Picture 4 of 4" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Response 4 of 4" })).toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });

  it("drops the reason tag when there is no reason to give", () => {
    const { rerender } = render(<MachineCard {...base} onPick={() => {}} />);
    expect(screen.queryByText("Lowest latency")).not.toBeInTheDocument();
    rerender(<MachineCard {...base} reason="Lowest latency" onPick={() => {}} />);
    expect(screen.getByText("Lowest latency")).toBeInTheDocument();
  });

  it("picks on click", async () => {
    const onPick = vi.fn();
    render(<MachineCard {...base} onPick={onPick} />);
    await userEvent.click(screen.getByRole("button"));
    expect(onPick).toHaveBeenCalledOnce();
  });
});
