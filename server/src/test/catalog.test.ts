// The catalog without the network: fetch is stubbed per URL, so these pin the
// decisions (what counts as a game, which art and trailer win, what is cached
// and batched) and not Steam's uptime.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  catalogGames,
  gamesMedia,
  lookUpGamesMedia,
  mostPlayed,
  popularGames,
  resetCatalog,
  toCatalogGame,
} from "../catalog.js";

const realFetch = globalThis.fetch;
beforeEach(resetCatalog);
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Answer = { ok: boolean; status?: number; body?: unknown };

/** Answer fetches from one router, recording every URL asked for. */
function stubFetch(route: (url: string) => Answer | undefined) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    const answer = route(url) ?? { ok: false, status: 404 };
    return { ok: answer.ok, status: answer.status ?? 200, json: async () => answer.body };
  }) as typeof fetch;
  return calls;
}

/** The appids a GetItems request asked for. */
const askedFor = (url: string): number[] =>
  JSON.parse(new URL(url).searchParams.get("input_json")!).ids.map((i: any) => i.appid);

/** A store item as GetItems returns it; override any field. */
const item = (appid: number, extra: Record<string, unknown> = {}) => ({
  appid,
  success: 1,
  visible: true,
  type: 0,
  name: `Game ${appid}`,
  is_free: false,
  assets: {
    asset_url_format: `steam/apps/${appid}/\${FILENAME}?t=1`,
    library_hero: "h/library_hero.jpg",
    library_hero_2x: "h/library_hero_2x.jpg",
    main_capsule_2x: "c/capsule_616x353_2x.jpg",
    header: "x/header.jpg",
  },
  trailers: {
    highlights: [
      {
        microtrailer: [
          { filename: `${appid}/1/micro.webm`, type: "video/webm" },
          { filename: `${appid}/1/micro.mp4`, type: "video/mp4" },
        ],
        adaptive_trailers: [
          { cdn_path: `${appid}/1/dash_h264.mpd`, encoding: "dash_h264" },
          { cdn_path: `${appid}/1/hls_264_master.m3u8`, encoding: "hls_h264" },
        ],
      },
    ],
  },
  ...extra,
});

const itemsAnswer = (items: unknown[]): Answer => ({ ok: true, body: { response: { store_items: items } } });

describe("toCatalogGame", () => {
  it("builds exact art URLs, preferring the 2x files", () => {
    const game = toCatalogGame(item(10))!;
    assert.deepEqual(game.art, {
      hero: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/h/library_hero_2x.jpg?t=1",
      capsule:
        "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/c/capsule_616x353_2x.jpg?t=1",
    });
  });

  it("falls back from the capsule to the header", () => {
    const game = toCatalogGame(
      item(10, { assets: { asset_url_format: "steam/apps/10/${FILENAME}", header: "x/header.jpg" } }),
    )!;
    assert.equal(
      game.art.capsule,
      "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/x/header.jpg",
    );
  });

  it("uses the mp4 microtrailer for previews and HLS for the full trailer", () => {
    const game = toCatalogGame(item(10))!;
    assert.equal(game.preview, "https://video.akamai.steamstatic.com/store_trailers/10/1/micro.mp4");
    assert.equal(
      game.trailer,
      "https://video.akamai.steamstatic.com/store_trailers/10/1/hls_264_master.m3u8",
    );
  });

  it("keeps a game without trailers or art, with nulls", () => {
    const game = toCatalogGame(item(10, { trailers: {}, assets: {} }))!;
    assert.deepEqual([game.preview, game.trailer, game.art.hero], [null, null, null]);
  });

  it("drops software, hidden items and failed lookups", () => {
    assert.equal(toCatalogGame(item(10, { type: 6 })), null);
    assert.equal(toCatalogGame(item(10, { visible: false })), null);
    assert.equal(toCatalogGame({ appid: 10, success: false }), null);
  });
});

describe("mostPlayed", () => {
  it("returns the chart's appids in rank order, once per hour", async () => {
    const calls = stubFetch(() => ({
      ok: true,
      body: { response: { ranks: [{ appid: 730 }, { appid: 570 }] } },
    }));
    assert.deepEqual(await mostPlayed(0), [730, 570]);
    await mostPlayed(30 * 60 * 1000);
    assert.equal(calls.length, 1);
    await mostPlayed(61 * 60 * 1000);
    assert.equal(calls.length, 2);
  });

  it("does not keep a failure, so the next caller retries", async () => {
    stubFetch(() => ({ ok: false, status: 503 }));
    await assert.rejects(mostPlayed(0));
    stubFetch(() => ({ ok: true, body: { response: { ranks: [{ appid: 1 }] } } }));
    assert.deepEqual(await mostPlayed(1), [1]);
  });
});

describe("catalogGames", () => {
  it("asks for a whole wall in one request and keeps the order given", async () => {
    const calls = stubFetch((url) =>
      itemsAnswer(
        askedFor(url)
          .reverse()
          .map((id) => item(id)),
      ),
    );
    const games = await catalogGames([3, 1, 2]);
    assert.deepEqual(
      games.map((g) => g.appid),
      [3, 1, 2],
    );
    assert.equal(calls.length, 1);
  });

  it("only asks Steam for games it has not seen today", async () => {
    const calls = stubFetch((url) => itemsAnswer(askedFor(url).map((id) => item(id))));
    await catalogGames([1, 2], 0);
    await catalogGames([2, 3], 60 * 60 * 1000);
    assert.deepEqual(calls.map(askedFor), [[1, 2], [3]]);
  });

  it("returns what it can when Steam fails, and retries next time", async () => {
    stubFetch(() => ({ ok: false, status: 500 }));
    assert.deepEqual(await catalogGames([1]), []);
    const calls = stubFetch((url) => itemsAnswer(askedFor(url).map((id) => item(id))));
    assert.equal((await catalogGames([1])).length, 1);
    assert.equal(calls.length, 1);
  });
});

describe("popularGames", () => {
  it("keeps chart order, skips software and stops at the limit", async () => {
    stubFetch((url) => {
      if (url.includes("GetMostPlayedGames")) {
        return { ok: true, body: { response: { ranks: [1, 2, 3, 4].map((appid) => ({ appid })) } } };
      }
      return itemsAnswer(askedFor(url).map((id) => item(id, { type: id === 2 ? 6 : 0 })));
    });
    assert.deepEqual(
      (await popularGames(2)).map((g) => g.appid),
      [1, 3],
    );
  });

  it("answers an empty list when Steam is unreachable", async () => {
    stubFetch(() => ({ ok: false, status: 500 }));
    assert.deepEqual(await popularGames(), []);
  });
});

describe("gamesMedia", () => {
  it("ignores junk and duplicate appids", async () => {
    const calls = stubFetch((url) => itemsAnswer(askedFor(url).map((id) => item(id))));
    const games = await gamesMedia([7, 7, 0, -3, Number.NaN, 8]);
    assert.deepEqual(
      games.map((g) => g.appid),
      [7, 8],
    );
    assert.deepEqual(calls.map(askedFor), [[7, 8]]);
  });

  it("says when Steam failed for some, keeping the games it did answer for", async () => {
    stubFetch((url) => (askedFor(url).includes(1) ? itemsAnswer([item(1)]) : { ok: false, status: 500 }));
    await catalogGames([1]);
    const looked = await lookUpGamesMedia([1, 2]);
    assert.deepEqual(
      looked.games.map((g) => g.appid),
      [1],
    );
    assert.equal(looked.failed, true);
  });

  it("does not count an answer with no games in it as a failure", async () => {
    stubFetch((url) => itemsAnswer(askedFor(url).map((id) => item(id, { type: 6 }))));
    assert.deepEqual(await lookUpGamesMedia([1, 2]), { games: [], failed: false });
  });
});
