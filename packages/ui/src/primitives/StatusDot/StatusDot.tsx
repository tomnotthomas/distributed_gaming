import type { HTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import type { Tone } from "../../lib/tone";
import "./StatusDot.css";

type Props = HTMLAttributes<HTMLSpanElement> & {
  tone?: Tone;
  /** Breathes, for a state that is still settling (connecting). */
  pulse?: boolean;
  size?: number;
  /** Without one the dot is decoration and hidden from assistive tech. */
  label?: string;
};

/** A glowing dot: live, connecting, failed. */
export function StatusDot({ tone = "live", pulse, size = 6, label, className, style, ...rest }: Props) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-tone={tone}
      data-pulse={pulse ? "" : undefined}
      className={cx("status-dot", className)}
      style={{ width: size, height: size, ...style }}
      {...rest}
    />
  );
}
