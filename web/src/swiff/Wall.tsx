import { useMemo } from "react";
import { Button, EmptyState, Hero, Mosaic, StatusDot, SteamButton, Tag, Tile } from "@swiff/ui";
import { trailerUrl, type Game } from "./data";
import { fmtLeft, freeFor, minsLeft, wallOrder } from "./derive";
import { STEAM_LOGIN_URL, gameArt } from "./steam";
import type { Swiff } from "./useSwiff";

/** Seven tiles fill the grid exactly: one hero, two wide, four small. */
const LIMIT = 7;

const sizeAt = (index: number) => (index === 0 ? "hero" : index <= 2 ? "wide" : "small");

export function Wall({ swiff }: { swiff: Swiff }) {
  const { games, pool, session, libraryConnected, showAll } = swiff;

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
      <Mosaic>
        {wall.map((game, index) => (
          <WallTile
            key={game.id}
            game={game}
            size={sizeAt(index)}
            swiff={swiff}
            freeMachines={freeMachines}
            libraryConnected={libraryConnected}
          />
        ))}
        {!showAll && ordered.length > LIMIT ? (
          <button type="button" className="wall-more" data-span="small" onClick={() => swiff.setShowAll(true)}>
            All {ordered.length} games →
          </button>
        ) : null}
      </Mosaic>

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
  freeMachines: number;
  libraryConnected: boolean;
};

function WallTile({ game, size, swiff, freeMachines, libraryConnected }: TileProps) {
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
      // Only playable games move; the motion setting itself is MotionContext's job.
      video={game.video && playable ? trailerUrl(game.video) : null}
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
    <div className="wall-hero">
      <Hero kicker={game.personal} title={game.title} meta={sub} />
      <Button size="lg" onClick={onResume}>
        Resume
      </Button>
    </div>
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
    <div className="wall-hero">
      <Hero
        kicker={
          <>
            <StatusDot />
            {freeMachines} machines free near you
          </>
        }
        title={
          <>
            {game.title} on a {gpu ? gpu.replace(/^(RTX|RX) /, "") : "shared PC"}.
            <br />
            Tonight. No download.
          </>
        }
        body="We read your Steam library and stream the games you own from players' idle PCs. Your saves come with you."
        actions={<SteamButton href={STEAM_LOGIN_URL} />}
        fine="Signs in through Steam. We only read your game library."
      />
    </div>
  );
}

function WallEmpty() {
  return (
    <main className="wall-main wall-empty" data-testid="wall">
      <EmptyState
        title="Nothing is ready right now"
        body="Every shared machine is in use. Moss is back at 21:30. We'll tell you the moment something frees up."
        action={<Button>Notify me</Button>}
      />
    </main>
  );
}
