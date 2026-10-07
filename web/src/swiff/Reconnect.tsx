import { useEffect, useRef, useState, type ReactNode } from "react";
import { Backdrop } from "@swiff/ui";
import type { Game } from "./data";
import { Glyph } from "./Glyph";
import { RECONNECT_GRACE_MS } from "./play";
import { useScreenText } from "./screenCopy";
import { gameArt, gameArtFallbacks } from "./steam";
import type { Swiff } from "./useSwiff";

// Coming back to a game, in three screens. None of them is in v7: they are
// drawn as Ignition's siblings, the game's art on one side and the paper with
// one big number or word on the other, so getting back reads like starting,
// not like an error.
//
//   A  AwayDialog      on load, a session the page left still runs on the PC:
//                      Still yours, Elden Ring on Glasshouse, held 1:42; Reconnect or End session
//   B  Reconnecting    in session, the connection dropped: Reconnecting to
//                      Glasshouse, 0:12, by itself for 15 s, then a button
//   C  QueueBackDialog on load, a queued booking picked up where it was:
//                      Still finding a machine, in the queue, the place held
//   D  MachineLost     the session's machine was lost (gone offline, or taken
//                      back by its owner): Glasshouse went offline, finding
//                      another machine, 0:03; it carries on there by itself
//                      through Ignition, or waits for one; Stop for now
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

/** `text` with its `{host}` slot filled by `host` in bold. */
export function withHost(text: string, host: string): ReactNode {
  const [before = "", after = ""] = text.split("{host}");
  return (
    <>
      {before}
      <b>{host}</b>
      {after}
    </>
  );
}

/** The game with Steam appid `appid`, as the wall knows it. */
const gameOf = (swiff: Swiff, appid: number) => swiff.games.find((g) => g.appid === appid) ?? null;

type Action = { label: string; onClick: () => void; disabled?: boolean };

type ComeBackProps = {
  testId: string;
  /** The screen's name for assistive tech, in the plan's own words. */
  label: string;
  game: Game | null;
  /** The small mono line above the title, as Ignition's "Starting". */
  kicker: string;
  /** Under the title: where, as Ignition's "on Glasshouse". */
  where?: ReactNode;
  /** What the paper's number is, and the number; a screen with no number to show leaves it out. */
  reading: string;
  time?: ReactNode;
  timeTestId: string;
  line: ReactNode;
  primary?: Action;
  secondary: Action;
};

/**
 * Ignition's layout for a screen that brings the renter back. Modal: focus
 * goes to its way back in while it is up, or to the screen itself when there
 * is none yet (never to the way out, which a stray Enter would take), and back
 * where it was once it goes.
 */
function ComeBack(props: ComeBackProps) {
  const { game, primary, secondary } = props;
  const { t } = useScreenText();
  const root = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const hasPrimary = Boolean(primary);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    (first.current ?? root.current)?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, [hasPrimary]);

  return (
    <div
      className="ignition comeback"
      data-testid={props.testId}
      role="dialog"
      aria-modal="true"
      aria-label={props.label}
      tabIndex={-1}
      ref={root}
    >
      <div className="ig-art">
        {game ? (
          <Backdrop
            className="ig-photo"
            image={gameArt(game)}
            fallback={gameArtFallbacks(game)}
            position={game.focus}
          />
        ) : null}
        <div className="ig-shade" />
        <span className="wm ig-wm">Lanterel</span>
        <div className="ig-copy">
          <div className="mono">{props.kicker}</div>
          <div className="ig-title">{game?.title ?? t("game.Yours")}</div>
          {props.where ? <div className="ig-where">{props.where}</div> : null}
        </div>
      </div>

      <div className="ig-paper cb-paper">
        <div className="mono ig-step">{props.reading}</div>
        {props.time === undefined ? null : (
          <div className="ig-pct cb-time" data-testid={props.timeTestId} aria-live="off">
            {props.time}
          </div>
        )}
        <p className="cb-line">{props.line}</p>
        {primary ? (
          <div className="cb-actions">
            <button
              type="button"
              className="lpill"
              onClick={primary.onClick}
              disabled={primary.disabled}
              ref={first}
            >
              {primary.label}
              <span className="lpill-c">
                <Glyph name="arrow" size={18} />
              </span>
            </button>
          </div>
        ) : null}
        {/* The way out sits where Ignition's Cancel does. */}
        <button type="button" className="lpill ig-cancel" onClick={secondary.onClick}>
          {secondary.label}
          <span className="lpill-c">
            <Glyph name="close" size={18} />
          </span>
        </button>
      </div>
    </div>
  );
}

/** Screen A: the session the page left is still running on the PC. */
export function AwayDialog({ swiff }: { swiff: Swiff }) {
  const now = useNow();
  const { t } = useScreenText();
  const { away, rejoining, rejoinFailed } = swiff;
  if (!away) return null;
  const { booking, heldUntil } = away;
  const game = gameOf(swiff, booking.gameId);
  const host = booking.machine?.name || t("away.yourMachine");
  return (
    <ComeBack
      testId="away"
      label={t("away.label", { game: game?.title ?? t("game.Yours") })}
      game={game}
      kicker={t("away.kicker")}
      where={withHost(t("back.on"), host)}
      reading={heldUntil === null ? t("away.running") : t("away.held")}
      timeTestId="away-held"
      time={heldUntil === null ? t("away.live") : minutesSeconds(heldUntil - now, true)}
      line={rejoinFailed ? withHost(t("away.unreachable"), host) : t("away.line")}
      primary={{
        label: rejoining ? t("away.reconnecting") : t("back.reconnect"),
        onClick: swiff.reconnect,
        disabled: rejoining,
      }}
      secondary={{ label: t("back.end"), onClick: swiff.endAway }}
    />
  );
}

/** Screen C: a queued booking picked up on a page load, still waiting for a machine. */
export function QueueBackDialog({ swiff }: { swiff: Swiff }) {
  const { t } = useScreenText();
  const { queueBack, booking } = swiff;
  if (!queueBack || booking?.status !== "queued") return null;
  return (
    <ComeBack
      testId="queue-back"
      label={t("queue.finding")}
      game={gameOf(swiff, booking.gameId)}
      kicker={t("queue.finding")}
      reading={t("queue.reading")}
      timeTestId="queue-back-held"
      time={t("queue.held")}
      line={t("queue.line")}
      primary={{ label: t("queue.keep"), onClick: swiff.keepQueue }}
      secondary={{ label: t("queue.leave"), onClick: swiff.leaveQueue }}
    />
  );
}

/**
 * Screen B, over the session: the connection to the PC dropped. It counts up
 * while the page reconnects by itself; once that runs out, how long the PC
 * still holds the game, and a button to try again.
 */
export function Reconnecting({ swiff, host }: { swiff: Swiff; host: string }) {
  const now = useNow();
  const { t } = useScreenText();
  const { lostAt, droppedAt, gaveUp } = swiff.play ?? {};
  if (lostAt == null || droppedAt == null) return null;
  return (
    <ComeBack
      testId="reconnecting"
      label={gaveUp ? t("rc.cantReach", { host }) : t("rc.label", { host })}
      game={swiff.game}
      kicker={gaveUp ? t("rc.lost") : t("rc.kicker")}
      where={withHost(t("back.on"), host)}
      reading={gaveUp ? t("away.held") : t("rc.timeAway")}
      timeTestId="reconnecting-time"
      time={
        gaveUp ? minutesSeconds(droppedAt + RECONNECT_GRACE_MS - now, true) : minutesSeconds(now - lostAt)
      }
      line={gaveUp ? t("rc.gaveUp", { host }) : t("rc.line")}
      primary={gaveUp ? { label: t("back.reconnect"), onClick: swiff.retryConnection } : undefined}
      secondary={{ label: t("back.end"), onClick: swiff.endSession }}
    />
  );
}

/**
 * Screen D: the session's machine was lost, and the page is carrying it on
 * elsewhere by itself (useSwiff carryOn). It counts while the next machine is
 * found, and while one is waited for when every machine with the game is
 * busy; once it is found, Ignition takes over in this same layout. With none
 * to move to, it says so and hands the choice back.
 */
export function MachineLost({ swiff }: { swiff: Swiff }) {
  const now = useNow();
  const { t } = useScreenText();
  const { lost, bookingFailed } = swiff;
  if (!lost) return null;
  const game = gameOf(swiff, lost.booking.gameId);
  const title = game?.title ?? t("game.yours");
  const what = t(lost.taken ? "lost.taken" : "lost.offline", { host: lost.host });
  const failed = lost.failed || (bookingFailed && lost.next !== null);
  const waiting = !failed && lost.next?.status === "queued";
  const away = minutesSeconds(now - lost.at);
  const stop = { label: t("lost.stop"), onClick: swiff.stopLost };
  return (
    <ComeBack
      testId="machine-lost"
      label={`${what}. ${failed ? t("lost.none") : t("lost.moving")}`}
      game={game}
      kicker={lost.taken ? t("lost.takenKicker") : t("lost.kicker")}
      where={withHost(t(lost.taken ? "lost.ownerTook" : "lost.offline"), lost.host)}
      reading={failed ? t("lost.cantMove") : waiting ? t("lost.waiting") : t("lost.finding")}
      timeTestId="machine-lost-time"
      time={failed ? undefined : away}
      line={t(failed ? "lost.failedLine" : waiting ? "lost.waitingLine" : "lost.movingLine", { title })}
      primary={failed ? { label: t("lost.choose"), onClick: swiff.chooseMachine } : undefined}
      secondary={stop}
    />
  );
}
