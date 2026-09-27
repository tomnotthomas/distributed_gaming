// The browser half of Steam sign-in. The server put the profile in the URL
// fragment (see server/src/steam.ts); this reads it once, then clears it so a
// refresh or a shared link does not carry someone's library around.

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

function decode(fragment: string): SteamProfile | null {
  try {
    const base64 = fragment.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64)) as SteamProfile;
  } catch {
    return null;
  }
}

/**
 * Read `#steam=…` and remove it. Returns "denied" when the player backed out at
 * Steam, so the wall can say so rather than silently staying signed out.
 */
export function readSteamFragment(): SteamProfile | "denied" | null {
  const hash = location.hash.replace(/^#/, "");
  if (!hash.startsWith("steam=")) return null;

  history.replaceState(null, "", location.pathname + location.search);
  const payload = hash.slice("steam=".length);
  return payload === "denied" ? "denied" : decode(payload);
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
  art: { hero: string | null; capsule: string | null; header: string | null };
  preview: string | null;
  trailer: string | null;
};

const mediaOf = (game: CatalogGame): GameMedia => ({
  hero: game.art.hero ?? undefined,
  capsule: game.art.capsule ?? game.art.header ?? undefined,
  preview: game.preview ?? undefined,
  trailer: game.trailer ?? undefined,
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
      popularRank: index + 1,
    }),
  );

/** Put the catalog's art and trailers onto games it knows. */
export function withMedia(games: Game[], catalog: CatalogGame[]): Game[] {
  const media = new Map(catalog.map((g) => [g.appid, mediaOf(g)]));
  return games.map((game) => (media.has(game.appid) ? { ...game, media: media.get(game.appid) } : game));
}

/**
 * Merge a real library onto the wall: light up the curated titles the player
 * owns, then give every other game its own card.
 */
export function applySteam(profile: SteamProfile, sharedMachineIds: string[]): Game[] {
  const owned = new Map(profile.owned);
  const curated = GAMES.map((game) => {
    const hours = owned.get(game.appid);
    if (hours === undefined) return { ...game, owned: Boolean(game.f2p), hours: game.f2p ? game.hours : 0 };
    return { ...game, owned: true, hours, last: hours ? "in your library" : game.last };
  });

  const known = new Set(GAMES.map((g) => g.appid));
  const extra = profile.games
    .filter(([appid, name]) => name && !known.has(appid))
    .map(([appid, name, hours]) => libraryCard(appid, name, hours ?? 0, sharedMachineIds));

  return [...curated, ...extra];
}

/** Steam art for any game: the catalog's exact file, else the guessable 2x key art. */
export const gameArt = (game: Game) => game.media?.hero ?? artUrl(game.appid);

/**
 * What to paint under the key art, in order, for games that lack it: the 1x key
 * art (older games have no 2x), then the store capsule or header.
 */
export const gameArtFallbacks = (game: Game): string[] => [
  artUrl(game.appid, 1),
  game.media?.capsule ?? headerUrl(game.appid),
];

/** Chrome and Safari play HLS in a plain <video>; Firefox does not. */
const playsHls = () =>
  typeof document !== "undefined" && document.createElement("video").canPlayType("application/vnd.apple.mpegurl") !== "";

/**
 * The full trailer, for the hero and the game screen: HLS where the browser
 * plays it, else the short clip, else the hand-authored nine's own trailer.
 */
export const gameTrailer = (game: Game): string | null =>
  (playsHls() ? game.media?.trailer : undefined) ??
  game.media?.preview ??
  (game.video ? trailerUrl(game.video) : null);

/** The short clip for a hovered tile: quick to start, plays in every browser. */
export const gamePreview = (game: Game): string | null => game.media?.preview ?? gameTrailer(game);
