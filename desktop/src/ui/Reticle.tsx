import type { CSSProperties } from "react";
import { Glyph } from "./Glyph";
import { useHold, type HoldPhase } from "./hold";

const LABEL: Record<HoldPhase, [string, string]> = {
  idle: ["Hold to", "go live"],
  hold: ["Keep", "holding"],
  done: ["Going", "live"],
};

/**
 * Go live is a physical act at the machine: press and hold the reticle until
 * its ring fills. Releasing early drains it and nothing starts. While the
 * screen is being asked for it stays on "Going live" and takes no new press.
 */
export function Reticle({
  onFire,
  disabled,
  starting,
}: {
  onFire: () => void;
  /** Nothing to go live with: the connection details are missing. */
  disabled?: boolean;
  starting?: boolean;
}) {
  const { phase, progress, handlers } = useHold({ onFire, disabled: disabled || starting });
  const shown: HoldPhase = starting ? "done" : phase;
  const fill = starting ? 1 : progress;
  const [line1, line2] = disabled ? ["Add", "details"] : LABEL[shown];

  return (
    <button
      type="button"
      className="reticle"
      data-phase={shown}
      disabled={disabled || starting}
      aria-label="Hold to go live"
      style={{ "--hold": fill.toFixed(4) } as CSSProperties}
      {...handlers}
    >
      <svg viewBox="0 0 200 200" aria-hidden="true" fill="none">
        <path d="M100 2V22M100 178V198M2 100H22M178 100H198" stroke="currentColor" opacity={0.6} />
        <circle cx={100} cy={100} r={74} stroke="currentColor" opacity={0.18} />
        <circle
          className="reticle-arc"
          cx={100}
          cy={100}
          r={74}
          stroke="currentColor"
          strokeWidth={2.4}
          pathLength={100}
          strokeDasharray="100 100"
          strokeDashoffset={(100 - fill * 100).toFixed(2)}
          transform="rotate(-90 100 100)"
        />
        <circle className="reticle-face" cx={100} cy={100} r={64} stroke="currentColor" />
        <circle cx={100} cy={100} r={56} stroke="currentColor" opacity={0.3} />
        <circle cx={100} cy={36} r={3.2} fill="#d4f53c" stroke="#9cb52a" strokeWidth={0.8} />
        <g className="reticle-brackets" stroke="currentColor" strokeWidth={1.2}>
          <path d="M18 40V18H40M160 18H182V40M182 160V182H160M40 182H18V160" />
        </g>
      </svg>
      <span className="reticle-text" aria-hidden="true">
        <span>
          <Glyph name="play" size={22} />
          {line1}
          <br />
          {line2}
        </span>
      </span>
    </button>
  );
}
