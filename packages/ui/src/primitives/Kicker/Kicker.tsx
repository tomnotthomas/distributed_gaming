import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import type { Tone } from "../../lib/tone";
import "./Kicker.css";

type Props = HTMLAttributes<HTMLSpanElement> & {
  children: ReactNode;
  tone?: Tone;
  /** Leading mark — a StatusDot, an Icon. */
  icon?: ReactNode;
};

/** The small uppercase eyebrow above a section or headline. */
export function Kicker({ children, tone = "accent", icon, className, ...rest }: Props) {
  return (
    <span data-tone={tone} className={cx("kicker", className)} {...rest}>
      {icon}
      {children}
    </span>
  );
}
