// The browser half of the game catalog (server/src/catalog.ts): Steam's most
// played games for the signed-out wall, and trailers for a signed-in library.
// Both fail soft — an empty list means "keep what you have".

import type { CatalogGame } from "./steam";

async function getGames(path: string): Promise<CatalogGame[]> {
  const response = await fetch(path);
  if (!response.ok) return [];
  const body = await response.json();
  return Array.isArray(body?.games) ? body.games : [];
}

export const fetchPopular = () => getGames("/api/games/popular").catch(() => []);

export const fetchMedia = (appids: number[]) =>
  appids.length
    ? getGames(`/api/games/media?appids=${appids.join(",")}`).catch(() => [])
    : Promise.resolve([]);
