import type { CSSProperties, HTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import { useMotion } from "../../lib/motion";
import { Trailer, type VideoSource } from "../Trailer";
import "./Backdrop.css";

export type Scrim = "pocket" | "bottom" | "top" | "noise";

type Props = HTMLAttributes<HTMLDivElement> & {
  image: string;
  /** Painted under `image`, in order, so each shows wherever the ones above fail to load. */
  fallback?: string | readonly string[];
  /** Plays over the still when motion is on: one URL, or encodings in order of preference. */
  video?: string | readonly VideoSource[] | null;
  /** Focus point for both still and video, e.g. "30% 40%". */
  position?: string;
  /** Layers that keep type legible over any frame, painted in this order. */
  scrims?: readonly Scrim[];
  /** Defaults to MotionContext. False always shows the still. */
  motion?: boolean;
  /**
   * Let the still drift: a slow pan and zoom in place of a trailer, for a
   * background that should feel alive without pulling the eye. Held still when
   * motion is off and under prefers-reduced-motion.
   */
  drift?: boolean;
};

/**
 * Full-bleed game art: a still, a trailer over it when motion allows, and the
 * scrims that keep a bright frame — a scoreboard, a snow field — from
 * swallowing the headline.
 */
export function Backdrop({
  image,
  fallback,
  video,
  position,
  scrims = [],
  motion,
  drift,
  className,
  ...rest
}: Props) {
  const allowed = useMotion();
  const moving = motion ?? allowed;
  const play = Boolean(video && video.length) && moving;
  // A new set of sources needs a new <video>: changing <source> children alone does not reload it.
  const videoKey = typeof video === "string" ? video : video?.map((s) => s.src).join(" ");
  const place: CSSProperties = position ? { objectPosition: position, backgroundPosition: position } : {};
  return (
    <div className={cx("backdrop", className)} {...rest}>
      {play ? (
        <Trailer key={videoKey} className="backdrop-media" src={video!} poster={image} style={place} />
      ) : (
        <div
          className={cx("backdrop-media backdrop-still", drift && moving && "backdrop-drift")}
          style={{
            backgroundImage: [image]
              .concat(fallback ?? [])
              .map((src) => `url(${src})`)
              .join(", "),
            ...place,
          }}
        />
      )}
      {scrims.map((scrim) => (
        <div key={scrim} className="backdrop-scrim" data-scrim={scrim} />
      ))}
    </div>
  );
}
