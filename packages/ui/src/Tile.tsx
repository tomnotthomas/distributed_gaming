import type { ReactNode } from "react";

type Size = "hero" | "wide" | "small";

type Props = {
  title: string;
  art: string;
  /** Spans 4×2, 2×1 and 1×1 of the wall grid respectively. */
  size?: Size;
  /** A muted, looping trailer. Null keeps the still — the motion setting is off. */
  video?: string | null;
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
 * One game on the live wall. The art is a background rather than an <img> so the
 * scrim can sit on top without a stacking context per tile, and the caption is
 * inside the button so the whole tile is one hit target.
 */
export function Tile({
  title,
  art,
  size = "small",
  video,
  sub,
  badge,
  dim,
  onOpen,
  onHoverChange,
  children,
}: Props) {
  return (
    <button
      type="button"
      className={`tile tile-${size}${dim ? " tile-dim" : ""}`}
      onClick={onOpen}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      <span className="tile-art" style={{ backgroundImage: `url(${art})` }} />
      {video ? (
        <video className="tile-video" src={video} muted autoPlay loop playsInline />
      ) : null}
      {badge ? <span className="tile-badge">{badge}</span> : null}
      <span className="tile-scrim" />
      {size === "hero" ? (
        children
      ) : (
        <span className="tile-cap">
          <span className="tile-title">{title}</span>
          {sub ? <span className="tile-sub">{sub}</span> : null}
        </span>
      )}
    </button>
  );
}
