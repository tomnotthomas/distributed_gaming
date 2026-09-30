import { forwardRef } from "react";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "../../lib/cx";
import "./Button.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "link";
export type ButtonSize = "sm" | "md" | "lg" | "xl";

type Common = {
  variant?: ButtonVariant;
  /** md is the default and adds no class; lg is the one call to action on a page. */
  size?: ButtonSize;
  /** Leading glyph. */
  icon?: ReactNode;
  /** The hero CTA's accent halo. */
  glow?: boolean;
};

type AsButton = Common & ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined };
type AsLink = Common & AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };
export type ButtonProps = AsButton | AsLink;

const SIZE_CLASS: Record<ButtonSize, string> = { sm: "btn-sm", md: "", lg: "btn-lg", xl: "btn-xl" };

/** The class list every button-shaped control wears, so HoldButton and friends cannot drift. */
export const buttonClass = (variant: ButtonVariant = "primary", size: ButtonSize = "md", glow?: boolean) =>
  cx("btn", `btn-${variant}`, SIZE_CLASS[size], glow && "btn-glow");

/**
 * The prototype's button. With `href` it renders an anchor wearing the same
 * classes, so "Browse Steam store" looks like the buttons beside it and still
 * behaves as a link.
 */
export const Button = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", icon, glow, className, children, ...rest },
  ref,
) {
  const classes = cx(buttonClass(variant, size, glow), className);
  if (rest.href !== undefined) {
    return (
      <a
        ref={ref as Ref<HTMLAnchorElement>}
        {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)}
        className={classes}
      >
        {icon}
        {children}
      </a>
    );
  }
  return (
    <button
      ref={ref as Ref<HTMLButtonElement>}
      {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
      className={classes}
    >
      {icon}
      {children}
    </button>
  );
});
