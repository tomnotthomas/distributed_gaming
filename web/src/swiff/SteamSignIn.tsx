import { useEffect, useMemo, useRef } from "react";
import { encode } from "uqr";
import { STEAM_SIGN_IN_MS } from "@swiff/rank";
import { Glyph } from "./Glyph";
import type { SignInFailure } from "./play";

/** Steam's sign-in QR codes encode a link like https://s.team/q/1/1234567890123456789. */
const SIGN_IN_URL = /^https:\/\/s\.team\/q\/[0-9]+\/[0-9]+$/;

/** Whether `url`, sent by the PC, is a Steam sign-in link: nothing else is drawn as a code to scan. */
export const isSteamSignInUrl = (url: string): boolean => SIGN_IN_URL.test(url);

/** The quiet margin scanners need around a QR code, in modules. */
const QUIET = 4;

/**
 * Steam's own sign-in code from the PC (rental mode), redrawn here so the
 * renter never sees Steam's window: they scan it with the Steam app, approve,
 * and the game starts. Dark modules on white whatever the page around it, as
 * scanners expect.
 */
export function SteamSignIn({ url }: { url: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(url, { ecc: "M", border: 0 });
    let d = "";
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
      }),
    );
    return { size: qr.size + 2 * QUIET, path: d };
  }, [url]);

  return (
    <section className="ig-qr" aria-labelledby="ig-qr-title" data-testid="steam-sign-in">
      <svg
        className="ig-qr-code"
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label="Steam sign-in QR code"
        shapeRendering="crispEdges"
      >
        <rect width={size} height={size} fill="#fff" />
        <path d={path} fill="#131313" />
      </svg>
      <div className="ig-qr-copy">
        <h2 id="ig-qr-title">Sign in to Steam</h2>
        <p>Scan this with the Steam app on your phone and approve. Your game starts as soon as you do.</p>
        <p className="ig-qr-note">
          Steam shows where the PC is on a map. Approve only while this screen is open.
        </p>
      </div>
    </section>
  );
}

/** The failed panel's title, which Ignition also announces. */
export const signInFailedTitle = (reason: SignInFailure): string =>
  reason === "launch-timeout"
    ? "Your game didn't start"
    : reason === "time-up"
      ? "Sign-in time ran out"
      : "Sign-in didn't work";

/**
 * The PC's Steam sign-in stopped short, in the code's place: the game is not
 * starting. When the code was never approved, trying again asks the same PC
 * for a new code, keeping the machine. When the game never came up after
 * sign-in, a new code would not help, so it offers another machine instead.
 * When the claim's sign-in time ran out, the machine is gone: it offers to
 * book again. Ignition's own Cancel is the way out, so there is no second one
 * here. Focus moves to the way on so it is one key away.
 */
export function SteamSignInFailed({
  reason,
  onRetry,
  onTryAnother,
  onBookAgain,
}: {
  reason: SignInFailure;
  onRetry: () => void;
  onTryAnother: () => void;
  onBookAgain: () => void;
}) {
  const action = useRef<HTMLButtonElement>(null);
  useEffect(() => action.current?.focus(), [reason]);
  const way =
    reason === "launch-timeout"
      ? {
          text: "Steam signed you in, but your game didn't come up on this machine.",
          label: "Try another machine",
          onClick: onTryAnother,
        }
      : reason === "time-up"
        ? {
            text: `Your ${STEAM_SIGN_IN_MS / 60_000} minutes to sign in to Steam ran out, so this machine went back.`,
            label: "Book again",
            onClick: onBookAgain,
          }
        : {
            text: "Steam didn't finish signing you in, so your game hasn't started. Try again for a new code.",
            label: "Try again",
            onClick: onRetry,
          };

  return (
    <section className="ig-qr" aria-labelledby="ig-qr-failed-title" data-testid="steam-sign-in-failed">
      <div className="ig-qr-copy">
        <h2 id="ig-qr-failed-title">{signInFailedTitle(reason)}</h2>
        <p>{way.text}</p>
        <div className="ig-qr-actions">
          <button type="button" className="lpill" onClick={way.onClick} ref={action}>
            {way.label}
            <span className="lpill-c">
              <Glyph name="arrow" size={18} />
            </span>
          </button>
        </div>
      </div>
    </section>
  );
}
