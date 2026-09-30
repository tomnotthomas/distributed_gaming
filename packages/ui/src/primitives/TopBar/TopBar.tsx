import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import "./TopBar.css";

type Props = HTMLAttributes<HTMLElement> & {
  start?: ReactNode;
  center?: ReactNode;
  end?: ReactNode;
  /**
   * `nav` is the app's header. `hud` is the in-session overlay: a top gradient
   * over the stream, and clicks fall through to the game except on controls.
   */
  variant?: "nav" | "hud";
  /** Float over the content instead of pushing it down. */
  floating?: boolean;
};

/** A three-slot bar across the top of a screen. */
export function TopBar({ start, center, end, variant = "nav", floating, className, ...rest }: Props) {
  const Root = variant === "nav" ? "nav" : "div";
  return (
    <Root
      data-variant={variant}
      data-floating={floating ? "" : undefined}
      className={cx("topbar", className)}
      {...rest}
    >
      <div className="topbar-start">{start}</div>
      {center ? <div className="topbar-center">{center}</div> : null}
      <div className="topbar-end">{end}</div>
    </Root>
  );
}
