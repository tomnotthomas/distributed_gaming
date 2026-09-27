// What to put on the wall before anyone signs in, and trailers for the games
// that end up on it. Everything here uses Steam's public, keyless endpoints:
//
//   charts   api.steampowered.com  ISteamChartsService/GetMostPlayedGames   (no key)
//   details  store.steampowered.com/api/appdetails                           (no key, ~200 req / 5 min / IP)
//   media    video.akamai.steamstatic.com store trailers                     (CDN)
//
// The store endpoint is the only one with a meaningful rate limit, so every
// answer is cached per appid for a day and requests run a few at a time.
// Most artwork needs no lookup: the client builds CDN URLs from the appid. Newer
// games keep theirs at hashed paths only the store knows, so the catalog also
// returns each game's real header image as the fallback.

const CHARTS_URL = "https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/";
const DETAILS_URL = "https://store.steampowered.com/api/appdetails";
const TRAILERS_URL = "https://video.akamai.steamstatic.com/store_trailers";

const HOUR = 60 * 60 * 1000;
const CHARTS_TTL = HOUR;
const DETAILS_TTL = 24 * HOUR;
/** Parallel store requests. Enough to warm a wall in seconds, few enough to stay polite. */
const CONCURRENCY = 4;

/**
 * Steam's software genres (Animation & Modeling … Game Development). Some tools
 * — Wallpaper Engine — are typed "game" by the store, and they chart, but
 * there is nothing to stream-play.
 */
const SOFTWARE_GENRES = new Set(["51", "52", "53", "54", "55", "56", "57", "58", "59", "60"]);

export const POPULAR_LIMIT = 24;
export const MEDIA_LIMIT = 48;

export type CatalogGame = {
  appid: number;
  name: string;
  /** Free to play: anyone can start it without owning it. */
  free: boolean;
  /**
   * A muted trailer: a direct .webm where Steam still serves one, otherwise the
   * HLS stream newer trailers only come as. Null when the game has none.
   */
  trailer: string | null;
  /** The store header image at its real (possibly hashed) URL. */
  header: string | null;
};

type Cached<T> = { at: number; value: Promise<T> };

const chartsCache: { entry: Cached<number[]> | null } = { entry: null };
const detailsCache = new Map<number, Cached<CatalogGame | null>>();

/** Drop every cached answer. Tests only. */
export function resetCatalog() {
  chartsCache.entry = null;
  detailsCache.clear();
}

/**
 * Cache a promise, not a value, so concurrent callers share one request. A
 * failed request is not kept: the next caller tries again.
 */
function remember<T>(
  entry: Cached<T> | null | undefined,
  ttl: number,
  now: number,
  load: () => Promise<T>,
  store: (entry: Cached<T>) => void,
  forget: () => void,
): Promise<T> {
  if (entry && now - entry.at < ttl) return entry.value;
  const value = load();
  store({ at: now, value });
  value.catch(forget);
  return value;
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}

/** Appids of Steam's most played games right now, most played first. */
export function mostPlayed(now = Date.now()): Promise<number[]> {
  return remember(
    chartsCache.entry,
    CHARTS_TTL,
    now,
    async () => {
      const body = await getJson(CHARTS_URL);
      const ranks = body?.response?.ranks;
      if (!Array.isArray(ranks)) throw new Error("charts: no ranks");
      return ranks.map((r: any) => Number(r.appid)).filter(Number.isInteger);
    },
    (entry) => (chartsCache.entry = entry),
    () => (chartsCache.entry = null),
  );
}

/**
 * Old trailers are still served as plain files; ones uploaded since Steam moved
 * to adaptive streaming only exist as HLS/DASH. Prefer the file — every browser
 * plays it — and fall back to HLS, which Chrome and Safari play natively.
 */
async function trailerFor(movie: any): Promise<string | null> {
  if (!movie || !Number.isInteger(movie.id)) return null;
  const file = `${TRAILERS_URL}/${movie.id}/movie480_vp9.webm`;
  const head = await fetch(file, { method: "HEAD" }).catch(() => null);
  if (head?.ok) return file;
  return typeof movie.hls_h264 === "string" ? movie.hls_h264 : null;
}

/** Store details reduced to what the wall shows. Null for anything that is not a game. */
export function gameDetails(appid: number, now = Date.now()): Promise<CatalogGame | null> {
  return remember(
    detailsCache.get(appid),
    DETAILS_TTL,
    now,
    async () => {
      const body = await getJson(`${DETAILS_URL}?appids=${appid}&l=english`);
      // Some appids answer under a different key (an edition that replaced the
      // base game), so read the one entry rather than body[appid].
      const entry: any = body && Object.values(body)[0];
      if (!entry?.success || entry.data?.type !== "game") return null;
      const genres: any[] = Array.isArray(entry.data.genres) ? entry.data.genres : [];
      if (genres.some((g) => SOFTWARE_GENRES.has(String(g.id)))) return null;
      const movies: any[] = Array.isArray(entry.data.movies) ? entry.data.movies : [];
      const movie = movies.find((m) => m.highlight) ?? movies[0];
      return {
        appid,
        name: String(entry.data.name ?? "").slice(0, 64),
        free: Boolean(entry.data.is_free),
        trailer: await trailerFor(movie),
        header: typeof entry.data.header_image === "string" ? entry.data.header_image : null,
      };
    },
    (entry) => detailsCache.set(appid, entry),
    () => detailsCache.delete(appid),
  );
}

/** Resolve appids a few at a time, in order, skipping failures and non-games, up to `limit` games. */
async function resolve(appids: number[], limit: number): Promise<CatalogGame[]> {
  const found: (CatalogGame | null)[] = new Array(appids.length).fill(null);
  let next = 0;
  let resolved = 0;
  const worker = async () => {
    while (next < appids.length && resolved < limit) {
      const index = next++;
      const game = await gameDetails(appids[index]!).catch(() => null);
      if (game?.name) {
        found[index] = game;
        resolved++;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return found.filter((g): g is CatalogGame => g !== null).slice(0, limit);
}

/** The most played games on Steam, with names and trailers. Empty if Steam is unreachable. */
export async function popularGames(limit = POPULAR_LIMIT): Promise<CatalogGame[]> {
  const appids = await mostPlayed().catch(() => []);
  return resolve(appids, limit);
}

/** Names and trailers for specific games, e.g. a signed-in player's library. */
export function gamesMedia(appids: number[]): Promise<CatalogGame[]> {
  const unique = [...new Set(appids.filter((id) => Number.isInteger(id) && id > 0))].slice(0, MEDIA_LIMIT);
  return resolve(unique, unique.length);
}
