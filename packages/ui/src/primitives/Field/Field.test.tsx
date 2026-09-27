import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field } from "./Field";

describe("Field", () => {
  it("sends input props to the input and root props to the label", () => {
    render(
      <Field
        label="Signaling server"
        id="sig"
        placeholder="ws://…"
        className="wide"
        data-testid="sig-field"
        defaultValue="ws://localhost"
      />,
    );
    const input = screen.getByLabelText("Signaling server");
    expect(input).toHaveAttribute("placeholder", "ws://…");
    expect(input).toHaveValue("ws://localhost");
    expect(input).toHaveClass("input");
    expect(screen.getByTestId("sig-field")).toHaveClass("field", "wide");
    expect(screen.getByTestId("sig-field").tagName).toBe("LABEL");
  });
});
