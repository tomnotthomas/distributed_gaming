/* Steam OpenID 2.0, with no server state at all.
 *
 * The earlier version parked the profile in a Map and handed the page a nonce
 * to fetch it back. That needs one long-lived process, which rules out every
 * free serverless host. So the profile now rides home in the URL fragment
 * instead: the server holds nothing between requests, and the same code runs
 * on a laptop, a Worker or a Vercel function.
 *
 * What comes back is deliberately small: persona, avatar, total hours, library
 * size, which of the wall's appids the player owns, and their most-played
 * games with names so the wall can render real titles. The library is capped
 * at LIBRARY_CAP entries because the whole payload has to fit in a URL
 * fragment — a 4000-game account must not produce a 200 KB URL.
 *
 * Nothing is written down anywhere. There is no database, no cookie, no file.
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

export function b64urlEncode(obj) {
  const json = JSON.stringify(obj);
  const b64 = Buffer.from(json, "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Build the redirect to Steam's own login page. */
export function loginUrl({ origin, returnTo }) {
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

/** Ask Steam whether the assertion it handed the browser is genuine. */
export async function verifyAssertion(searchParams) {
  const body = new URLSearchParams();
  for (const [k, v] of searchParams) if (k.startsWith("openid.")) body.set(k, v);
  body.set("openid.mode", "check_authentication");

  const r = await fetch(STEAM_OPENID, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await r.text();
  if (!/is_valid\s*:\s*true/.test(text)) return null;

  const claimed = searchParams.get("openid.claimed_id") || "";
  const m = claimed.match(/^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/);
  return m ? m[1] : null;
}

async function steamApi(apiKey, path, params) {
  const url = new URL(`https://api.steampowered.com/${path}`);
  url.searchParams.set("key", apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`steam ${path} -> ${r.status}`);
  return r.json();
}

/**
 * Read the public profile and owned games, then reduce to the small payload
 * the page needs. The full library is discarded here and never stored.
 */
export async function readProfile(apiKey, steamid) {
  const out = { id: steamid.slice(-4), persona: "", avatar: "", hours: 0, size: 0, owned: [], games: [], lib: false };
  if (!apiKey) return out;

  const summaries = await steamApi(apiKey, "ISteamUser/GetPlayerSummaries/v2/", {
    steamids: steamid,
  }).catch(() => null);
  const p = summaries?.response?.players?.[0];
  if (p) {
    out.persona = (p.personaname || "").slice(0, 40);
    out.avatar = p.avatarfull || p.avatarmedium || "";
  }

  const owned = await steamApi(apiKey, "IPlayerService/GetOwnedGames/v1/", {
    steamid,
    include_appinfo: "1",
    include_played_free_games: "1",
  }).catch(() => null);

  const list = owned?.response?.games;
  if (Array.isArray(list)) {
    out.lib = true;
    out.size = list.length;
    out.hours = Math.round(list.reduce((a, g) => a + (g.playtime_forever || 0), 0) / 60);
    const wall = new Set(WALL_APPIDS);
    // The curated nine keep their hand-written copy, so they only need hours.
    out.owned = list
      .filter((g) => wall.has(g.appid))
      .map((g) => [g.appid, Math.round((g.playtime_forever || 0) / 60)]);
    // Everything else needs a name, because nothing on the client knows it.
    out.games = list
      .filter((g) => !wall.has(g.appid) && g.name)
      .sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0))
      .slice(0, LIBRARY_CAP)
      .map((g) => [g.appid, String(g.name).slice(0, 48), Math.round((g.playtime_forever || 0) / 60)]);
  }
  return out;
}

/** Where to send the browser once Steam has answered. */
export async function returnUrl({ origin, searchParams, apiKey }) {
  const to = searchParams.get("to") || "/";
  const dest = new URL(to.startsWith("/") ? to : "/", origin);

  const steamid = await verifyAssertion(searchParams).catch(() => null);
  if (!steamid) {
    dest.hash = "steam=denied";
    return dest.toString();
  }

  let profile;
  try {
    profile = await readProfile(apiKey, steamid);
  } catch {
    profile = { id: steamid.slice(-4), persona: "", avatar: "", hours: 0, size: 0, owned: [], games: [], lib: false };
  }

  dest.hash = "steam=" + b64urlEncode(profile);
  return dest.toString();
}

/** Derive the public origin from the request, so deploys need no config. */
export function originFrom(headers, fallback) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN;
  const host = headers["x-forwarded-host"] || headers.host;
  if (!host) return fallback;
  const proto = headers["x-forwarded-proto"] || (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
