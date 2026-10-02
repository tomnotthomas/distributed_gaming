import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MotionContext } from "../../lib/motion";
import { Backdrop } from "./Backdrop";

describe("Backdrop", () => {
  it("shows a still when there is no video", () => {
    const { container } = render(<Backdrop image="a.jpg" />);
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector(".backdrop-still")).not.toBeNull();
  });

  it("plays the video when motion is on", () => {
    const { container } = render(<Backdrop image="a.jpg" video="clip.webm" />);
    expect(container.querySelector("video")).toHaveAttribute("poster", "a.jpg");
  });

  it("falls back to the still when motion is off, by prop or by context", () => {
    const { container, rerender } = render(<Backdrop image="a.jpg" video="clip.webm" motion={false} />);
    expect(container.querySelector("video")).toBeNull();
    rerender(
      <MotionContext.Provider value={false}>
        <Backdrop image="a.jpg" video="clip.webm" />
      </MotionContext.Provider>,
    );
    expect(container.querySelector("video")).toBeNull();
  });

  it("drifts the still instead of playing a video, and holds it when motion is off", () => {
    const { container, rerender } = render(<Backdrop image="a.jpg" drift />);
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector(".backdrop-still")).toHaveClass("backdrop-drift");
    rerender(
      <MotionContext.Provider value={false}>
        <Backdrop image="a.jpg" drift />
      </MotionContext.Provider>,
    );
    expect(container.querySelector(".backdrop-still")).not.toHaveClass("backdrop-drift");
    rerender(<Backdrop image="a.jpg" />);
    expect(container.querySelector(".backdrop-still")).not.toHaveClass("backdrop-drift");
  });

  it("paints the scrims it is asked for, in order", () => {
    const { container } = render(<Backdrop image="a.jpg" scrims={["pocket", "bottom"]} />);
    const scrims = [...container.querySelectorAll(".backdrop-scrim")].map((el) =>
      el.getAttribute("data-scrim"),
    );
    expect(scrims).toEqual(["pocket", "bottom"]);
  });
});
