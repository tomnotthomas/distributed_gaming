import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import { Button } from "../Button";
import { Icon } from "../Icon";
import "./SplitButton.css";

type Props = HTMLAttributes<HTMLDivElement> & {
  /** The main action — usually a HoldButton. It carries the size; the chevron stretches to match. */
  children: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  /** Accessible name for the chevron half, e.g. "Choose a different machine". */
  toggleLabel: string;
};

/**
 * A main action with an attached chevron that opens more choices. The two
 * halves share one outline, so they read as one control with two targets.
 */
export function SplitButton({ children, expanded, onToggle, toggleLabel, className, ...rest }: Props) {
  return (
    <div role="group" className={cx("split-btn", className)} {...rest}>
      {children}
      <Button
        className="split-btn-toggle"
        onClick={onToggle}
        aria-label={toggleLabel}
        aria-expanded={expanded}
        data-expanded={expanded ? "" : undefined}
        icon={<Icon name="caret-down" size={16} />}
      />
    </div>
  );
}
