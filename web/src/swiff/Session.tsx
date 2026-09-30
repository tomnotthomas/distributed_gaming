import { Backdrop, Button, Dialog, StatusDot, Tag, TopBar } from "@swiff/ui";
import { gameArt, gameArtFallbacks, gameTrailer } from "./steam";
import type { Swiff } from "./useSwiff";

const clock = (ms: number) =>
  [Math.floor(ms / 3_600_000), Math.floor(ms / 60_000) % 60, Math.floor(ms / 1000) % 60]
    .map((n, i) => (i ? String(n).padStart(2, "0") : String(n)))
    .join(":");

/**
 * The running session. The numbers on the HUD are what a player checks when
 * something feels off, so they stay visible rather than hiding behind a menu.
 */
export function Session({ swiff }: { swiff: Swiff }) {
  const { game, picked, machines, elapsedMs } = swiff;
  if (!game) return null;

  const fps = picked?.quality.endsWith("120") ? 118 : 59;
  const bitrate = picked?.quality.startsWith("4K") ? 42 : 28;
  const fallback = machines.find((m) => !m.busy && m.id !== picked?.id);

  return (
    <div className="session" data-testid="session">
      {/* The stream stand-in always moves: the wall's motion setting is about the
          wall, not about the game you are playing. */}
      <Backdrop image={gameArt(game)} fallback={gameArtFallbacks(game)} video={gameTrailer(game)} motion />

      <TopBar
        variant="hud"
        start={
          <>
            <StatusDot />
            <strong className="hud-title">{game.title}</strong>
            <span className="hud-on">on {picked?.name}</span>
          </>
        }
        end={
          <>
            <span className="hud-stats">
              <Tag tone="live">{fps} fps</Tag>
              <Tag>{picked?.ping ?? 0} ms</Tag>
              <Tag>{bitrate} Mb/s</Tag>
              <Tag>{picked?.quality}</Tag>
            </span>
            <span className="hud-clock">{clock(elapsedMs)}</span>
          </>
        }
      />

      <div className="session-end">
        <Button variant="secondary" onClick={swiff.endSession}>
          End session
        </Button>
      </div>

      {swiff.ownerDropped && fallback ? (
        <Dialog
          title={`${picked?.name} went offline`}
          actions={
            <>
              <Button variant="secondary" onClick={swiff.endSession}>
                Stop for now
              </Button>
              <Button onClick={() => swiff.switchMachine(fallback.id)}>Continue on {fallback.name}</Button>
            </>
          }
        >
          The owner took the machine back. Your save was synced 40 seconds ago and nothing is lost.{" "}
          {fallback.name} has {game.title} ready at {fallback.ping} ms.
        </Dialog>
      ) : null}
    </div>
  );
}
