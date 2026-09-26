import type { ReactNode } from "react";

type Props = {
  /** 0 to 1. Clamped, because a stalled step must not draw past the circle. */
  pct: number;
  size?: number;
  children?: ReactNode;
};

/**
 * The ignition ring. A conic gradient masked to an annulus: one element, no SVG
 * and no stroke maths, and the sweep animates because --swiff-a is a registered
 * angle property (see ui.css).
 */
export function ProgressRing({ pct, size = 120, children }: Props) {
  const clamped = Math.min(1, Math.max(0, pct));
  return (
    <div
      className="ring"
      style={{ width: size, height: size }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
    >
      <span
        className="ring-arc"
        style={{ ["--swiff-a" as string]: `${Math.round(clamped * 360)}deg` }}
      />
      <span className="ring-label">{children}</span>
    </div>
  );
}
