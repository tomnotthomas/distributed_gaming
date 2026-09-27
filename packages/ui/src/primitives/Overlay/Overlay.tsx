import { forwardRef } from "react";
import type { HTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import "./Overlay.css";

type Props = HTMLAttributes<HTMLDivElement> & {
  /** The breathing accent glow behind the content. */
  glow?: boolean;
};

/** A full-screen blurred layer with its content stacked in the centre. */
export const Overlay = forwardRef<HTMLDivElement, Props>(function Overlay(
  { glow, className, children, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={cx("overlay", className)} {...rest}>
      {glow ? <div className="overlay-glow" aria-hidden="true" /> : null}
      <div className="overlay-stack">{children}</div>
    </div>
  );
});
