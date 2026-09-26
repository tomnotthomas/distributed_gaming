/* Steam OpenID 2.0, with no server state at all.
 *
 * Ported from prototypes/steam-auth.mjs, where the approach was settled: the
 * profile rides home in the URL fragment instead of being parked in a Map, so
 * this process holds nothing between requests and the same code runs on a
 * laptop, a Worker or a serverless function.
 *
 * What comes back is deliberately small: persona, avatar, total hours, library
 * size, which of the wall's appids the player owns, and their most-played games
 * with names so the wall can render real titles. The library is capped because
 * the whole payload has to fit in a URL fragment — a 4000-game account must not
 * produce a 200 KB URL.
 *
 * Nothing is written down anywhere. No database, no cookie, no file.
 */

const STEAM_OPENID = "https://steamcommunity.com/openid/login";

/** How many of the player's own games ride home in the fragment. */
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

const empty = (steamid: string): SteamProfile => ({
  id: steamid.slice(-4),
  persona: "",
  avatar: "",
  hours: 0,
  size: 0,
  owned: [],
  games: [],
  lib: false,
});

export function b64urlEncode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Build the redirect to Steam's own login page. */
export function loginUrl({ origin, returnTo }: { origin: string; returnTo?: string | undefined }): string {
  // Only same-site returns: an absolute `to` would make this an open redirector.
  const safeReturn = returnTo && returnTo.startsWith("/") ? returnTo : "/";
  const back = new URL("/auth/steam/return", origin);
  back.searchParams.set("to", safeReturn);

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
 * Ask Steam whether the assertion it handed the browser is genuine. Returns the
 * 17-digit steamid, or null — never trust the claimed_id without this round trip.
 */
export async function verifyAssertion(searchParams: URLSearchParams): Promise<string | null> {
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

async function steamApi(
  apiKey: string,
  path: string,
  params: Record<string, string>,
): Promise<any> {
  const url = new URL(`https://api.steampowered.com/${path}`);
  url.searchParams.set("key", apiKey);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`steam ${path} -> ${response.status}`);
  return response.json();
}

/**
 * Read the public profile and owned games, then reduce to the small payload the
 * page needs. The full library is discarded here and never stored.
 */
export async function readProfile(
  apiKey: string | undefined,
  steamid: string,
): Promise<SteamProfile> {
  const out = empty(steamid);
  if (!apiKey) return out;

  const summaries = await steamApi(apiKey, "ISteamUser/GetPlayerSummaries/v2/", {
    steamids: steamid,
  }).catch(() => null);
  const player = summaries?.response?.players?.[0];
  if (player) {
    out.persona = String(player.personaname ?? "").slice(0, 40);
    out.avatar = player.avatarfull ?? player.avatarmedium ?? "";
  }

  const owned = await steamApi(apiKey, "IPlayerService/GetOwnedGames/v1/", {
    steamid,
    include_appinfo: "1",
    include_played_free_games: "1",
  }).catch(() => null);

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

/** Where to send the browser once Steam has answered. */
export async function returnUrl({
  origin,
  searchParams,
  apiKey,
}: {
  origin: string;
  searchParams: URLSearchParams;
  apiKey?: string | undefined;
}): Promise<string> {
  const to = searchParams.get("to") ?? "/";
  const dest = new URL(to.startsWith("/") ? to : "/", origin);

  const steamid = await verifyAssertion(searchParams).catch(() => null);
  if (!steamid) {
    dest.hash = "steam=denied";
    return dest.toString();
  }

  // A Web API outage must not read as a denied sign-in: the player is who they
  // said they are, we just cannot list their library yet.
  const profile = await readProfile(apiKey, steamid).catch(() => empty(steamid));
  dest.hash = `steam=${b64urlEncode(profile)}`;
  return dest.toString();
}

/** Derive the public origin from the request, so deploys need no config. */
export function originFrom(
  headers: Record<string, string | string[] | undefined>,
  fallback: string,
): string {
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
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "::1" || name.endsWith(".localhost");
}
