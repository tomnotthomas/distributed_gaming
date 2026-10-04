import { useEffect, useState } from "react";
import { Button, Dialog, Overlay } from "@swiff/ui";
import { RECONNECT_GRACE_MS } from "./play";
import type { Swiff } from "./useSwiff";

// Coming back to a game, in three screens (none of them in v7, drawn here in
// Swiff's own components):
//
//   A  AwayDialog      on load, a session the page left still runs on the PC:
//                      "Elden Ring is still yours · held 1:42" · Reconnect / End session
//   B  Reconnecting    in session, the connection dropped: "Reconnecting to
//                      Glasshouse… 0:12", by itself for 15 s, then a button
//   C  QueueBackDialog on load, a queued booking picked up where it was:
//                      "Still finding a machine · 1:12 left in the queue"
//
// Only the renter's End skips the PC's two minutes: closing the page, or
// leaving it open, never does.

/** m:ss for a count of ms, rounded up so a countdown shows 0:00 only once it is out. */
export const minutesSeconds = (ms: number, up = false) => {
  const seconds = Math.max(0, up ? Math.ceil(ms / 1000) : Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** The clock, read every second while a screen counts. */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** The title of the game with Steam appid `appid`, as the wall knows it. */
const titleOf = (swiff: Swiff, appid: number) =>
  swiff.games.find((g) => g.appid === appid)?.title ?? "Your game";

/** Screen A: the session the page left is still running on the PC. */
export function AwayDialog({ swiff }: { swiff: Swiff }) {
  const now = useNow();
  const { away, rejoining } = swiff;
  if (!away) return null;
  const { booking, heldUntil } = away;
  const host = booking.machine?.name || "your machine";
  return (
    <Dialog
      data-testid="away"
      title={`${titleOf(swiff, booking.gameId)} is still yours`}
      actions={
        <>
          <Button variant="secondary" onClick={swiff.endAway}>
            End session
          </Button>
          <Button onClick={swiff.reconnect} disabled={rejoining} autoFocus>
            {rejoining ? "Reconnecting…" : "Reconnect"}
          </Button>
        </>
      }
    >
      {heldUntil === null ? (
        <>It is still running on {host}, waiting for you.</>
      ) : (
        <>
          {host} is holding it for you ·{" "}
          <b data-testid="away-held">held {minutesSeconds(heldUntil - now, true)}</b>
        </>
      )}
    </Dialog>
  );
}

/** Screen C: a queued booking picked up on a page load, still waiting for a machine. */
export function QueueBackDialog({ swiff }: { swiff: Swiff }) {
  const { queueBack, booking } = swiff;
  if (!queueBack || booking?.status !== "queued") return null;
  return (
    <Dialog
      data-testid="queue-back"
      title="Still finding a machine"
      onDismiss={swiff.keepQueue}
      actions={
        <>
          <Button variant="secondary" onClick={swiff.leaveQueue}>
            Leave the queue
          </Button>
          <Button onClick={swiff.keepQueue} autoFocus>
            Keep waiting
          </Button>
        </>
      }
    >
      {titleOf(swiff, booking.gameId)} ·{" "}
      <b data-testid="queue-back-left">{minutesSeconds(queueBack.leftMs, true)} left in the queue</b>. You
      kept your place: it starts by itself the moment a machine is free.
    </Dialog>
  );
}

/**
 * Screen B, over the session: the connection to the PC dropped. It counts up
 * while the page reconnects by itself; once that runs out, how long the PC
 * still holds the game, and a button to try again.
 */
export function Reconnecting({ swiff, host }: { swiff: Swiff; host: string }) {
  const now = useNow();
  const lostAt = swiff.play?.lostAt;
  if (lostAt == null) return null;
  const gaveUp = swiff.play?.gaveUp ?? false;
  const title = swiff.game?.title ?? "Your game";
  return (
    <Overlay glow className="reconnecting" data-testid="reconnecting" role="status">
      <div className="mono reconnecting-kicker">{gaveUp ? "Connection lost" : "Reconnecting"}</div>
      <div className="reconnecting-title">{gaveUp ? `Can't reach ${host}` : `Reconnecting to ${host}…`}</div>
      <div className="reconnecting-time mono" data-testid="reconnecting-time">
        {gaveUp
          ? `${title} keeps running for ${minutesSeconds(lostAt + RECONNECT_GRACE_MS - now, true)}`
          : minutesSeconds(now - lostAt)}
      </div>
      <div className="reconnecting-actions">
        <Button variant="secondary" onClick={swiff.endSession}>
          End session
        </Button>
        {gaveUp ? (
          <Button onClick={swiff.retryConnection} autoFocus>
            Reconnect
          </Button>
        ) : null}
      </div>
    </Overlay>
  );
}
