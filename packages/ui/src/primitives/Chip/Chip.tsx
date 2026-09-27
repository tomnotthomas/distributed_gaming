import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import "./Chip.css";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
  pressed: boolean;
  onPressedChange: (next: boolean) => void;
  /** An icon-only chip needs an aria-label. */
  icon?: ReactNode;
  size?: "sm" | "md";
};

/**
 * One choice in a row of choices — a GPU, a duration, a device. The caller owns
 * selection, so the same chip serves single- and multi-select rows.
 */
export const Chip = forwardRef<HTMLButtonElement, Props>(function Chip(
  { pressed, onPressedChange, icon, size = "md", children, className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={pressed}
      data-pressed={pressed ? "" : undefined}
      data-size={size}
      className={cx("chip", className)}
      {...rest}
      onClick={(event) => {
        rest.onClick?.(event);
        onPressedChange(!pressed);
      }}
    >
      {icon}
      {children}
    </button>
  );
});
