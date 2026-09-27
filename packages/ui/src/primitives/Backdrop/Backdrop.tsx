import type { CSSProperties, HTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import { useMotion } from "../../lib/motion";
import { Trailer } from "../Trailer";
import "./Backdrop.css";

export type Scrim = "pocket" | "bottom" | "top" | "noise";

type Props = HTMLAttributes<HTMLDivElement> & {
  image: string;
  /** Painted under `image`, in order, so each shows wherever the ones above fail to load. */
  fallback?: string | readonly string[];
  /** Plays over the still when motion is on. */
  video?: string | null;
  /** Focus point for both still and video, e.g. "30% 40%". */
  position?: string;
  /** Layers that keep type legible over any frame, painted in this order. */
  scrims?: readonly Scrim[];
  /** Defaults to MotionContext. False always shows the still. */
  motion?: boolean;
};

/**
 * Full-bleed game art: a still, a trailer over it when motion allows, and the
 * scrims that keep a bright frame — a scoreboard, a snow field — from
 * swallowing the headline.
 */
export function Backdrop({ image, fallback, video, position, scrims = [], motion, className, ...rest }: Props) {
  const allowed = useMotion();
  const play = Boolean(video) && (motion ?? allowed);
  const place: CSSProperties = position ? { objectPosition: position, backgroundPosition: position } : {};
  return (
    <div className={cx("backdrop", className)} {...rest}>
      {play ? (
        <Trailer className="backdrop-media" src={video!} poster={image} style={place} />
      ) : (
        <div
          className="backdrop-media backdrop-still"
          style={{ backgroundImage: [image, ...[fallback ?? []].flat()].map((src) => `url(${src})`).join(", "), ...place }}
        />
      )}
      {scrims.map((scrim) => (
        <div key={scrim} className="backdrop-scrim" data-scrim={scrim} />
      ))}
    </div>
  );
}
