import type { HTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import "./Meter.css";

type Props = HTMLAttributes<HTMLDivElement> & {
  label: string;
  value: number;
  /** Segment count. Four for Picture/Response; the Host download bar uses 24. */
  max?: number;
  /** `none` keeps the label for assistive tech only. */
  labelPosition?: "top" | "inline" | "none";
};

/**
 * Segments, however many are lit. A player reads "three of four bars" faster
 * than "1440p 120".
 */
export function Meter({ label, value, max = 4, labelPosition = "top", className, ...rest }: Props) {
  return (
    <div className={cx("meter", className)} data-label={labelPosition} {...rest}>
      <span className={cx("meter-label", labelPosition === "none" && "visually-hidden")}>{label}</span>
      <div className="meter-bars" role="img" aria-label={`${label} ${value} of ${max}`}>
        {Array.from({ length: max }, (_, i) => (
          <span key={i} className={cx("meter-seg", i < value && "meter-on")} />
        ))}
      </div>
    </div>
  );
}
