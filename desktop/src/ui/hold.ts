import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/** How long a press has to last, and how fast an early release drains. */
export const HOLD_MS = 1200;
const DRAIN_MS = 350;
/** How long the done state shows before the control rests again. */
const RESET_MS = 1800;

export type HoldPhase = "idle" | "hold" | "done";

/**
 * A deliberate press: pointer, Space or Enter fills the control over 1.2 s;
 * letting go early drains it with nothing done. The fill is feedback for the
 * owner's own action, so it runs under reduced motion too. Unmounting mid-hold
 * never fires.
 */
export function useHold({ onFire, disabled }: { onFire: () => void; disabled?: boolean }) {
  const [phase, setPhase] = useState<HoldPhase>("idle");
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
      if (next > 0 && disabled) return;
      dir.current = next;
      setPhase(next > 0 ? "hold" : "idle");
      run();
    },
    [phase, disabled, run],
  );

  // A pointer can be released anywhere, not only over the control.
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

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      window.clearTimeout(reset.current);
    },
    [],
  );

  const handlers = {
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button > 0) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      go(1);
    },
    onContextMenu: (event: { preventDefault(): void }) => event.preventDefault(),
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if ((event.key === " " || event.key === "Enter") && !event.repeat) {
        event.preventDefault();
        go(1);
      }
    },
    onKeyUp: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        go(-1);
      }
    },
    onBlur: () => {
      if (dir.current > 0) go(-1);
    },
  };

  return { phase, progress, handlers };
}
