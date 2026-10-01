// The renter's sign-in session: who is booking, held in a cookie.
//
// Steam OpenID (steam.ts) proves once that the browser belongs to a Steam
// account. This turns that into a cookie the browser sends with every request
// afterwards, so the Booking API knows the renter without asking Steam again:
//
//   /auth/steam/return  Steam vouched for 7656…  ─►  Set-Cookie: swiff_session=<signed>
//   POST /api/bookings  Cookie: swiff_session=…  ─►  booking.renter_id = 7656…
//
// The cookie is a token signed with SESSION_SECRET (access.ts), not a key into
// a table: the server keeps nothing per session, and signing out only clears
// the browser's copy. A copied cookie stays valid until it expires, which is why
// it is HttpOnly (no script on the page can read it) and expires in a week.

import type { IncomingMessage, ServerResponse } from "node:http";
import { MIN_SECRET_LENGTH, mintRenterSession, verifyRenterSession } from "./access.js";
import { loginUrl, returnUrl } from "./steam.js";

export const SESSION_COOKIE = "swiff_session";

/** How long a sign-in lasts before Steam has to be asked again. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * SESSION_SECRET when it is long enough and not ROOM_SECRET; otherwise null and
 * nobody can sign in. Separate secrets keep a leak of one from forging the other.
 */
export function sessionSecretFromEnv(env: NodeJS.ProcessEnv): string | null {
  const secret = env.SESSION_SECRET?.trim() ?? "";
  if (secret.length < MIN_SECRET_LENGTH || secret === env.ROOM_SECRET?.trim()) return null;
  return secret;
}

/**
 * Cookie attributes for `origin`. Secure whenever the site is served over
 * https; local development on plain http would never get the cookie back.
 * SameSite=Lax keeps it off cross-site POSTs, so another site cannot book.
 */
function attributes(origin: string, maxAge: number): string {
  const secure = origin.startsWith("https:") ? "; Secure" : "";
  return `Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

/** The Set-Cookie value that signs the Steam account `steamId` in on `origin`. */
export function sessionCookie(secret: string, steamId: string, origin: string, now = Date.now()): string {
  const token = mintRenterSession(secret, steamId, SESSION_TTL_SECONDS, now);
  return `${SESSION_COOKIE}=${token}; ${attributes(origin, SESSION_TTL_SECONDS)}`;
}

/** The Set-Cookie value that signs whoever it reaches out. */
export function clearedCookie(origin: string): string {
  return `${SESSION_COOKIE}=; ${attributes(origin, 0)}`;
}

/** Every value the Cookie header gives the session cookie, in order. */
function sessionTokens(header: string | undefined): string[] {
  const tokens: string[] = [];
  for (const pair of (header ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq !== -1 && pair.slice(0, eq).trim() === SESSION_COOKIE) tokens.push(pair.slice(eq + 1).trim());
  }
  return tokens;
}

/**
 * The signed-in renter's Steam id, or null when the request carries no session
 * cookie that `secret` signed and that has not expired. Null secret: nobody.
 */
export function renterOf(req: IncomingMessage, secret: string | null, now = Date.now()): string | null {
  if (!secret) return null;
  for (const token of sessionTokens(req.headers.cookie)) {
    const session = verifyRenterSession(secret, token, now);
    if (session) return session.steamId;
  }
  return null;
}

/**
 * Steam sign-in on `origin`, the configured public origin (publicOriginFromEnv),
 * never one read from the request. `/auth/steam/login` bounces to Steam;
 * `/auth/steam/return` verifies what comes back and, when Steam vouches for the
 * player, signs them in with a session cookie. Without an origin or a
 * `sessionSecret` every sign-in reads as denied. Returns the handler, which
 * answers false for every other path.
 */
export function createSteamAuth({
  origin,
  sessionSecret,
}: {
  origin: string | null;
  sessionSecret: string | null;
}) {
  return async function serveSteamAuth(
    res: ServerResponse,
    urlPath: string,
    query: URLSearchParams,
  ): Promise<boolean> {
    if (urlPath !== "/auth/steam/login" && urlPath !== "/auth/steam/return") return false;

    if (!origin) {
      console.warn("[swiff] Steam sign-in refused: PUBLIC_ORIGIN is not set");
      res.writeHead(302, { location: "/#steam=denied", "cache-control": "no-store" }).end();
      return true;
    }

    if (urlPath === "/auth/steam/login") {
      res.writeHead(302, { location: loginUrl({ origin, returnTo: query.get("to") ?? "/" }) }).end();
      return true;
    }

    // Any failure here still lands the player back on the wall, flagged, rather
    // than on an error page they cannot act on.
    const back = await returnUrl({ origin, searchParams: query }).catch(() => null);
    if (!back?.steamId || !sessionSecret) {
      const denied = new URL(back?.location ?? `${origin}/`);
      denied.hash = "steam=denied";
      res.writeHead(302, { location: denied.toString(), "cache-control": "no-store" }).end();
      return true;
    }
    res
      .writeHead(302, {
        location: back.location,
        "set-cookie": sessionCookie(sessionSecret, back.steamId, origin),
        "cache-control": "no-store",
      })
      .end();
    return true;
  };
}
