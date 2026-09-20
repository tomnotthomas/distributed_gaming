import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  /** The one call to action on a page — taller, so it reads as the next step. */
  large?: boolean;
};

/**
 * The prototype's button. Two variants is all phase 1 needs: primary for the
 * action that starts a connection, secondary for the one that ends it.
 */
export function Button({ variant = "primary", large, className, ...rest }: Props) {
  const classes = ["btn", `btn-${variant}`, large ? "btn-lg" : "", className ?? ""];
  return <button {...rest} className={classes.filter(Boolean).join(" ")} />;
}
