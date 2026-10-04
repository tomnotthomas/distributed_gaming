import { useEffect, useMemo, useRef } from "react";
import { encode } from "uqr";
import { Glyph } from "./Glyph";

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

/**
 * The PC's Steam sign-in stopped short (its code timed out, or the game never
 * came up), in the code's place: the game is not starting. Trying again
 * launches afresh for a new code; ending leaves, as Cancel does. Focus moves to
 * Try again so the way on is one key away.
 */
export function SteamSignInFailed({ onRetry, onEnd }: { onRetry: () => void; onEnd: () => void }) {
  const retry = useRef<HTMLButtonElement>(null);
  useEffect(() => retry.current?.focus(), []);

  return (
    <section className="ig-qr" aria-labelledby="ig-qr-failed-title" data-testid="steam-sign-in-failed">
      <div className="ig-qr-copy">
        <h2 id="ig-qr-failed-title">Sign-in didn't work</h2>
        <p>Steam didn't finish signing you in, so your game hasn't started. Try again for a new code.</p>
        <div className="ig-qr-actions">
          <button type="button" className="lpill" onClick={onRetry} ref={retry}>
            Try again
            <span className="lpill-c">
              <Glyph name="arrow" size={18} />
            </span>
          </button>
          <button type="button" className="lpill lpill-sm" onClick={onEnd}>
            End
          </button>
        </div>
      </div>
    </section>
  );
}
