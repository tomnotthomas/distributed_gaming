import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { Glyph, type GlyphName } from "./Glyph";
import { useHold } from "./hold";

type PillProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  children: ReactNode;
  icon: GlyphName;
  /** A cost, in brick: Ending early. */
  warn?: boolean;
  small?: boolean;
};

/** The outline pill with its icon in a ring: each screen's one action. */
export function Pill({ children, icon, warn, small, className, ...rest }: PillProps) {
  const classes = ["lpill", warn && "warn", small && "sm", className].filter(Boolean).join(" ");
  return (
    <button type="button" className={classes} {...rest}>
      {children}
      <span className="c">
        <Glyph name={icon} />
      </span>
    </button>
  );
}

/**
 * A pill that only acts on a held press, for what cannot be taken back: the
 * ring around its icon fills while held, and an early release drains it.
 */
export function HoldPill({
  children,
  icon,
  warn,
  onFire,
  label,
}: {
  children: ReactNode;
  icon: GlyphName;
  warn?: boolean;
  onFire: () => void;
  /** The accessible name, which says it is a hold. */
  label: string;
}) {
  const { phase, progress, handlers } = useHold({ onFire });
  return (
    <button
      type="button"
      className={["lpill", "held", warn && "warn"].filter(Boolean).join(" ")}
      aria-label={label}
      data-phase={phase}
      style={{ "--hold": progress.toFixed(4) } as CSSProperties}
      {...handlers}
    >
      {phase === "hold" ? "Keep holding" : children}
      <span className="c">
        <svg className="holdring" viewBox="0 0 40 40" aria-hidden="true">
          <circle
            cx={20}
            cy={20}
            r={19}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            pathLength={100}
            strokeDasharray="100 100"
            strokeDashoffset={(100 - progress * 100).toFixed(2)}
            transform="rotate(-90 20 20)"
          />
        </svg>
        <Glyph name={icon} />
      </span>
    </button>
  );
}
