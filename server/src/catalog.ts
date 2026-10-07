// What to put on the wall before anyone signs in, and the art and trailers for
// the games that end up on it. Two of Steam's public, keyless endpoints:
//
//   charts  ISteamChartsService/GetMostPlayedGames   the live most-played list
//   items   IStoreBrowseService/GetItems              names, type, free-to-play,
//                                                     exact art files, trailers
//
// GetItems takes many appids per request, so a whole wall is one call. Answers
// are cached per appid for a day and the chart for an hour.

const CHARTS_URL = "https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/";
const ITEMS_URL = "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/";
const ASSET_HOST = "https://shared.akamai.steamstatic.com/store_item_assets/";
const TRAILER_HOST = "https://video.akamai.steamstatic.com/store_trailers/";

const HOUR = 60 * 60 * 1000;
const CHARTS_TTL = HOUR;
const ITEMS_TTL = 24 * HOUR;
/** Appids per GetItems request. */
export const BATCH = 50;
/** GetItems' `type` for a game; software, DLC and the rest are other numbers. */
const TYPE_GAME = 0;

const POPULAR_LIMIT = 24;
const MEDIA_LIMIT = 48;
/** Games remembered at once. Anyone can ask for any appid, so the cache must not grow without bound. */
const MAX_CACHED_ITEMS = 5000;

export type CatalogGame = {
  appid: number;
  name: string;
  /** Free to play: anyone can start it without owning it. */
  free: boolean;
  /** Exact art files, at 2x where Steam has them. New games' paths are hashed, so they cannot be guessed. */
  art: {
    /** Wide, logo-free key art (3840×1240 at 2x). */
    hero: string | null;
    /** The store's main capsule (1232×706 at 2x), else its header, for when there is no hero. */
    capsule: string | null;
  };
  /** An ~8 s .mp4 clip Steam cuts for hover previews. Plays in every browser. */
  preview: string | null;
  /** The full highlight trailer as HLS, which Chrome and Safari play natively. */
  trailer: string | null;
};

type Cached<T> = { at: number; value: Promise<T> };

const cache = {
  charts: null as Cached<number[]> | null,
  items: new Map<number, Cached<CatalogGame | null>>(),
};

/** Drop every cached answer. Tests only. */
export function resetCatalog() {
  cache.charts = null;
  cache.items.clear();
}

const fresh = <T>(entry: Cached<T> | null | undefined, ttl: number, now: number): entry is Cached<T> =>
  Boolean(entry && now - entry.at < ttl);

/** GET a JSON body from Steam; a non-2xx answer throws with its status. */
export async function getJson(url: URL | string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}

/**
 * Appids of Steam's most played games right now, most played first. Shared by
 * concurrent callers; a failure is not kept, so the next caller retries.
 */
export function mostPlayed(now = Date.now()): Promise<number[]> {
  if (fresh(cache.charts, CHARTS_TTL, now)) return cache.charts.value;
  const value = getJson(CHARTS_URL).then((body) => {
    const ranks = body?.response?.ranks;
    if (!Array.isArray(ranks)) throw new Error("charts: no ranks");
    return ranks.map((r: any) => Number(r.appid)).filter(Number.isInteger) as number[];
  });
  cache.charts = { at: now, value };
  value.catch(() => (cache.charts = null));
  return value;
}

/** One GetItems store item reduced to what the wall shows; null for anything that is not a visible game. */
export function toCatalogGame(item: any): CatalogGame | null {
  if (item?.success === false || item?.visible === false) return null;
  if (item?.type !== TYPE_GAME || !item?.name) return null;

  const assets = item.assets ?? {};
  const asset = (...keys: string[]) => {
    const file = keys.map((k) => assets[k]).find((f) => typeof f === "string");
    return file && typeof assets.asset_url_format === "string"
      ? ASSET_HOST + assets.asset_url_format.replace("${FILENAME}", file)
      : null;
  };

  const highlight = item.trailers?.highlights?.[0];
  const preview = (highlight?.microtrailer ?? []).find((m: any) => m?.type === "video/mp4")?.filename;
  const hls = (highlight?.adaptive_trailers ?? []).find((t: any) => t?.encoding === "hls_h264")?.cdn_path;

  return {
    appid: Number(item.appid),
    name: String(item.name).slice(0, 64),
    free: Boolean(item.is_free),
    art: {
      hero: asset("library_hero_2x", "library_hero"),
      capsule: asset("main_capsule_2x", "main_capsule", "header_2x", "header"),
    },
    preview: typeof preview === "string" ? TRAILER_HOST + preview : null,
    trailer: typeof hls === "string" ? TRAILER_HOST + hls : null,
  };
}

/** GetItems' store items for up to BATCH appids, with the parts `dataRequest` asks for; undefined when it lists none. */
export async function storeItems(appids: number[], dataRequest: object): Promise<any[] | undefined> {
  const url = new URL(ITEMS_URL);
  url.searchParams.set(
    "input_json",
    JSON.stringify({
      ids: appids.map((appid) => ({ appid })),
      context: { language: "english", country_code: "US" },
      data_request: dataRequest,
    }),
  );
  return (await getJson(url))?.response?.store_items;
}

async function fetchItems(appids: number[]): Promise<Map<number, CatalogGame | null>> {
  const items: any[] = (await storeItems(appids, { include_assets: true, include_trailers: true })) ?? [];
  return new Map(items.map((item) => [Number(item.appid), toCatalogGame(item)]));
}

/**
 * Catalog entries for appids, in the order given, skipping anything that is not
 * a game. Uncached appids go to Steam in batches; concurrent callers share them.
 * A failed lookup is skipped too, unless `strict`, which rejects instead.
 */
export async function catalogGames(appids: number[], now = Date.now(), strict = false): Promise<CatalogGame[]> {
  const missing = appids.filter((id) => !fresh(cache.items.get(id), ITEMS_TTL, now));
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const result = fetchItems(batch);
    for (const id of batch) {
      const value = result.then((found) => found.get(id) ?? null);
      cache.items.delete(id); // re-insert, so Map order stays oldest-first
      cache.items.set(id, { at: now, value });
      value.catch(() => cache.items.delete(id));
    }
  }
  // Forget the oldest entries past the cap; this call's own appids are the newest.
  for (const id of cache.items.keys()) {
    if (cache.items.size <= MAX_CACHED_ITEMS) break;
    cache.items.delete(id);
  }
  const games = await Promise.all(
    appids.map((id) => {
      const { value } = cache.items.get(id)!;
      return strict ? value : value.catch(() => null);
    }),
  );
  return games.filter((g): g is CatalogGame => g !== null);
}

/**
 * The most played games on Steam that `keep` lets through (playable.ts), with
 * art and trailers. Empty if Steam is unreachable.
 */
export async function popularGames(
  limit = POPULAR_LIMIT,
  keep: (appid: number) => boolean = () => true,
): Promise<CatalogGame[]> {
  const appids = (await mostPlayed().catch(() => [] as number[])).filter(keep);
  // Ask for a margin over the limit: some charting apps are software, not games.
  const games = await catalogGames(appids.slice(0, Math.ceil(limit * 1.5)));
  return games.slice(0, limit);
}

/**
 * Art and trailers for up to `limit` specific games that `keep` lets through, e.g. a signed-in
 * player's library. Rejects if `strict` and the store could not be asked (catalogGames).
 */
export function gamesMedia(
  appids: number[],
  keep: (appid: number) => boolean = () => true,
  limit = MEDIA_LIMIT,
  strict = false,
): Promise<CatalogGame[]> {
  const unique = [...new Set(appids.filter((id) => Number.isInteger(id) && id > 0 && keep(id)))].slice(
    0,
    limit,
  );
  return catalogGames(unique, Date.now(), strict);
}
