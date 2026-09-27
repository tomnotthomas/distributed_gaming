import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import "./Hero.css";

type Props = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title: ReactNode;
  /** Heading level. One h1 per screen; a wall hero inside a grid is an h2. */
  as?: "h1" | "h2";
  kicker?: ReactNode;
  /** The personal line under the title: "12 h played · last Tuesday". */
  meta?: ReactNode;
  body?: ReactNode;
  actions?: ReactNode;
  /** Small print beside the actions. */
  fine?: ReactNode;
  /** md: wall hero; lg: section headline; xl: the full-bleed game title. */
  size?: "md" | "lg" | "xl";
  align?: "start" | "center";
  /** Play the slam/rise entrance. */
  enter?: boolean;
};

/**
 * The display block: kicker, title, meta, body, actions — always in that order,
 * so every headline on every screen reads the same way.
 */
export function Hero({
  title,
  as: Heading = "h1",
  kicker,
  meta,
  body,
  actions,
  fine,
  size = "md",
  align = "start",
  enter,
  className,
  ...rest
}: Props) {
  return (
    <div data-size={size} data-align={align} data-enter={enter ? "" : undefined} className={cx("hero-block", className)} {...rest}>
      {kicker ? <div className="hero-block-kicker">{kicker}</div> : null}
      <Heading className="hero-block-title">{title}</Heading>
      {meta ? <p data-part="meta">{meta}</p> : null}
      {body ? <p data-part="body">{body}</p> : null}
      {actions || fine ? (
        <div data-part="actions">
          {actions}
          {fine ? <span className="hero-block-fine">{fine}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
