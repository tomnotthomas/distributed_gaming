import { useRef } from "react";
import type { CSSProperties, HTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import "./Mosaic.css";

type Props = HTMLAttributes<HTMLDivElement> & {
  /** Height of one grid row in px (grid layout). */
  rowHeight?: number;
  /**
   * `grid`: the dense 4-column wall. `horizontal`: the ultra-wide strip — the
   * hero a full-height column on the left, every other tile a square in two
   * rows that scroll sideways (wheel or drag). The strip fills the height its
   * parent gives it, so put it in a flex column; the screen decides when to use it.
   */
  layout?: "grid" | "horizontal";
};

/** How far a press has to travel before it counts as a drag rather than a click. */
const DRAG_THRESHOLD = 6;

/**
 * The dense wall grid. Children size themselves with
 * data-span="hero" (4×2), "wide" (2×1) or "small" (1×1).
 */
export function Mosaic({ rowHeight = 190, layout = "grid", className, children, ...rest }: Props) {
  const strip = layout === "horizontal";
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);

  return (
    <div className={cx("mosaic-frame", className)} data-layout={layout} {...rest}>
      <div
        className="mosaic"
        data-layout={layout}
        style={{ ["--mosaic-row" as string]: `${rowHeight}px` } as CSSProperties}
        // As a strip, a vertical wheel scrolls sideways and the wall can be
        // dragged like a shelf. A drag must not also open the tile it ended on.
        onWheel={(event) => {
          if (!strip || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
          event.currentTarget.scrollLeft += event.deltaY;
        }}
        onPointerDown={(event) => {
          if (!strip || event.pointerType !== "mouse" || event.button !== 0) return;
          drag.current = { x: event.clientX, left: event.currentTarget.scrollLeft, moved: false };
        }}
        onPointerMove={(event) => {
          const state = drag.current;
          if (!state) return;
          const dx = event.clientX - state.x;
          if (Math.abs(dx) > DRAG_THRESHOLD) state.moved = true;
          if (state.moved) event.currentTarget.scrollLeft = state.left - dx;
        }}
        // Keep `moved` until the click that follows this pointerup has been swallowed.
        onPointerUp={() => setTimeout(() => (drag.current = null))}
        onPointerLeave={() => (drag.current = null)}
        onClickCapture={(event) => {
          if (!drag.current?.moved) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {children}
      </div>
    </div>
  );
}
