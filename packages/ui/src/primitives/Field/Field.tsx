import type { LabelHTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import "./Field.css";

type Props = LabelHTMLAttributes<HTMLLabelElement> & {
  label: ReactNode;
  hint?: ReactNode;
  /** The control — usually an Input. Wrapping it labels it, no id needed. */
  children: ReactNode;
};

/** A visible label and an optional hint around one control. */
export function Field({ label, hint, children, className, ...rest }: Props) {
  return (
    <label className={cx("field", className)} {...rest}>
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}
