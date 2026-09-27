import type { CSSProperties, InputHTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import "./Field.css";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "style"> & {
  label: string;
  hint?: string;
  className?: string;
  style?: CSSProperties;
};

/**
 * A labelled text input. The one exception to the primitive contract:
 * `className`, `style` and `data-*` land on the root label, but every other prop
 * still goes to the <input> — the Electron host's signaling-address field
 * passes value, onChange and placeholder straight through.
 */
export function Field({ label, hint, id, className, style, ...rest }: Props) {
  const data: Record<string, unknown> = {};
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) (key.startsWith("data-") ? data : input)[key] = value;
  return (
    <label className={cx("field", className)} htmlFor={id} style={style} {...data}>
      <span className="field-label">{label}</span>
      <input {...input} id={id} className="input" />
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}
