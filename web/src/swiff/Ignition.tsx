import { useEffect, useRef } from "react";
import { Backdrop } from "@swiff/ui";
import { IGNITION_STEPS } from "./data";
import { Glyph } from "./Glyph";
import { IgnitionDial, useEased } from "./instruments";
import { gameArt, gameArtFallbacks } from "./steam";
import { isSteamSignInUrl, SteamSignIn, SteamSignInFailed } from "./SteamSignIn";
import type { Swiff } from "./useSwiff";

/**
 * The wait between Launch and a frame, named step by step so it is not a
 * spinner. The dial, the percentage and the legend all follow the launch's
 * real progress, eased between beats. It is modal: Swiff.tsx makes the page
 * behind it inert, and focus moves to Cancel while it is up and back to where
 * it was when it closes.
 *
 * On a rental-mode PC, Steam's sign-in code takes the dial's place until the
 * renter has approved it from the Steam app: the one sign-in step there is.
 * If the PC says that sign-in stopped short, Ignition says so instead and
 * offers to try again; it never goes live on it.
 */
export function Ignition({ swiff }: { swiff: Swiff }) {
  const { game, picked, progress, ignitionStep } = swiff;
  const shown = useEased(progress * 100);
  const pct = Math.round(shown);
  const now = IGNITION_STEPS.indexOf(ignitionStep);
  const title = game?.title ?? "your game";
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
          <div className="mono">Starting</div>
          <div className="ig-title">{title}</div>
          <div className="ig-where">
            on <b>{picked?.name ?? "a machine"}</b>
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
          Cancel
          <span className="lpill-c">
            <Glyph name="close" size={18} />
          </span>
        </button>

        {/* Steps are announced once each; the eased percentage is not. */}
        <p className="sr-only" aria-live="polite">
          {signInFailed ? "Sign-in didn't work" : signIn ? "Sign in to Steam" : ignitionStep}
        </p>

        {signInFailed ? (
          <SteamSignInFailed onRetry={swiff.launch} onEnd={swiff.goHome} />
        ) : signIn ? (
          <SteamSignIn url={signIn} />
        ) : (
          <IgnitionDial pct={shown} />
        )}

        <ol className="ig-legend mono">
          {IGNITION_STEPS.map((step, index) => {
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
