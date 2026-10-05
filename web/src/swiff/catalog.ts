// The browser half of the game catalog (server/src/catalog.ts): Steam's most
// played games for the signed-out wall, and trailers for a signed-in library.
// The server sends only games Swiff can run (server/src/playable.ts). Both fail
// soft — an empty list means "keep what you have".

import type { CatalogGame } from "./steam";

/**
 * The signed-out wall's read: Steam's most played games Swiff can run, and
 * which of the wall's hand-authored nine (data.ts) it can run, by appid, each
 * with the launcher account it asks for at start.
 */
export type Popular = { games: CatalogGame[]; wall: Pick<CatalogGame, "appid" | "requiresAccount">[] };

async function getBody(path: string): Promise<any> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}

const gamesOf = (body: any): CatalogGame[] => (Array.isArray(body?.games) ? body.games : []);

/** The most played games, or null when the server did not answer: nothing is vouched for then. */
export const fetchPopular = (): Promise<Popular | null> =>
  getBody("/api/games/popular")
    .then((body) => ({
      games: gamesOf(body),
      wall: Array.isArray(body?.wall) ? body.wall.filter((entry: any) => Number.isInteger(entry?.appid)) : [],
    }))
    .catch(() => null);

export const fetchMedia = (appids: number[]) =>
  appids.length
    ? getBody(`/api/games/media?appids=${appids.join(",")}`)
        .then(gamesOf)
        .catch(() => [] as CatalogGame[])
    : Promise.resolve([]);
