import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import "./ProgressRing.css";

type Props = HTMLAttributes<HTMLDivElement> & {
  /** 0 to 1. Clamped, because a stalled step must not draw past the circle. */
  pct: number;
  /** The accessible name: what is progressing. */
  label: string;
  size?: number;
  children?: ReactNode;
};

/**
 * The ignition ring. A conic gradient masked to an annulus: one element, no SVG
 * and no stroke maths, and the sweep animates because --swiff-a is a registered
 * angle property.
 */
export function ProgressRing({ pct, label, size = 120, children, className, style, ...rest }: Props) {
  const clamped = Math.min(1, Math.max(0, pct));
  return (
    <div
      className={cx("ring", className)}
      style={{ width: size, height: size, ...style }}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      {...rest}
    >
      <span className="ring-arc" style={{ ["--swiff-a" as string]: `${Math.round(clamped * 360)}deg` }} />
      <span className="ring-label">{children}</span>
    </div>
  );
}
