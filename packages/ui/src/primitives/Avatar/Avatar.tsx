import type { HTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import "./Avatar.css";

type Props = HTMLAttributes<HTMLSpanElement> & {
  initial: string;
  /** 22 in the owner stack, 32 in the header, 72 on the profile. */
  size?: number;
  /** `live` is the ring that means "your machine is sharing right now". */
  ring?: "live" | "idle" | "none";
  /** An owner's own colour. Deliberately not `tone`: it carries identity, not state. */
  hue?: string;
};

/**
 * The initial-in-a-circle used at three sizes. Above 64px it takes the gradient
 * and glow: at profile size a flat fill reads as a placeholder rather than you.
 */
export function Avatar({ initial, size = 32, ring = "none", hue, className, style, ...rest }: Props) {
  return (
    <span
      className={cx("avatar", size >= 64 && "avatar-lg", className)}
      data-ring={ring}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38), ...(hue ? { background: hue } : null), ...style }}
      {...rest}
    >
      {initial}
    </span>
  );
}
