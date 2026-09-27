import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import type { Tone } from "../../lib/tone";
import "./Kicker.css";

type Props = HTMLAttributes<HTMLElement> & {
  children: ReactNode;
  /** A section's eyebrow is often its heading; render it as one. */
  as?: "span" | "h2" | "h3" | "p";
  tone?: Tone;
  /** Leading mark — a StatusDot, an Icon. */
  icon?: ReactNode;
};

/** The small uppercase eyebrow above a section or headline. */
export function Kicker({ children, tone = "accent", icon, as: As = "span", className, ...rest }: Props) {
  return (
    <As data-tone={tone} className={cx("kicker", className)} {...rest}>
      {icon}
      {children}
    </As>
  );
}
