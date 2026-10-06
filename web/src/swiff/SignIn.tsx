import { Glyph } from "./Glyph";
import { STEAM_LOGIN_URL } from "./steam";

/**
 * The one way in: Steam OpenID through the server's sign-in route. A signed-out
 * screen shows exactly this, wherever it would otherwise let you play.
 */
export function SignInWithSteam({ small, href = STEAM_LOGIN_URL }: { small?: boolean; href?: string }) {
  return (
    <a className={small ? "lpill lpill-sm steam-cta" : "lpill steam-cta"} href={href}>
      <span className="live-dot" aria-hidden="true" />
      Sign in with Steam
      <span className="lpill-c">
        <Glyph name="arrow" size={small ? 16 : 18} />
      </span>
    </a>
  );
}
