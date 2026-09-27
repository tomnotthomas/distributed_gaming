import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import { Icon, type IconName } from "../Icon";
import "./IconButton.css";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  icon: IconName;
  /** The accessible name — there is no visible text. Also the tooltip. */
  label: string;
  shape?: "round" | "square";
  size?: "sm" | "md" | "lg";
  /** Set for a toggle; leave undefined for a plain action. */
  pressed?: boolean;
};

const GLYPH = { sm: 16, md: 18, lg: 20 };

/** A glass button holding one glyph: back, close, a device toggle. */
export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton(
  { icon, label, shape = "round", size = "md", pressed, className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      data-shape={shape}
      data-size={size}
      data-pressed={pressed ? "" : undefined}
      className={cx("icon-btn glass", className)}
      {...rest}
    >
      <Icon name={icon} size={GLYPH[size]} />
    </button>
  );
});
