// The catalog without the network: fetch is stubbed per URL, so these pin the
// decisions (what counts as a game, which trailer wins, what gets cached) and
// not Steam's uptime.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { gameDetails, gamesMedia, mostPlayed, popularGames, resetCatalog } from "../catalog.js";

const realFetch = globalThis.fetch;
beforeEach(resetCatalog);
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Route = (url: string, init?: RequestInit) => { ok: boolean; status?: number; body?: unknown } | undefined;

/** Answer fetches from one router, recording every URL asked for. */
function stubFetch(route: Route) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const answer = route(url, init) ?? { ok: false, status: 404 };
    return { ok: answer.ok, status: answer.status ?? 200, json: async () => answer.body };
  }) as typeof fetch;
  return calls;
}

const details = (appid: number, data: Record<string, unknown>) => ({
  ok: true,
  body: { [appid]: { success: true, data: { type: "game", name: `Game ${appid}`, is_free: false, movies: [], ...data } } },
});

const appidOf = (url: string) => Number(new URL(url).searchParams.get("appids"));

describe("mostPlayed", () => {
  it("returns the chart's appids in rank order", async () => {
    stubFetch((url) =>
      url.includes("GetMostPlayedGames")
        ? { ok: true, body: { response: { ranks: [{ appid: 730 }, { appid: 570 }] } } }
        : undefined,
    );
    assert.deepEqual(await mostPlayed(), [730, 570]);
  });

  it("asks Steam once per hour, not once per visitor", async () => {
    const calls = stubFetch(() => ({ ok: true, body: { response: { ranks: [{ appid: 730 }] } } }));
    await mostPlayed(0);
    await mostPlayed(30 * 60 * 1000);
    assert.equal(calls.length, 1);
    await mostPlayed(61 * 60 * 1000);
    assert.equal(calls.length, 2);
  });

  it("does not keep a failure, so the next caller retries", async () => {
    stubFetch(() => ({ ok: false, status: 503 }));
    await assert.rejects(mostPlayed(0));
    const calls = stubFetch(() => ({ ok: true, body: { response: { ranks: [{ appid: 1 }] } } }));
    assert.deepEqual(await mostPlayed(1), [1]);
    assert.equal(calls.length, 1);
  });
});

describe("gameDetails", () => {
  it("prefers a trailer's plain .webm when Steam still serves one", async () => {
    stubFetch((url, init) => {
      if (url.includes("appdetails")) return details(10, { movies: [{ id: 5, hls_h264: "h.m3u8" }] });
      if (init?.method === "HEAD" && url.endsWith("/5/movie480_vp9.webm")) return { ok: true };
    });
    const game = await gameDetails(10);
    assert.equal(game?.trailer, "https://video.akamai.steamstatic.com/store_trailers/5/movie480_vp9.webm");
  });

  it("falls back to HLS for a trailer that only exists as a stream", async () => {
    stubFetch((url) => (url.includes("appdetails") ? details(10, { movies: [{ id: 5, hls_h264: "h.m3u8" }] }) : undefined));
    assert.equal((await gameDetails(10))?.trailer, "h.m3u8");
  });

  it("passes the store's real header image through", async () => {
    stubFetch((url) => (url.includes("appdetails") ? details(10, { header_image: "https://cdn/abc123/header.jpg" }) : undefined));
    assert.equal((await gameDetails(10))?.header, "https://cdn/abc123/header.jpg");
  });

  it("picks the highlighted trailer over the first one", async () => {
    stubFetch((url) =>
      url.includes("appdetails")
        ? details(10, { movies: [{ id: 1, hls_h264: "first" }, { id: 2, hls_h264: "highlight", highlight: true }] })
        : undefined,
    );
    assert.equal((await gameDetails(10))?.trailer, "highlight");
  });

  it("reads an answer keyed under a different appid", async () => {
    stubFetch(() => ({ ok: true, body: { 999: { success: true, data: { type: "game", name: "Edition", is_free: true } } } }));
    assert.deepEqual(await gameDetails(10), { appid: 10, name: "Edition", free: true, trailer: null, header: null });
  });

  it("returns null for software, DLC and failed lookups", async () => {
    stubFetch((url) => details(appidOf(url), { type: "application" }));
    assert.equal(await gameDetails(10), null);
    stubFetch(() => ({ ok: true, body: { 11: { success: false } } }));
    assert.equal(await gameDetails(11), null);
  });

  it("returns null for tools the store types as games", async () => {
    stubFetch((url) => details(appidOf(url), { name: "Wallpaper Engine", genres: [{ id: "4" }, { id: "57" }] }));
    assert.equal(await gameDetails(431960), null);
  });

  it("caches each game for a day", async () => {
    const calls = stubFetch((url) => (url.includes("appdetails") ? details(10, {}) : undefined));
    await gameDetails(10, 0);
    await gameDetails(10, 23 * 60 * 60 * 1000);
    assert.equal(calls.filter((c) => c.includes("appdetails")).length, 1);
  });
});

describe("popularGames", () => {
  it("keeps chart order, skips non-games and stops at the limit", async () => {
    stubFetch((url) => {
      if (url.includes("GetMostPlayedGames")) {
        return { ok: true, body: { response: { ranks: [1, 2, 3, 4].map((appid) => ({ appid })) } } };
      }
      const appid = appidOf(url);
      return details(appid, { type: appid === 2 ? "application" : "game" });
    });
    const games = await popularGames(2);
    assert.deepEqual(
      games.map((g) => g.appid),
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
    const calls = stubFetch((url) => details(appidOf(url), {}));
    const games = await gamesMedia([7, 7, 0, -3, Number.NaN, 8]);
    assert.deepEqual(
      games.map((g) => g.appid),
      [7, 8],
    );
    assert.equal(calls.filter((c) => c.includes("appdetails")).length, 2);
  });
});
