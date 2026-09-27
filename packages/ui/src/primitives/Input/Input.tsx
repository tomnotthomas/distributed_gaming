import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import "./Input.css";

/** A text input on glass. Wrap it in a Field to give it a visible label. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx("input", className)} {...rest} />;
});
