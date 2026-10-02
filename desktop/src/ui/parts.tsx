// The small pieces every screen is built from: the instrument plate, game art,
// game thumbnails, key-value rows and the euro figure.

import type { ReactNode } from "react";
import { Backdrop } from "@swiff/ui";
import { euros } from "../format";
import { art, type Game } from "../model";

/** A euro amount with the sign set small: €1,05. */
export function Eur({ n, decimals = 2 }: { n: number; decimals?: number }) {
  return (
    <>
      <span className="cur">€</span>
      {euros(n, decimals)}
    </>
  );
}

/** A game's art, filling its box: key art, with the store header under it. */
export function Art({
  appid,
  position = "60% 40%",
  drift,
}: {
  appid: number;
  position?: string;
  drift?: boolean;
}) {
  const { image, fallback } = art(appid);
  return <Backdrop className="art" image={image} fallback={fallback} position={position} drift={drift} />;
}

/**
 * The instrument plate: a mid-grey ground that drifts slowly through one
 * palette gradient, drafting marks in its corners, a faint wash of the
 * screen's game where there is one, and a caption on each side under it.
 * Static under reduced motion.
 */
export function Plate({
  children,
  caption,
  tint,
  glass,
  className,
}: {
  children: ReactNode;
  caption?: [ReactNode, ReactNode];
  /** The screen's game, as a faint wash. */
  tint?: number | null;
  /** Translucent, over the streaming stage's art. */
  glass?: boolean;
  className?: string;
}) {
  return (
    <div className={["plate", glass ? "glassp" : "lp", className].filter(Boolean).join(" ")}>
      {tint && !glass ? (
        <div className="tint" aria-hidden="true">
          <Art appid={tint} />
        </div>
      ) : null}
      <i className="pt-tl" />
      <i className="pt-tr" />
      <i className="pt-bl" />
      <i className="pt-br" />
      {children}
      {caption ? (
        <div className="icap mono">
          <span>{caption[0]}</span>
          <span>{caption[1]}</span>
        </div>
      ) : null}
    </div>
  );
}

/** Small thumbnails of games, each with its name. */
export function Thumbs({ games, columns = 4 }: { games: Game[]; columns?: 2 | 4 }) {
  if (!games.length) return <p className="soft">No games.</p>;
  return (
    <div className={`gmini c${columns}`}>
      {games.map((game) => (
        <figure key={game.appid}>
          <span className="gthumb">
            <Art appid={game.appid} />
          </span>
          <figcaption>{game.name}</figcaption>
        </figure>
      ))}
    </div>
  );
}

/** One ruled row of a figure and its label. */
export function Kv({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="krow">
      <span>{label}</span>
      <b>{children}</b>
    </div>
  );
}

/** A big figure with its unit beside it. */
export function Figure({
  children,
  unit,
  size,
  cost,
}: {
  children: ReactNode;
  unit?: ReactNode;
  size?: "sm" | "xs";
  cost?: boolean;
}) {
  return (
    <div className={["fg", size, cost && "cost"].filter(Boolean).join(" ")}>
      <b>{children}</b>
      {unit ? <span>{unit}</span> : null}
    </div>
  );
}

/** A labelled zone of the supporting row under each screen's statement. */
export function Zone({
  title,
  action,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="zc">
      <h2 className="mono">
        <span>{title}</span>
        {action}
      </h2>
      {children}
    </section>
  );
}

/** The demo's label, wherever demo data is on screen. */
export const DemoTag = () => <span className="ptag demo">Demo data</span>;
