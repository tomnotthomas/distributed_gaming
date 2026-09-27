import { useRef } from "react";
import type { CSSProperties, HTMLAttributes, PointerEvent as ReactPointerEvent } from "react";
import { cx } from "../../lib/cx";
import "./Mosaic.css";

type Props = HTMLAttributes<HTMLDivElement> & {
  /** Height of one grid row in px. */
  rowHeight?: number;
  /**
   * `horizontal` turns the grid into a sideways strip once the container is
   * ultra-wide (2150px and up): the hero fills the left edge at full height and
   * the rest scroll sideways in two rows. Container queries, not viewport ones,
   * so the same wall works in a panel or a preview frame. The strip's height
   * comes from `--mosaic-strip-height` (default: the viewport less the chrome).
   */
  layout?: "grid" | "horizontal";
};

/** How far a press has to travel before it counts as a drag rather than a click. */
const DRAG_THRESHOLD = 6;

const isStrip = (el: HTMLElement) => el.scrollWidth > el.clientWidth && getComputedStyle(el).gridAutoFlow.startsWith("column");

/**
 * The dense wall grid. Children size themselves with
 * data-span="hero" (4×2), "wide" (2×1) or "small" (1×1).
 */
export function Mosaic({ rowHeight = 190, layout = "grid", className, children, ...rest }: Props) {
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);

  // As a strip, the wall scrolls sideways: a vertical wheel moves it, and it can
  // be dragged like a shelf. A drag must not also open the tile it ended on.
  const strip =
    layout === "horizontal"
      ? {
          onWheel: (event: React.WheelEvent<HTMLDivElement>) => {
            const el = event.currentTarget;
            if (!isStrip(el) || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
            el.scrollLeft += event.deltaY;
          },
          onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
            if (event.pointerType !== "mouse" || event.button !== 0 || !isStrip(event.currentTarget)) return;
            drag.current = { x: event.clientX, left: event.currentTarget.scrollLeft, moved: false };
          },
          onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
            const state = drag.current;
            if (!state) return;
            const dx = event.clientX - state.x;
            if (Math.abs(dx) > DRAG_THRESHOLD) state.moved = true;
            if (state.moved) event.currentTarget.scrollLeft = state.left - dx;
          },
          onPointerUp: () => {
            // Keep `moved` until the click that follows this pointerup has been swallowed.
            setTimeout(() => (drag.current = null));
          },
          onPointerLeave: () => (drag.current = null),
          onClickCapture: (event: React.MouseEvent) => {
            if (drag.current?.moved) {
              event.preventDefault();
              event.stopPropagation();
            }
          },
        }
      : {};

  return (
    <div className={cx("mosaic-frame", className)} {...rest}>
      <div
        className="mosaic"
        data-layout={layout}
        style={{ ["--mosaic-row" as string]: `${rowHeight}px` } as CSSProperties}
        {...strip}
      >
        {children}
      </div>
    </div>
  );
}
