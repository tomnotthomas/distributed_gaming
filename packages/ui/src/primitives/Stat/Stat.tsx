import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import "./Stat.css";

type Props = HTMLAttributes<HTMLDivElement> & {
  label: ReactNode;
  value: ReactNode;
  align?: "start" | "end";
  size?: "md" | "lg" | "xl";
};

/** A small label over a big number: the session clock, "This month so far". */
export function Stat({ label, value, align = "start", size = "md", className, ...rest }: Props) {
  return (
    <div data-align={align} data-size={size} className={cx("stat", className)} {...rest}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}
