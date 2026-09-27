import type { ComponentProps, ReactNode } from "react";
import { cx } from "../../lib/cx";
import { Backdrop } from "../../primitives/Backdrop";
import "./Tile.css";

type Size = "hero" | "wide" | "small";

// The hero plays footage behind live copy, so it needs a reading pocket as
// well as the bottom fade; Tile.css tunes both for a card.
const HERO_SCRIMS = ["pocket", "bottom"] as const;
const CARD_SCRIMS = ["bottom"] as const;

type Props = {
  title: string;
  art: string;
  /** Shown, in order, where `art` fails to load — not every game has every size. */
  fallbackArt?: ComponentProps<typeof Backdrop>["fallback"];
  /** Spans 4×2, 2×1 and 1×1 of a Mosaic, through data-span. */
  size?: Size;
  /** A muted, looping trailer. Null keeps the still — the motion setting is off. */
  video?: ComponentProps<typeof Backdrop>["video"];
  sub?: ReactNode;
  /** Sits top-left, above the scrim. Used for the free-to-play flag. */
  badge?: ReactNode;
  /** Nothing free to play it on, or not owned: desaturate rather than hide. */
  dim?: boolean;
  onOpen?: () => void;
  onHoverChange?: (hovering: boolean) => void;
  /** Hero overlay — the hero carries its own title, so the caption stays off. */
  children?: ReactNode;
};

/**
 * One game on the live wall: a Backdrop with its scrim, a badge and a caption. The
 * caption is inside the button so the whole tile is one hit target.
 */
export function Tile({
  title,
  art,
  fallbackArt,
  size = "small",
  video,
  sub,
  badge,
  dim,
  onOpen,
  onHoverChange,
  children,
}: Props) {
  const layers = (
    <>
      <Backdrop image={art} fallback={fallbackArt} video={video} scrims={size === "hero" ? HERO_SCRIMS : CARD_SCRIMS} />
      {badge ? <span className="tile-badge">{badge}</span> : null}
    </>
  );
  const hover = {
    onMouseEnter: () => onHoverChange?.(true),
    onMouseLeave: () => onHoverChange?.(false),
  };

  // The hero carries its own controls — Resume, or Valve's sign-in link — and a
  // <button> may not contain a link. So the hero is a plain container and its
  // children own the clicks; only the smaller tiles are one big hit target.
  if (size === "hero") {
    return (
      <div className={cx("tile tile-hero", dim && "tile-dim")} data-span="hero" {...hover}>
        {layers}
        {children}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={cx("tile", dim && "tile-dim")}
      data-span={size}
      onClick={onOpen}
      {...hover}
    >
      {layers}
      <span className="tile-cap">
        <span className="tile-title">{title}</span>
        {sub ? <span className="tile-sub">{sub}</span> : null}
      </span>
    </button>
  );
}
