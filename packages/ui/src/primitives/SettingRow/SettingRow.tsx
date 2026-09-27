import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import "./SettingRow.css";

type Props = Omit<HTMLAttributes<HTMLElement>, "children"> & {
  label: ReactNode;
  hint?: ReactNode;
  /** The control: a native checkbox, a Segment, a row of Chips. */
  control: ReactNode;
  /**
   * `inline` puts the control beside the text and makes the whole row its label,
   * so clicking the text flips a checkbox. `stacked` puts it below — for controls
   * that carry their own labels, like a Segment.
   */
  layout?: "inline" | "stacked";
};

/** One setting: what it is, what it does, and the control that changes it. */
export function SettingRow({ label, hint, control, layout = "inline", className, ...rest }: Props) {
  const text = (
    <span className="setting-text">
      <span className="setting-label">{label}</span>
      {hint ? <span className="setting-hint">{hint}</span> : null}
    </span>
  );
  if (layout === "inline") {
    return (
      <label data-layout="inline" className={cx("setting", className)} {...rest}>
        {text}
        {control}
      </label>
    );
  }
  return (
    <div data-layout="stacked" className={cx("setting", className)} {...rest}>
      {text}
      {control}
    </div>
  );
}
