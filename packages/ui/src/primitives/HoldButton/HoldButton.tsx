import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import { buttonClass, type ButtonSize, type ButtonVariant } from "../Button";
import "./HoldButton.css";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  children: ReactNode;
  /** How long the press has to last. The prototype's 600 ms reads as deliberate. */
  holdMs?: number;
  onFire: () => void;
  /** Leading glyph — the play triangle. */
  icon?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
};

/**
 * Launch is not an undo-able click: it wakes someone else's PC and starts a
 * booking. So it takes a held press, with a fill bar showing the progress, and
 * releasing early cancels with nothing spent.
 */
export const HoldButton = forwardRef<HTMLButtonElement, Props>(function HoldButton(
  { children, holdMs = 600, disabled, onFire, icon, variant = "primary", size = "md", className, ...rest },
  ref,
) {
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
      {...rest}
      ref={ref}
      className={cx(buttonClass(variant, size), "hold", className)}
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
      {children}
      {holding ? <span className="hold-fill" style={{ animationDuration: `${holdMs}ms` }} /> : null}
    </button>
  );
});
