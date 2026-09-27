import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import "./Pill.css";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Muted prefix; the value is the children: <Pill label="Tonight">2 h</Pill>. */
  label: ReactNode;
  /** Trailing glyph. */
  icon?: ReactNode;
};

/** A small glass button that shows a setting and its value: "Tonight · 2 h". */
export const Pill = forwardRef<HTMLButtonElement, Props>(function Pill(
  { label, icon, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cx("pill glass", className)} {...rest}>
      <span className="pill-label">{label}</span>
      <span className="pill-value">{children}</span>
      {icon}
    </button>
  );
});
