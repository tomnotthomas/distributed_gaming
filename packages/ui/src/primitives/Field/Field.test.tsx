import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Input } from "../Input";
import { Field } from "./Field";

describe("Field", () => {
  it("labels the control it wraps and shows the hint", () => {
    render(
      <Field label="Signaling server" hint="Paste it exactly as given.">
        <Input placeholder="ws://…" defaultValue="ws://localhost" />
      </Field>,
    );
    const input = screen.getByLabelText(/Signaling server/);
    expect(input).toHaveAttribute("placeholder", "ws://…");
    expect(input).toHaveValue("ws://localhost");
    expect(screen.getByText("Paste it exactly as given.")).toHaveClass("field-hint");
  });
});
