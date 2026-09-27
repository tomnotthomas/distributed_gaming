import { forwardRef } from "react";
import type { ElementType, HTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import "./Surface.css";

type Props = HTMLAttributes<HTMLElement> & {
  /** The element to render — a card can be a button, a section, a list item. */
  as?: ElementType;
  padding?: "none" | "sm" | "md" | "lg";
  radius?: "md" | "lg" | "xl";
  strength?: "normal" | "strong";
};

/** The frosted glass every card, panel and pill sits on. */
export const Surface = forwardRef<HTMLElement, Props>(function Surface(
  { as: As = "div", padding = "md", radius = "lg", strength = "normal", className, ...rest },
  ref,
) {
  return (
    <As
      ref={ref}
      data-padding={padding}
      data-radius={radius}
      data-strength={strength}
      className={cx("surface glass", className)}
      {...rest}
    />
  );
});
