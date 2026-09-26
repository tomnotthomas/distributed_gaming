import type { ReactNode } from "react";

type Tone = "neutral" | "accent" | "outline" | "live" | "time";

type Props = {
  /** Label/value form: the room id both RTC peers must show. */
  label?: string;
  value?: string;
  children?: ReactNode;
  /** `live` for a free machine, `time` for a window that is running out. */
  tone?: Tone;
};

/** A labelled pill. Five tones cover every badge the wall and HUD need. */
export function Tag({ label, value, children, tone = "neutral" }: Props) {
  return (
    <span className={`tag tag-${tone}`}>
      {label ? <span className="tag-label">{label}</span> : null}
      {value ?? children}
    </span>
  );
}
