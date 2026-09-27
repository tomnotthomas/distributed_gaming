import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Notice } from "./Notice";

describe("Notice", () => {
  it("announces errors as alerts and information as status", () => {
    const { rerender } = render(<Notice>Capture denied</Notice>);
    expect(screen.getByRole("alert")).toHaveTextContent("Capture denied");
    rerender(<Notice tone="neutral">Saved</Notice>);
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });
});
