import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

type Props = {
  label: string;
  /** How long the press has to last. The prototype's 600 ms reads as deliberate. */
  holdMs?: number;
  disabled?: boolean;
  onFire: () => void;
  /** Leading glyph — the play triangle. */
  icon?: ReactNode;
};

/**
 * Launch is not an undo-able click: it wakes someone else's PC and starts a
 * booking. So it takes a held press, with a fill bar showing the progress, and
 * releasing early cancels with nothing spent.
 */
export function HoldButton({ label, holdMs = 600, disabled, onFire, icon }: Props) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<number>();

  const cancel = useCallback(() => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
    setHolding(false);
  }, []);

  const begin = useCallback(() => {
    if (disabled || timer.current !== undefined) return;
    setHolding(true);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      setHolding(false);
      onFire();
    }, holdMs);
  }, [disabled, holdMs, onFire]);

  // A pointer released outside the button, or an unmount mid-hold, must not
  // still fire: the press ended without the user committing to it.
  useEffect(() => cancel, [cancel]);

  return (
    <button
      type="button"
      className="btn btn-primary hold"
      disabled={disabled}
      onPointerDown={(e) => {
        if (e.button === 0) begin();
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === "Enter" || e.key === " ") cancel();
      }}
    >
      {icon}
      {label}
      {holding ? <span className="hold-fill" style={{ animationDuration: `${holdMs}ms` }} /> : null}
    </button>
  );
}
