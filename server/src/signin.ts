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

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MIN_SECRET_LENGTH,
  mintRenterSession,
  mintSignInState,
  verifyRenterSession,
  verifySignInState,
} from "./access.js";
import { landingUrl, loginUrl, returnState, returnUrl } from "./steam.js";

export const SESSION_COOKIE = "swiff_session";

/**
 * The sign-in attempt: set when the browser leaves for Steam, required back
 * with a matching nonce when it returns, so a return URL made in another
 * browser (login CSRF) cannot sign this one in.
 */
export const SIGNIN_COOKIE = "swiff_signin";

/** How long a browser has to come back from Steam. */
export const SIGNIN_TTL_SECONDS = 10 * 60;

/** Where the sign-in cookie is sent: only Steam sign-in's own routes. */
const SIGNIN_PATH = "/auth/steam";

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
function attributes(origin: string, maxAge: number, path = "/"): string {
  const secure = origin.startsWith("https:") ? "; Secure" : "";
  return `Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
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

/** Every value the Cookie header gives the cookie `name`, in order. */
function cookieValues(header: string | undefined, name: string): string[] {
  const values: string[] = [];
  for (const pair of (header ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq !== -1 && pair.slice(0, eq).trim() === name) values.push(pair.slice(eq + 1).trim());
  }
  return values;
}

/** The Set-Cookie value that starts a sign-in attempt holding `nonce` on `origin`. */
export function signInCookie(secret: string, nonce: string, origin: string, now = Date.now()): string {
  const token = mintSignInState(secret, nonce, SIGNIN_TTL_SECONDS, now);
  return `${SIGNIN_COOKIE}=${token}; ${attributes(origin, SIGNIN_TTL_SECONDS, SIGNIN_PATH)}`;
}

/** The Set-Cookie value that ends the sign-in attempt, used or not. */
function clearedSignInCookie(origin: string): string {
  return `${SIGNIN_COOKIE}=; ${attributes(origin, 0, SIGNIN_PATH)}`;
}

/**
 * Whether the request carries a live sign-in attempt `secret` signed for the
 * same nonce as Steam's signed return_to. Compared in constant time.
 */
function startedHere(req: IncomingMessage, secret: string, query: URLSearchParams, now: number): boolean {
  const returned = returnState(query);
  if (!returned) return false;
  for (const token of cookieValues(req.headers.cookie, SIGNIN_COOKIE)) {
    const nonce = verifySignInState(secret, token, now);
    if (!nonce) continue;
    const a = Buffer.from(nonce);
    const b = Buffer.from(returned);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/**
 * The signed-in renter's Steam id, or null when the request carries no session
 * cookie that `secret` signed and that has not expired. Null secret: nobody.
 */
export function renterOf(req: IncomingMessage, secret: string | null, now = Date.now()): string | null {
  if (!secret) return null;
  for (const token of cookieValues(req.headers.cookie, SESSION_COOKIE)) {
    const session = verifyRenterSession(secret, token, now);
    if (session) return session.steamId;
  }
  return null;
}

/**
 * Steam sign-in on `origin`, the configured public origin (publicOriginFromEnv),
 * never one read from the request. `/auth/steam/login` starts an attempt (the
 * sign-in cookie) and bounces to Steam; `/auth/steam/return` requires that
 * attempt back with the nonce Steam signed, verifies the assertion and, when
 * Steam vouches for the player, signs them in with a session cookie. Without
 * an origin or a `sessionSecret` every sign-in reads as denied. Returns the
 * handler, which answers false for every other path.
 */
export function createSteamAuth({
  origin,
  sessionSecret,
}: {
  origin: string | null;
  sessionSecret: string | null;
}) {
  return async function serveSteamAuth(
    req: IncomingMessage,
    res: ServerResponse,
    urlPath: string,
    query: URLSearchParams,
  ): Promise<boolean> {
    if (urlPath !== "/auth/steam/login" && urlPath !== "/auth/steam/return") return false;

    if (!origin || !sessionSecret) {
      console.warn("[swiff] Steam sign-in refused: PUBLIC_ORIGIN or SESSION_SECRET is not set");
      res.writeHead(302, { location: "/#steam=denied", "cache-control": "no-store" }).end();
      return true;
    }

    if (urlPath === "/auth/steam/login") {
      const nonce = randomBytes(16).toString("base64url");
      res
        .writeHead(302, {
          location: loginUrl({ origin, returnTo: query.get("to") ?? "/", state: nonce }),
          "set-cookie": signInCookie(sessionSecret, nonce, origin),
          "cache-control": "no-store",
        })
        .end();
      return true;
    }

    // The attempt is spent either way: one return per sign-in.
    const cleared = clearedSignInCookie(origin);
    // Any failure here still lands the player back on the wall, flagged, rather
    // than on an error page they cannot act on. A return this browser did not
    // start is refused before Steam is asked.
    const ours = startedHere(req, sessionSecret, query, Date.now());
    const back = ours ? await returnUrl({ origin, searchParams: query }).catch(() => null) : null;
    if (!back?.steamId) {
      const denied = back ? new URL(back.location) : landingUrl(origin, query.get("to"));
      denied.hash = "steam=denied";
      res
        .writeHead(302, { location: denied.toString(), "set-cookie": cleared, "cache-control": "no-store" })
        .end();
      return true;
    }
    res
      .writeHead(302, {
        location: back.location,
        "set-cookie": [sessionCookie(sessionSecret, back.steamId, origin), cleared],
        "cache-control": "no-store",
      })
      .end();
    return true;
  };
}
