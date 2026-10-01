/* Steam OpenID 2.0, and the profile the page shows for a signed-in renter.
 *
 * Ported from prototypes/steam-auth.mjs. Sign-in is two redirects: to Steam,
 * and back to /auth/steam/return, where the assertion is checked with Steam
 * itself. What it proves, the 17-digit Steam id, becomes the renter's sign-in
 * session cookie (signin.ts); the page then reads its profile from GET /api/me.
 *
 * What the profile holds is deliberately small: persona, avatar, total hours,
 * library size, which of the wall's appids the player owns, and their
 * most-played games with names so the wall can render real titles. The library
 * is capped: a 4000-game account must not make every page load ship it all.
 *
 * Nothing about the profile is written down. It is read from Steam when asked
 * for and discarded once answered.
 */

const STEAM_OPENID = "https://steamcommunity.com/openid/login";

/** How many of the player's own games the profile names. */
export const LIBRARY_CAP = 14;

/** The nine hand-authored titles on the wall, which keep their own copy. */
export const WALL_APPIDS = [
  1245620, // Elden Ring
  2073850, // THE FINALS
  1091500, // Cyberpunk 2077
  1086940, // Baldur's Gate 3
  553850, // Helldivers 2
  1551360, // Forza Horizon 5
  730, // Counter-Strike 2
  1030300, // Hollow Knight: Silksong
  1716740, // Starfield
];

/** `[appid, hours]` for the curated nine; `[appid, name, hours]` for the rest. */
export type OwnedEntry = [number, number];
export type LibraryEntry = [number, string, number];

export type SteamProfile = {
  id: string;
  persona: string;
  avatar: string;
  hours: number;
  size: number;
  owned: OwnedEntry[];
  games: LibraryEntry[];
  lib: boolean;
};

/** The profile of a player Steam vouched for but whose details cannot be read. */
export const emptyProfile = (steamid: string): SteamProfile => ({
  id: steamid.slice(-4),
  persona: "",
  avatar: "",
  hours: 0,
  size: 0,
  owned: [],
  games: [],
  lib: false,
});

/**
 * Build the redirect to Steam's own login page. `state` is the sign-in
 * attempt's nonce: it rides in return_to, which Steam signs, so the return can
 * be matched to the browser that started it (signin.ts).
 */
export function loginUrl({
  origin,
  returnTo,
  state,
}: {
  origin: string;
  returnTo?: string | undefined;
  state?: string | undefined;
}): string {
  // Only same-site returns: an absolute `to` would make this an open redirector.
  const safeReturn = returnTo && returnTo.startsWith("/") ? returnTo : "/";
  const back = new URL("/auth/steam/return", origin);
  back.searchParams.set("to", safeReturn);
  if (state) back.searchParams.set("state", state);

  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": back.toString(),
    "openid.realm": origin,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });
  return `${STEAM_OPENID}?${params}`;
}

/**
 * Ask Steam whether the assertion it handed the browser is genuine, and that it
 * was made by Steam for this site's own return route. Returns the 17-digit
 * steamid, or null — never trust the claimed_id without both checks.
 */
export async function verifyAssertion(searchParams: URLSearchParams, origin: string): Promise<string | null> {
  if (searchParams.get("openid.op_endpoint") !== STEAM_OPENID) return null;
  if (!isOurReturn(searchParams.get("openid.return_to"), origin)) return null;

  const body = new URLSearchParams();
  for (const [key, value] of searchParams) if (key.startsWith("openid.")) body.set(key, value);
  body.set("openid.mode", "check_authentication");

  const response = await fetch(STEAM_OPENID, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!/is_valid\s*:\s*true/.test(await response.text())) return null;

  const claimed = searchParams.get("openid.claimed_id") ?? "";
  const match = claimed.match(/^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/);
  return match ? match[1]! : null;
}

/** The sign-in nonce carried in the signed return_to, or null when it has none. */
export function returnState(searchParams: URLSearchParams): string | null {
  const returnTo = searchParams.get("openid.return_to");
  if (!returnTo || !URL.canParse(returnTo)) return null;
  return new URL(returnTo).searchParams.get("state");
}

/** Whether a signed return_to points at this origin's /auth/steam/return. */
function isOurReturn(returnTo: string | null, origin: string): boolean {
  if (!returnTo || !URL.canParse(returnTo)) return false;
  const url = new URL(returnTo);
  return url.origin === new URL(origin).origin && url.pathname === "/auth/steam/return";
}

/** How long one Steam Web API call may take before the read gives up. */
export const STEAM_API_TIMEOUT_MS = 3_000;

/** How long a profile read from Steam is served again without asking Steam. */
export const PROFILE_TTL_MS = 5 * 60_000;

/** How many signed-in renters' profiles are kept at once. */
export const PROFILE_CACHE_MAX = 1_000;

/** One Web API call, abandoned after `timeoutMs`. Throws on any failure. */
async function steamApi(
  apiKey: string,
  path: string,
  params: Record<string, string>,
  timeoutMs: number,
): Promise<any> {
  const url = new URL(`https://api.steampowered.com/${path}`);
  url.searchParams.set("key", apiKey);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`steam ${path} -> ${response.status}`);
  return response.json();
}

/**
 * Read the public profile and owned games, then reduce to the small payload the
 * page needs. The full library is discarded here and never stored. Rejects when
 * Steam fails or takes longer than `timeoutMs`, so a failed read is never
 * mistaken for a real profile.
 */
export async function readProfile(
  apiKey: string | undefined,
  steamid: string,
  timeoutMs = STEAM_API_TIMEOUT_MS,
): Promise<SteamProfile> {
  const out = emptyProfile(steamid);
  if (!apiKey) return out;

  const summaries = await steamApi(
    apiKey,
    "ISteamUser/GetPlayerSummaries/v2/",
    { steamids: steamid },
    timeoutMs,
  );
  const player = summaries?.response?.players?.[0];
  if (player) {
    out.persona = String(player.personaname ?? "").slice(0, 40);
    out.avatar = player.avatarfull ?? player.avatarmedium ?? "";
  }

  const owned = await steamApi(
    apiKey,
    "IPlayerService/GetOwnedGames/v1/",
    { steamid, include_appinfo: "1", include_played_free_games: "1" },
    timeoutMs,
  );

  const list = owned?.response?.games;
  if (!Array.isArray(list)) return out;

  const hours = (game: any) => Math.round((game.playtime_forever ?? 0) / 60);
  const wall = new Set(WALL_APPIDS);
  out.lib = true;
  out.size = list.length;
  out.hours = Math.round(list.reduce((sum: number, g: any) => sum + (g.playtime_forever ?? 0), 0) / 60);
  // The curated nine keep their hand-written copy, so they only need hours.
  out.owned = list.filter((g: any) => wall.has(g.appid)).map((g: any): OwnedEntry => [g.appid, hours(g)]);
  // Everything else needs a name, because nothing on the client knows it.
  out.games = list
    .filter((g: any) => !wall.has(g.appid) && g.name)
    .sort((a: any, b: any) => (b.playtime_forever ?? 0) - (a.playtime_forever ?? 0))
    .slice(0, LIBRARY_CAP)
    .map((g: any): LibraryEntry => [g.appid, String(g.name).slice(0, 48), hours(g)]);
  return out;
}

/** How soon after the last read a renter's refresh may ask Steam again. */
export const PROFILE_REFRESH_MIN_MS = 10_000;

/** A profile lookup; `fresh` asks Steam again rather than serving a remembered read. */
export type ProfileReader = (steamId: string, options?: { fresh?: boolean }) => Promise<SteamProfile>;

/**
 * `read`, remembered per Steam id for `ttlMs` so reloads do not spend the shared
 * Web API quota. Holds at most `max` profiles, dropping the oldest first. A read
 * that rejects is not remembered: the next request asks Steam again. `fresh`
 * skips the remembered read, e.g. after the renter makes their library public,
 * unless it is under `refreshMinMs` old, so a mashed retry button costs one read.
 * Concurrent lookups for one Steam id share the read already in flight.
 */
export function cachedProfiles(
  read: (steamId: string) => Promise<SteamProfile>,
  {
    ttlMs = PROFILE_TTL_MS,
    max = PROFILE_CACHE_MAX,
    refreshMinMs = PROFILE_REFRESH_MIN_MS,
    now = Date.now,
  } = {},
): ProfileReader {
  const cache = new Map<string, { profile: SteamProfile; at: number }>();
  // Reads still waiting on Steam, so two tabs refreshing at once share one.
  const pending = new Map<string, Promise<SteamProfile>>();
  return async (steamId, { fresh = false } = {}) => {
    const inFlight = pending.get(steamId);
    if (inFlight) return inFlight;
    const hit = cache.get(steamId);
    if (hit && now() - hit.at < (fresh ? refreshMinMs : ttlMs)) return hit.profile;
    const reading = read(steamId).then((profile) => {
      cache.delete(steamId);
      if (cache.size >= max) cache.delete(cache.keys().next().value!);
      cache.set(steamId, { profile, at: now() });
      return profile;
    });
    pending.set(steamId, reading);
    try {
      return await reading;
    } finally {
      pending.delete(steamId);
    }
  };
}

/** The page on `origin` the player asked to come back to (`to`), or its root for anything else. */
export function landingUrl(origin: string, to: string | null): URL {
  const path = to ?? "/";
  const dest = new URL(path.startsWith("/") ? path : "/", origin);
  return dest.origin === new URL(origin).origin ? dest : new URL("/", origin);
}

/**
 * Where to send the browser once Steam has answered, and the Steam id Steam
 * vouched for (null when it did not). The page it lands on is flagged
 * `#steam=ok` or `#steam=denied`; the caller signs the renter in.
 */
export async function returnUrl({
  origin,
  searchParams,
}: {
  origin: string;
  searchParams: URLSearchParams;
}): Promise<{ location: string; steamId: string | null }> {
  const dest = landingUrl(origin, searchParams.get("to"));
  const steamId = await verifyAssertion(searchParams, origin).catch(() => null);
  dest.hash = steamId ? "steam=ok" : "steam=denied";
  return { location: dest.toString(), steamId };
}

/**
 * The one origin Steam sign-in trusts: PUBLIC_ORIGIN, or http://localhost:<port>
 * outside production. Null when PUBLIC_ORIGIN is unset in production or is not
 * an http(s) URL, and then nobody can sign in. Never read from request headers,
 * which the client controls.
 */
export function publicOriginFromEnv(env: NodeJS.ProcessEnv, port: number): string | null {
  const configured = env.PUBLIC_ORIGIN?.trim();
  if (!configured) return env.NODE_ENV === "production" ? null : `http://localhost:${port}`;
  if (!URL.canParse(configured)) return null;
  const url = new URL(configured);
  return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
}

/**
 * Derive the public origin from the request, for the signaling URL a claim
 * hands out. Client-controlled: never use it for sign-in (publicOriginFromEnv).
 */
export function originFrom(headers: Record<string, string | string[] | undefined>, fallback: string): string {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN;
  const forwarded = headers["x-forwarded-host"] ?? headers.host;
  const host = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (!host) return fallback;
  const proto = headers["x-forwarded-proto"] ?? (isLoopback(host) ? "http" : "https");
  return `${Array.isArray(proto) ? proto[0] : proto}://${host}`;
}

/**
 * Local development is plain http. Guessing https for 127.0.0.1 builds an
 * openid.realm Steam cannot reach, and it rejects the whole sign-in — so every
 * loopback form has to be recognised, not just the word "localhost".
 */
function isLoopback(host: string): boolean {
  const name = host
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "::1" || name.endsWith(".localhost");
}
