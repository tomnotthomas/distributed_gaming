import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import "./Pill.css";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: ReactNode;
  value: ReactNode;
  /** Trailing glyph. */
  icon?: ReactNode;
};

/** A small glass button that shows a setting and its value: "Tonight · 2 h". */
export const Pill = forwardRef<HTMLButtonElement, Props>(function Pill(
  { label, value, icon, className, type = "button", ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cx("pill glass", className)} {...rest}>
      <span className="pill-label">{label}</span>
      <span className="pill-value">{value}</span>
      {icon}
    </button>
  );
});
