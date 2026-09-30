import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, Hero, Mosaic, StatusDot, SteamButton, Tag, Tile } from "@swiff/ui";
import type { Game } from "./data";
import { useDisplay } from "./display";
import { fmtLeft, freeFor, minsLeft, wallOrder } from "./derive";
import { STEAM_LOGIN_URL, gameArt, gameArtFallbacks, gamePreview, gameTrailer } from "./steam";
import type { Swiff } from "./useSwiff";

/** Seven tiles fill the grid exactly: one hero, two wide, four small. */
const LIMIT = 7;

const sizeAt = (index: number) => (index === 0 ? "hero" : index <= 2 ? "wide" : "small");

/** How long the pointer has to rest on a tile before its trailer starts. */
const PREVIEW_DELAY_MS = 380;

/**
 * The hovered tile, once the pointer has stayed on it for a moment. Sweeping
 * across the wall should not start (and download) a trailer per tile passed.
 */
function usePreview(hoverId: string | null): string | null {
  const [previewId, setPreviewId] = useState<string | null>(null);
  useEffect(() => {
    if (hoverId === null) {
      setPreviewId(null);
      return;
    }
    const timer = window.setTimeout(() => setPreviewId(hoverId), PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [hoverId]);
  return previewId;
}

export function Wall({ swiff }: { swiff: Swiff }) {
  const { games, pool, session, prefs, libraryConnected, showAll } = swiff;

  const ordered = useMemo(() => wallOrder(games, pool, session, prefs), [games, pool, session, prefs]);
  const anythingFree = ordered.some((g) => freeFor(g, pool, session, prefs).length > 0);

  // Before sign-in the wall leads with something playable right now: a
  // free-to-play title, because that is the one a stranger can actually start.
  const wall = useMemo(() => {
    const shown = showAll ? ordered : ordered.slice(0, LIMIT);
    if (libraryConnected) return shown;
    return [...shown].sort((a, b) => Number(Boolean(b.f2p)) - Number(Boolean(a.f2p)));
  }, [ordered, showAll, libraryConnected]);

  const freeMachines = Object.values(pool).filter((m) => !m.busy && !m.self).length;
  const previewId = usePreview(swiff.hoverId);
  const display = useDisplay();

  if (!anythingFree) return <WallEmpty />;

  return (
    <main className="wall-main" data-testid="wall">
      <Mosaic layout={display === "ultra" ? "horizontal" : "grid"}>
        {wall.map((game, index) => (
          <WallTile
            key={game.id}
            game={game}
            size={sizeAt(index)}
            preview={previewId === game.id}
            swiff={swiff}
            freeMachines={freeMachines}
            libraryConnected={libraryConnected}
          />
        ))}
        {!showAll && ordered.length > LIMIT ? (
          <button
            type="button"
            className="wall-more"
            data-span="small"
            onClick={() => swiff.setShowAll(true)}
          >
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
  /** The pointer has rested on this tile: play its trailer. */
  preview: boolean;
  swiff: Swiff;
  freeMachines: number;
  libraryConnected: boolean;
};

function WallTile({ game, size, preview, swiff, freeMachines, libraryConnected }: TileProps) {
  const { pool, session, prefs } = swiff;
  const free = freeFor(game, pool, session, prefs);
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
      art={gameArt(game, size === "hero" ? 2 : 1)}
      fallbackArt={gameArtFallbacks(game)}
      size={size}
      // The hero always moves; a smaller tile only once it is being looked at,
      // as in the prototype. Unplayable games stay still. The motion setting
      // itself is MotionContext's job.
      video={!playable ? null : size === "hero" ? gameTrailer(game) : preview ? gamePreview(game) : null}
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
function HeroFirstRun({ game, gpu, freeMachines }: { game: Game; gpu?: string; freeMachines: number }) {
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
