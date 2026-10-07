import { Glyph } from "./Glyph";
import { STEAM_LOGIN_URL } from "./steam";

/**
 * The one way in: Steam OpenID through the server's sign-in route. A signed-out
 * screen shows exactly this, wherever it would otherwise let you play.
 */
export function SignInWithSteam({
  small,
  href = STEAM_LOGIN_URL,
  label = "Sign in with Steam",
}: {
  small?: boolean;
  href?: string;
  /** The button's words, for a screen that speaks German. */
  label?: string;
}) {
  return (
    <a className={small ? "lpill lpill-sm steam-cta" : "lpill steam-cta"} href={href}>
      <span className="live-dot" aria-hidden="true" />
      {label}
      <span className="lpill-c">
        <Glyph name="arrow" size={small ? 16 : 18} />
      </span>
    </a>
  );
}
