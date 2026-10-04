import { useEffect, useRef } from "react";
import { Backdrop } from "@swiff/ui";
import { Glyph } from "./Glyph";
import { IgnitionDial, useEased } from "./instruments";
import { gameArt, gameArtFallbacks } from "./steam";
import { isSteamSignInUrl, SteamSignIn } from "./SteamSignIn";
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
 */
export function Ignition({ swiff }: { swiff: Swiff }) {
  const { game, picked, progress, ignitionSteps, ignitionIndex: now, slow, lost } = swiff;
  // A machine carried on to may not be on the list the game's page last read.
  const host = picked?.name ?? swiff.booking?.machine?.name;
  const shown = useEased(progress * 100);
  const pct = Math.round(shown);
  const ignitionStep = ignitionSteps[now]!;
  const title = game?.title ?? "your game";
  const signIn =
    swiff.steamLogin?.state === "qr" && isSteamSignInUrl(swiff.steamLogin.url) ? swiff.steamLogin.url : null;

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
      aria-label={`Starting ${title}`}
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
        <span className="wm ig-wm">Swiff</span>
        <div className="ig-copy">
          <div className="mono" data-testid="ignition-kicker">
            {lost ? (lost.taken ? `${lost.host} was taken back` : `${lost.host} went offline`) : "Starting"}
          </div>
          <div className="ig-title">{title}</div>
          <div className="ig-where">
            {lost ? "now on " : "on "}
            <b>{host ?? "a machine"}</b>
            {picked ? `, ${picked.ping} ms away` : null}
          </div>
        </div>
      </div>

      <div className="ig-paper">
        <div
          className="ig-read"
          role="progressbar"
          aria-label={`Starting ${title}`}
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
          {swiff.play?.started ? "End" : "Cancel"}
          <span className="lpill-c">
            <Glyph name="close" size={18} />
          </span>
        </button>

        {/* Steps are announced once each; the eased percentage is not. */}
        <p className="sr-only" aria-live="polite">
          {signIn ? "Sign in to Steam" : slow ? `${ignitionStep}: taking longer than usual` : ignitionStep}
        </p>

        {slow ? (
          <div className="ig-slow" data-testid="ignition-slow">
            <span className="mono">Taking longer than usual</span>
            <button type="button" className="lpill lpill-sm" onClick={swiff.tryAnother}>
              Try another machine
              <span className="lpill-c">
                <Glyph name="arrow" size={16} />
              </span>
            </button>
          </div>
        ) : null}

        {signIn ? <SteamSignIn url={signIn} /> : <IgnitionDial pct={shown} />}

        <ol className="ig-legend mono">
          {ignitionSteps.map((step, index) => {
            const state = index < now ? "done" : index === now ? "now" : "next";
            return (
              <li key={step} data-state={state}>
                <span className="ig-dot" />
                <span>{step}</span>
                <span>{state === "done" ? "Done" : state === "now" ? `${pct}%` : "Next"}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
