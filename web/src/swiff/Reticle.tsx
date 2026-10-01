import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Glyph } from "./Glyph";

/** How long the press has to last, and how fast an early release drains. */
export const HOLD_MS = 1200;
const DRAIN_MS = 350;
/** How long "Launching" shows before the button rests again. */
const RESET_MS = 1800;

type Phase = "idle" | "hold" | "done";

const LABEL: Record<Phase, [string, string]> = {
  idle: ["Hold to", "launch"],
  hold: ["Keep", "holding"],
  done: ["Launching", ""],
};

/**
 * Launch wakes someone else's PC and starts a booking, so it is a held press,
 * not a click. Pointer, Space or Enter fills the outer ring over 1.2 s and
 * pulls the brackets in; letting go early drains it with nothing spent. The
 * fill is feedback for the player's own action, so it runs under reduced
 * motion too; only the idle cue stops. While a launch is under way it stays
 * closed on "Launching" and takes no new press, so a second hold cannot start
 * the launch over.
 */
export function Reticle({
  onFire,
  disabled,
  launching,
  label,
}: {
  onFire: () => void;
  /** No machine to launch on. */
  disabled?: boolean;
  /** A launch is already under way. */
  launching?: boolean;
  label: string;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const p = useRef(0);
  const dir = useRef(0);
  const raf = useRef(0);
  const reset = useRef<number>();
  const fire = useRef(onFire);
  fire.current = onFire;

  const run = useCallback(() => {
    if (raf.current) return;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = Math.max(0, t - last);
      last = t;
      p.current = Math.max(0, Math.min(1, p.current + (dir.current > 0 ? dt / HOLD_MS : -dt / DRAIN_MS)));
      setProgress(p.current);
      if (p.current >= 1) {
        raf.current = 0;
        dir.current = 0;
        setPhase("done");
        fire.current();
        reset.current = window.setTimeout(() => {
          p.current = 0;
          setProgress(0);
          setPhase("idle");
        }, RESET_MS);
        return;
      }
      const moving = (dir.current > 0 && p.current < 1) || (dir.current < 0 && p.current > 0);
      raf.current = moving ? requestAnimationFrame(tick) : 0;
    };
    raf.current = requestAnimationFrame(tick);
  }, []);

  const go = useCallback(
    (next: 1 | -1) => {
      if (phase === "done" || next === dir.current) return;
      if (next > 0 && (disabled || launching)) return;
      dir.current = next;
      setPhase(next > 0 ? "hold" : "idle");
      run();
    },
    [phase, disabled, launching, run],
  );

  // A pointer can be released anywhere, not only over the button.
  useEffect(() => {
    const release = () => {
      if (dir.current > 0) go(-1);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [go]);

  // Unmounting mid-hold must never fire: the press ended without a commitment.
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      window.clearTimeout(reset.current);
    },
    [],
  );

  const shown: Phase = launching ? "done" : phase;
  const fill = launching ? 1 : progress;
  const [line1, line2] = disabled ? ["Pick a", "machine"] : LABEL[shown];
  const arc = (100 - fill * 100).toFixed(2);

  return (
    <button
      type="button"
      className="reticle"
      data-phase={shown}
      disabled={disabled || launching}
      aria-label={label}
      style={{ "--hold": fill.toFixed(4) } as CSSProperties}
      onPointerDown={(event) => {
        if (event.button > 0) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        go(1);
      }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) {
          event.preventDefault();
          go(1);
        }
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          go(-1);
        }
      }}
      onBlur={() => {
        if (dir.current > 0) go(-1);
      }}
    >
      <svg viewBox="0 0 200 200" aria-hidden="true" fill="none">
        <path d="M100 2V22M100 178V198M2 100H22M178 100H198" stroke="currentColor" />
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
          strokeDashoffset={arc}
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
        <Glyph name="play" />
        <span>
          {line1}
          {line2 ? (
            <>
              <br />
              {line2}
            </>
          ) : null}
        </span>
      </span>
    </button>
  );
}
