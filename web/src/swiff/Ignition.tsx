import { useEffect, useRef } from "react";
import { Backdrop } from "@swiff/ui";
import { Glyph } from "./Glyph";
import { IgnitionDial, useEased } from "./instruments";
import { withHost } from "./Reconnect";
import { useScreenText } from "./screenCopy";
import { gameArt, gameArtFallbacks } from "./steam";
import { isSteamSignInUrl, signInFailedTitle, SteamSignIn, SteamSignInFailed } from "./SteamSignIn";
import type { Swiff } from "./useSwiff";

/**
 * The wait between Launch and a frame, named step by step so it is not a
 * spinner: Reserving a machine, Waking it, Negotiating the stream, Launching
 * the game. Each step ends on what actually happened on the connection
 * (play.ts); the dial, the percentage and the legend follow it, eased between
 * steps. A step that takes too long says so and offers another machine.
 * Cancel ends the booking; once the session has started it reads End. Nothing
 * of the stream shows until the PC says the game runs. It is modal: Swiff.tsx makes the page behind it
 * inert, and focus moves to Cancel while it is up and back to where it was
 * when it closes. A session carried on from a lost machine starts here too,
 * saying which machine it moved from.
 *
 * On a rental-mode PC, Steam's sign-in code takes the dial's place until the
 * renter has approved it from the Steam app: the one sign-in step there is.
 * If the PC says that sign-in stopped short, Ignition says so instead and
 * offers to try again, or another machine when the game never came up after
 * sign-in, or to book again when the claim's sign-in time ran out; it never
 * goes live on it.
 */
export function Ignition({ swiff }: { swiff: Swiff }) {
  const { t } = useScreenText();
  const { game, picked, progress, ignitionSteps, ignitionIndex: now, slow, lost } = swiff;
  // A machine carried on to may not be on the list the game's page last read.
  const host = picked?.name ?? swiff.booking?.machine?.name;
  const shown = useEased(progress * 100);
  const pct = Math.round(shown);
  const ignitionStep = ignitionSteps[now]!;
  const title = game?.title ?? t("game.yours");
  const signIn =
    swiff.steamLogin?.state === "qr" && isSteamSignInUrl(swiff.steamLogin.url) ? swiff.steamLogin.url : null;
  const signInFailed = swiff.steamSignInFailed;

  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, []);

  return (
    <div
      className="ignition"
      data-testid="ignition"
      role="dialog"
      aria-modal="true"
      aria-label={t("ig.starting", { title })}
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
          <div className="mono" data-testid="ignition-kicker">
            {lost ? t(lost.taken ? "lost.taken" : "lost.offline", { host: lost.host }) : t("ig.kicker")}
          </div>
          <div className="ig-title">{title}</div>
          <div className="ig-where">
            {withHost(t(lost ? "ig.nowOn" : "ig.on"), host ?? t("ig.aMachine"))}
            {picked ? t("ig.away", { ms: picked.ping }) : null}
          </div>
        </div>
      </div>

      <div className="ig-paper">
        <div
          className="ig-read"
          role="progressbar"
          aria-label={t("ig.starting", { title })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          aria-valuetext={`${ignitionStep}, ${Math.round(progress * 100)}%`}
        >
          <div className="mono ig-step">{ignitionStep}</div>
          <div className="ig-pct">
            {pct}
            <span>%</span>
          </div>
        </div>
        <button type="button" className="lpill ig-cancel" onClick={swiff.goHome} ref={cancel}>
          {/* Once the session's clock runs, leaving ends a session rather than a launch. */}
          {swiff.play?.started ? t("ig.end") : t("ig.cancel")}
          <span className="lpill-c">
            <Glyph name="close" size={18} />
          </span>
        </button>

        {/* Steps are announced once each; the eased percentage is not. */}
        <p className="sr-only" aria-live="polite">
          {signInFailed
            ? signInFailedTitle(t, signInFailed)
            : signIn
              ? t("qr.title")
              : slow
                ? t("ig.slowSay", { step: ignitionStep })
                : ignitionStep}
        </p>

        {/* The renter scanning a code is not slow; a failed sign-in has its own way on. */}
        {slow && !signIn && !signInFailed ? (
          <div className="ig-slow" data-testid="ignition-slow">
            <span className="mono">{t("ig.slow")}</span>
            <button type="button" className="lpill lpill-sm" onClick={swiff.tryAnother}>
              {t("ig.tryAnother")}
              <span className="lpill-c">
                <Glyph name="arrow" size={16} />
              </span>
            </button>
          </div>
        ) : null}

        {signInFailed ? (
          <SteamSignInFailed
            reason={signInFailed}
            onRetry={swiff.retrySignIn}
            onTryAnother={swiff.tryAnother}
            onBookAgain={swiff.launch}
          />
        ) : signIn ? (
          <SteamSignIn url={signIn} />
        ) : (
          <IgnitionDial pct={shown} />
        )}

        <ol className="ig-legend mono">
          {ignitionSteps.map((step, index) => {
            // A failed sign-in stops the step it held at: no live dot or percentage there.
            const state = index < now ? "done" : index === now ? (signInFailed ? "stopped" : "now") : "next";
            return (
              <li key={step} data-state={state}>
                <span className="ig-dot" />
                <span>{step}</span>
                <span>
                  {state === "done"
                    ? t("ig.done")
                    : state === "now"
                      ? `${pct}%`
                      : state === "stopped"
                        ? t("ig.stopped")
                        : t("ig.next")}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
