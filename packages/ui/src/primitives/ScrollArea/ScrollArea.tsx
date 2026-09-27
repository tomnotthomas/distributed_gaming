import { forwardRef } from "react";
import type { HTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import "./ScrollArea.css";

type Props = HTMLAttributes<HTMLDivElement> & { axis?: "y" | "x" };

/** A region that scrolls on its own, with the library's thin scrollbar. */
export const ScrollArea = forwardRef<HTMLDivElement, Props>(function ScrollArea(
  { axis = "y", className, ...rest },
  ref,
) {
  return <div ref={ref} data-axis={axis} className={cx("scroll-area ui-scroll", className)} {...rest} />;
});
