import type { HTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import "./Segment.css";

type Props<T extends string> = Omit<HTMLAttributes<HTMLDivElement>, "onChange"> & {
  name: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  /** Names the group for assistive tech; the visible label usually sits outside it. */
  "aria-label": string;
};

/**
 * One of a few. Native radios in a row: they come with arrow-key navigation and
 * a single tab stop, which a div-based segmented control has to reimplement.
 */
export function Segment<T extends string>({ name, options, value, onChange, className, ...rest }: Props<T>) {
  return (
    <div role="radiogroup" className={cx("seg glass", className)} {...rest}>
      {options.map((opt) => (
        <label key={opt.value} className={cx("seg-opt", opt.value === value && "seg-on")}>
          <input
            type="radio"
            name={name}
            checked={opt.value === value}
            onChange={() => onChange(opt.value)}
          />
          {opt.label}
        </label>
      ))}
    </div>
  );
}
