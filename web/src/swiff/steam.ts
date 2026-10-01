// The browser half of Steam sign-in. The server signs the renter in with an
// HttpOnly session cookie the page cannot read (server/src/signin.ts), so who is
// signed in, and their profile, comes from GET /api/me. The return from Steam
// only flags the page `#steam=ok` or `#steam=denied`; this reads that once and
// clears it.

import type { VideoSource } from "@swiff/ui";
import { GAMES, artUrl, headerUrl, trailerUrl, type Game, type GameMedia } from "./data";

export type SteamProfile = {
  id: string;
  persona: string;
  avatar: string;
  hours: number;
  size: number;
  /** [appid, hours] for the curated nine. */
  owned: [number, number][];
  /** [appid, name, hours] for everything else. */
  games: [number, string, number][];
  lib: boolean;
};

export const STEAM_LOGIN_URL = "/auth/steam/login";

/** Who the server says is signed in (GET /api/me). */
export type Renter = { steamId: string; profile: SteamProfile };

/**
 * Read `#steam=…` and remove it. "ok" when the player has just signed in,
 * "denied" when they backed out at Steam, so the wall can say so rather than
 * silently staying signed out. Neither signs anyone in: only the server does.
 */
export function readSteamFragment(): "ok" | "denied" | null {
  const hash = location.hash.replace(/^#/, "");
  if (!hash.startsWith("steam=")) return null;

  history.replaceState(null, "", location.pathname + location.search);
  return hash === "steam=ok" ? "ok" : "denied";
}

/**
 * The renter the session cookie signs in, or null when nobody is signed in or
 * the server cannot be reached; signed out is the safe thing to show then.
 */
export async function fetchRenter(get: typeof fetch = fetch): Promise<Renter | null> {
  try {
    const response = await get("/api/me");
    return response.ok ? ((await response.json()) as Renter) : null;
  } catch {
    return null;
  }
}

/**
 * Read the signed-in renter's profile from Steam again rather than the copy the
 * server remembers, e.g. after they make their game details public. Null when
 * nobody is signed in or the server cannot be reached.
 */
export async function refreshRenter(get: typeof fetch = fetch): Promise<Renter | null> {
  try {
    const response = await get("/api/me/refresh", { method: "POST" });
    return response.ok ? ((await response.json()) as Renter) : null;
  } catch {
    return null;
  }
}

/**
 * What the signed-in wall can say about the renter's library: `unreadable` when
 * Steam gave no library at all (game details private, or Steam failed), `none`
 * when it did but none of it can be put on the wall, else `ok`.
 */
export type LibraryState = "ok" | "unreadable" | "none";

/** The renter's library state, as the wall explains it (LibraryState). */
export function libraryState(profile: SteamProfile): LibraryState {
  if (!profile.lib) return "unreadable";
  return profile.owned.length || profile.games.some(([, name]) => name) ? "ok" : "none";
}

/** End the sign-in session. Resolves once the server has cleared the cookie. */
export async function signOut(get: typeof fetch = fetch): Promise<void> {
  const response = await get("/api/signout", { method: "POST" });
  if (!response.ok) throw new Error(`sign-out failed: ${response.status}`);
}

/**
 * Sign out, then `done` once the server has cleared the cookie. If it has not,
 * `failed` instead: the cookie is still valid, so the renter is still signed in
 * and must be told rather than shown a signed-out page that reload undoes.
 */
export function endSignIn(done: () => void, failed: () => void, get: typeof fetch = fetch): Promise<void> {
  return signOut(get).then(done, failed);
}

/** Deterministic, so a library game keeps the same hue and machines every load. */
function hashOf(value: number | string): number {
  const text = String(value);
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Spread a library title across the shared machine pool. A card with no machine
 * would render as permanently unavailable, which reads as broken rather than busy.
 */
function machinesForLibraryGame(appid: number, pool: string[]): string[] {
  const h = hashOf(appid);
  const count = 2 + (h % 2);
  const picked = Array.from({ length: count }, (_, i) => pool[(h + i * 3) % pool.length]!);
  return [...new Set(picked)];
}

/**
 * A card for a game we know nothing about beyond its name and hours. Everything
 * is either real or obviously generic: no invented save points, no fake "last
 * played" moments.
 */
function cardFor(
  appid: number,
  name: string,
  pool: string[],
  extra: Pick<Game, "promise" | "personal" | "hours" | "owned"> & Partial<Game>,
): Game {
  const words = name.trim().split(/\s+/);
  return {
    id: `app${appid}`,
    title: name,
    t1: words[0] ?? name,
    t2: words.slice(1).join(" "),
    appid,
    focus: "60% 50%",
    hue: hashOf(appid) % 360,
    save: "Steam cloud save",
    machines: machinesForLibraryGame(appid, pool),
    ...extra,
  };
}

const libraryCard = (appid: number, name: string, hours: number, pool: string[]) =>
  cardFor(appid, name, pool, {
    promise: hours ? "Pick up where you left off." : "Ready when you are.",
    personal: hours ? `${hours} h played` : "In your library",
    hours,
    owned: true,
    fromLibrary: true,
  });

/** A game as the server's catalog describes it (server/src/catalog.ts). */
export type CatalogGame = {
  appid: number;
  name: string;
  free: boolean;
  art: { hero: string | null; capsule: string | null };
  preview: string | null;
  trailer: string | null;
};

const mediaOf = (game: CatalogGame): GameMedia => ({
  ...game.art,
  preview: game.preview,
  trailer: game.trailer,
});

/**
 * The signed-out wall: Steam's most played games, in chart order. Free-to-play
 * ones are playable straight away; the rest are shown for what they are.
 */
export const popularCards = (catalog: CatalogGame[], pool: string[]): Game[] =>
  catalog.map((game, index) =>
    cardFor(game.appid, game.name, pool, {
      promise: "One of the most played games on Steam right now.",
      personal: `#${index + 1} on Steam right now`,
      hours: 0,
      owned: game.free,
      f2p: game.free,
      save: game.free ? "Steam cloud save" : "New game",
      media: mediaOf(game),
    }),
  );

/** Put the catalog's art and trailers onto games it knows. */
export function withMedia(games: Game[], catalog: CatalogGame[]): Game[] {
  const media = new Map(catalog.map((g) => [g.appid, mediaOf(g)]));
  return games.map((game) => (media.has(game.appid) ? { ...game, media: media.get(game.appid) } : game));
}

/** A curated title the renter owns, told with their real hours instead of the demo story. */
function ownedCurated(game: Game, hours: number): Game {
  return {
    ...game,
    owned: true,
    hours,
    personal: hours ? `${hours} h played` : "In your library",
    save: "Steam cloud save",
    // Played games lead the wall (wallOrder); never the demo's "yesterday".
    last: hours ? "in your library" : undefined,
  };
}

/** A free-to-play game the renter does not own: playable by anyone, and marked Free. */
function freeCard(game: CatalogGame, pool: string[]): Game {
  const curated = GAMES.find((g) => g.appid === game.appid);
  const free = { owned: false, hours: 0, f2p: true, personal: "Free to play", save: "Steam cloud save" };
  if (curated) return { ...curated, ...free, last: undefined, media: mediaOf(game) };
  return cardFor(game.appid, game.name, pool, {
    ...free,
    promise: "Free to play. No purchase needed.",
    media: mediaOf(game),
  });
}

/**
 * The signed-in wall: only games the renter owns, plus free-to-play games
 * anyone can start, which `catalog` (Steam's store data) marks free. A paid game
 * the renter does not own is never on it, whether or not Steam let us read the
 * library; with no catalog yet, there are no free games either.
 */
export function applySteam(
  profile: SteamProfile,
  sharedMachineIds: string[],
  catalog: CatalogGame[] = [],
): Game[] {
  const owned = new Map(profile.owned);
  const curated = GAMES.filter((game) => owned.has(game.appid)).map((game) =>
    ownedCurated(game, owned.get(game.appid)!),
  );

  const known = new Set(GAMES.map((g) => g.appid));
  const extra = profile.games
    .filter(([appid, name]) => name && !known.has(appid))
    .map(([appid, name, hours]) => libraryCard(appid, name, hours ?? 0, sharedMachineIds));

  const mine = new Set([...curated, ...extra].map((g) => g.appid));
  const free = [
    ...new Map(catalog.filter((g) => g.free && !mine.has(g.appid)).map((g) => [g.appid, g])).values(),
  ];

  return [...curated, ...extra, ...free.map((g) => freeCard(g, sharedMachineIds))];
}

/**
 * Key art for a game: 2x for full-bleed use (the hero, the game screen), 1x for
 * a tile. The catalog's exact file when there is one — its 1x sits beside the
 * 2x — else the store capsule, else the guessable path.
 */
export function gameArt(game: Game, scale: 1 | 2 = 2): string {
  const hero = game.media?.hero;
  if (hero) return scale === 2 ? hero : hero.replace("library_hero_2x", "library_hero");
  return game.media?.capsule ?? artUrl(game.appid, scale);
}

/**
 * Painted under the key art where it fails to load. Only guessed art needs one;
 * every layer is downloaded, so art the catalog vouched for gets none.
 */
export const gameArtFallbacks = (game: Game): string[] => (game.media ? [] : [headerUrl(game.appid)]);

/**
 * The full trailer, for the hero and the game screen, as encodings in order of
 * preference: HLS where the browser plays it, then the short clip, then the
 * hand-authored nine's own trailer. The <video> picks the first it can play.
 */
export function gameTrailer(game: Game): VideoSource[] {
  const sources: VideoSource[] = [];
  if (game.media?.trailer) sources.push({ src: game.media.trailer, type: "application/vnd.apple.mpegurl" });
  if (game.media?.preview) sources.push({ src: game.media.preview, type: "video/mp4" });
  if (game.video) sources.push({ src: trailerUrl(game.video), type: "video/webm" });
  return sources;
}

/** The short clip for a hovered tile: quick to start, plays in every browser. */
export const gamePreview = (game: Game): VideoSource[] =>
  game.media?.preview ? [{ src: game.media.preview, type: "video/mp4" }] : gameTrailer(game);
