import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import { Icon } from "../Icon";
import "./Stepper.css";

type Props = HTMLAttributes<HTMLOListElement> & {
  steps: readonly ReactNode[];
  /** Index of the step in progress; earlier steps show as done. */
  current: number;
};

/** Numbered steps across a flow: where you are, what is done. */
export function Stepper({ steps, current, className, ...rest }: Props) {
  return (
    <ol className={cx("stepper", className)} {...rest}>
      {steps.map((step, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li key={i} data-state={state} aria-current={i === current ? "step" : undefined}>
            <span className="stepper-mark">{state === "done" ? <Icon name="check" size={12} /> : i + 1}</span>
            <span className="stepper-label">{step}</span>
          </li>
        );
      })}
    </ol>
  );
}
