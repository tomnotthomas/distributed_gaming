import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingRow } from "./SettingRow";

describe("SettingRow", () => {
  it("makes the whole inline row the checkbox's label", async () => {
    const onChange = vi.fn();
    render(
      <SettingRow
        label="Motion on the wall"
        hint="Off shows stills."
        control={<input type="checkbox" checked={false} onChange={(e) => onChange(e.target.checked)} />}
      />,
    );
    await userEvent.click(screen.getByText("Motion on the wall"));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("checkbox", { name: /Motion on the wall/ })).toBeInTheDocument();
  });

  it("does not wrap a stacked control in a label, so its own labels stay separate", () => {
    const { container } = render(
      <SettingRow layout="stacked" label="Picture" control={<button>x</button>} />,
    );
    expect(container.querySelector("label")).toBeNull();
    expect(container.firstElementChild).toHaveAttribute("data-layout", "stacked");
  });
});
