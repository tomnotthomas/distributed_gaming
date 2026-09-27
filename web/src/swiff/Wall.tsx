import { useMemo } from "react";
import { Button, SteamButton, Tag, Tile } from "@swiff/ui";
import { trailerUrl, type Game } from "./data";
import { fmtLeft, freeFor, minsLeft, wallOrder } from "./derive";
import { STEAM_LOGIN_URL, gameArt } from "./steam";
import type { Swiff } from "./useSwiff";

/** Seven tiles fill the grid exactly: one hero, two wide, four small. */
const LIMIT = 7;

const sizeAt = (index: number) => (index === 0 ? "hero" : index <= 2 ? "wide" : "small");

export function Wall({ swiff }: { swiff: Swiff }) {
  const { games, pool, session, libraryConnected, motion, showAll } = swiff;

  const ordered = useMemo(() => wallOrder(games, pool, session), [games, pool, session]);
  const anythingFree = ordered.some((g) => freeFor(g, pool, session).length > 0);

  // Before sign-in the wall leads with something playable right now: a
  // free-to-play title, because that is the one a stranger can actually start.
  const wall = useMemo(() => {
    const shown = showAll ? ordered : ordered.slice(0, LIMIT);
    if (libraryConnected) return shown;
    return [...shown].sort((a, b) => Number(Boolean(b.f2p)) - Number(Boolean(a.f2p)));
  }, [ordered, showAll, libraryConnected]);

  const freeMachines = Object.values(pool).filter((m) => !m.busy && !m.self).length;

  if (!anythingFree) return <WallEmpty />;

  return (
    <main className="wall-main" data-testid="wall">
      <section className="wall">
        {wall.map((game, index) => (
          <WallTile
            key={game.id}
            game={game}
            size={sizeAt(index)}
            swiff={swiff}
            motion={motion}
            freeMachines={freeMachines}
            libraryConnected={libraryConnected}
          />
        ))}
        {!showAll && ordered.length > LIMIT ? (
          <button type="button" className="wall-more" onClick={() => swiff.setShowAll(true)}>
            All {ordered.length} games →
          </button>
        ) : null}
      </section>

      {swiff.steamDenied ? (
        <p className="wall-note">Steam sign-in was cancelled. The free-to-play wall still works.</p>
      ) : null}
      <p className="wall-credit">
        Game artwork and trailers are the property of their respective publishers, served from Steam.
      </p>
    </main>
  );
}

type TileProps = {
  game: Game;
  size: "hero" | "wide" | "small";
  swiff: Swiff;
  motion: boolean;
  freeMachines: number;
  libraryConnected: boolean;
};

function WallTile({ game, size, swiff, motion, freeMachines, libraryConnected }: TileProps) {
  const { pool, session } = swiff;
  const free = freeFor(game, pool, session);
  const best = free[0];
  const playable = free.length > 0;

  const sub = best
    ? `${best.name} · ${fmtLeft(minsLeft(best))}`
    : (() => {
        const backSoon = game.machines.map((id) => pool[id]).find((m) => m?.back);
        return backSoon ? `Back at ${backSoon.back}` : "In use";
      })();

  return (
    <Tile
      title={game.title}
      art={gameArt(game)}
      size={size}
      video={motion && game.video && playable ? trailerUrl(game.video) : null}
      sub={size === "hero" ? undefined : sub}
      badge={!libraryConnected && game.f2p && size !== "hero" ? <Tag tone="accent">Free</Tag> : null}
      dim={!playable || (!libraryConnected && !game.f2p)}
      onOpen={() => swiff.openGame(game)}
      onHoverChange={(on) => swiff.setHoverId(on ? game.id : null)}
    >
      {size === "hero" ? (
        libraryConnected ? (
          <HeroResume game={game} sub={sub} onResume={() => swiff.openGame(game)} />
        ) : (
          <HeroFirstRun game={game} gpu={best?.gpu} freeMachines={freeMachines} />
        )
      ) : null}
    </Tile>
  );
}

/** The signed-in hero: what you were doing, and one button back into it. */
function HeroResume({ game, sub, onResume }: { game: Game; sub: string; onResume: () => void }) {
  return (
    <span className="hero">
      <span className="hero-copy">
        <span className="hero-personal">{game.personal}</span>
        <span className="hero-title">{game.title}</span>
        <span className="hero-meta">{sub}</span>
      </span>
      <Button size="lg" onClick={onResume}>
        Resume
      </Button>
    </span>
  );
}

/**
 * The first-run hero. It has to answer one question — what can I play tonight,
 * on what, with no download — and then offer Steam's own sign-in button.
 */
function HeroFirstRun({
  game,
  gpu,
  freeMachines,
}: {
  game: Game;
  gpu?: string;
  freeMachines: number;
}) {
  return (
    <span className="hero hero-first">
      <span className="hero-copy">
        <span className="hero-kicker">
          <span className="live-dot" />
          {freeMachines} machines free near you
        </span>
        <span className="hero-title">
          {game.title} on a {gpu ? gpu.replace(/^(RTX|RX) /, "") : "shared PC"}.
          <br />
          Tonight. No download.
        </span>
        <span className="hero-body">
          We read your Steam library and stream the games you own from players' idle PCs. Your saves
          come with you.
        </span>
        <span className="hero-cta">
          <SteamButton href={STEAM_LOGIN_URL} />
          <span className="hero-fine">Signs in through Steam. We only read your game library.</span>
        </span>
      </span>
    </span>
  );
}

function WallEmpty() {
  return (
    <main className="wall-main wall-empty" data-testid="wall">
      <div className="empty">
        <h2>Nothing is ready right now</h2>
        <p>
          Every shared machine is in use. Moss is back at 21:30. We'll tell you the moment something
          frees up.
        </p>
        <Button>Notify me</Button>
      </div>
    </main>
  );
}
