import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import type { Tone } from "../../lib/tone";
import "./Tag.css";

type Props = HTMLAttributes<HTMLSpanElement> & {
  /** A muted prefix before the value: <Tag label="Room">demo</Tag>. */
  label?: string;
  children?: ReactNode;
  /** `live` for a free machine, `time` for a window that is running out. */
  tone?: Tone;
  /** Shape, independent of colour: filled glass, a plain outline, or dashed. */
  variant?: "solid" | "outline" | "dashed";
  size?: "sm" | "md";
};

/** A labelled pill for badges, stats and time notes. */
export function Tag({ label, children, tone = "neutral", variant = "solid", size = "md", className, ...rest }: Props) {
  return (
    <span data-tone={tone} data-variant={variant} data-size={size} className={cx("tag", className)} {...rest}>
      {label ? <span className="tag-label">{label}</span> : null}
      {children}
    </span>
  );
}
