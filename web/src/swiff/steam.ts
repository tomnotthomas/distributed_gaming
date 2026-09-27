// The browser half of Steam sign-in. The server put the profile in the URL
// fragment (see server/src/steam.ts); this reads it once, then clears it so a
// refresh or a shared link does not carry someone's library around.

import { GAMES, artUrl, type Game } from "./data";

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
function cardFor(appid: number, name: string, hours: number, pool: string[]): Game {
  const words = name.trim().split(/\s+/);
  return {
    id: `app${appid}`,
    title: name,
    t1: words[0] ?? name,
    t2: words.slice(1).join(" "),
    appid,
    focus: "60% 50%",
    promise: hours ? "Pick up where you left off." : "Ready when you are.",
    personal: hours ? `${hours} h played` : "In your library",
    hue: hashOf(appid) % 360,
    hours,
    owned: true,
    save: "Steam cloud save",
    machines: machinesForLibraryGame(appid, pool),
    fromLibrary: true,
  };
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
    .map(([appid, name, hours]) => cardFor(appid, name, hours ?? 0, sharedMachineIds));

  return [...curated, ...extra];
}

/** Steam art for any appid, curated or from the library. */
export const gameArt = (game: Game) => artUrl(game.appid);
