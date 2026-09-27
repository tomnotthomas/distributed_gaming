import type { CSSProperties, HTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import "./Mosaic.css";

type Props = HTMLAttributes<HTMLDivElement> & {
  /** Height of one grid row in px. */
  rowHeight?: number;
  /**
   * `horizontal` turns the grid into a sideways strip once the container is
   * ultra-wide. Container queries, not viewport ones, so the same wall works in
   * a panel or a preview frame.
   */
  layout?: "grid" | "horizontal";
};

/**
 * The dense wall grid. Children size themselves with
 * data-span="hero" (4×2), "wide" (2×1) or "small" (1×1).
 */
export function Mosaic({ rowHeight = 190, layout = "grid", className, children, ...rest }: Props) {
  return (
    <div className={cx("mosaic-frame", className)} {...rest}>
      <div className="mosaic" data-layout={layout} style={{ ["--mosaic-row" as string]: `${rowHeight}px` } as CSSProperties}>
        {children}
      </div>
    </div>
  );
}
