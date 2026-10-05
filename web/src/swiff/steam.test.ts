import { describe, expect, it, vi } from "vitest";
import { GAMES } from "./data";
import {
  applySteam,
  endSignIn,
  fetchRenter,
  gameArt,
  gameArtFallbacks,
  gamePreview,
  gameTrailer,
  libraryState,
  nextCatalog,
  popularCards,
  readSteamFragment,
  refreshRenter,
  signOut,
  storeGames,
  withMedia,
  type CatalogGame,
  type SteamProfile,
} from "./steam";

const HERO_2X = "https://cdn/h/library_hero_2x.jpg";
const catalog: CatalogGame[] = [
  {
    appid: 730,
    name: "Counter-Strike 2",
    free: true,
    art: { hero: HERO_2X, capsule: null },
    preview: "https://cdn/cs.mp4",
    trailer: "https://cdn/cs.m3u8",
  },
  {
    appid: 2807960,
    name: "Battlefield 6",
    free: false,
    art: { hero: null, capsule: "https://cdn/bf_capsule_2x.jpg" },
    preview: null,
    trailer: null,
  },
];
const pool = ["glass", "ember", "tide", "moss"];
const srcs = (list: { src: string }[]) => list.map((s) => s.src);

describe("popularCards", () => {
  it("keeps chart order and says so on each card", () => {
    const cards = popularCards(catalog, pool);
    expect(cards.map((c) => c.appid)).toEqual([730, 2807960]);
    expect(cards.map((c) => c.personal)).toEqual(["#1 on Steam right now", "#2 on Steam right now"]);
  });

  it("makes free-to-play games playable without owning them, and nothing else", () => {
    const [cs, bf] = popularCards(catalog, pool);
    expect(cs).toMatchObject({ owned: true, f2p: true, hours: 0 });
    expect(bf).toMatchObject({ owned: false, f2p: false });
  });

  it("tells a renter which launcher a game asks them to sign in to, and says nothing for the rest", () => {
    const ubisoft = {
      ...catalog[1]!,
      appid: 2369390,
      requiresAccount: { launcher: "ubisoft", name: "Ubisoft" },
    };
    const [cs, farCry] = popularCards([catalog[0]!, ubisoft], pool);
    expect(farCry!.signIn).toBe("Needs your Ubisoft sign-in");
    expect(cs!.signIn).toBeUndefined();
    // A library card gets it from the art read too.
    const [library] = withMedia([{ ...cs!, appid: 2369390 }], [ubisoft]);
    expect(library!.signIn).toBe("Needs your Ubisoft sign-in");
  });

  it("gives every card machines from the shared pool, so none reads as broken", () => {
    for (const card of popularCards(catalog, pool)) {
      expect(card.machines.length).toBeGreaterThan(0);
      expect(card.machines.every((id) => pool.includes(id))).toBe(true);
    }
  });
});

describe("applySteam", () => {
  const profile = (over: Partial<SteamProfile> = {}): SteamProfile => ({
    id: "0001",
    persona: "kai_nx",
    avatar: "",
    hours: 0,
    size: 0,
    owned: [],
    games: [],
    lib: true,
    ...over,
  });
  // Steam's store data: THE FINALS and Counter-Strike 2 are free, Cyberpunk is not.
  const store: CatalogGame[] = [
    ...catalog,
    {
      appid: 2073850,
      name: "THE FINALS",
      free: true,
      art: { hero: null, capsule: null },
      preview: null,
      trailer: null,
    },
    {
      appid: 1091500,
      name: "Cyberpunk 2077",
      free: false,
      art: { hero: null, capsule: null },
      preview: null,
      trailer: null,
    },
  ];
  const appids = (games: { appid: number }[]) => games.map((g) => g.appid).sort((a, b) => a - b);

  it("falls back to the curated free-to-play games for a private library when there is no store data", () => {
    const wall = applySteam(profile({ lib: false }), pool);
    expect(appids(wall)).toEqual([730, 2073850]);
    for (const game of wall)
      expect(game).toMatchObject({
        owned: false,
        f2p: true,
        hours: 0,
        last: undefined,
        personal: "Free to play",
      });
    expect(libraryState(profile({ lib: false }))).toBe("unreadable");
  });

  it("falls back only to the curated free-to-play games the server says Swiff can run, when it says", () => {
    expect(appids(applySteam(profile({ lib: false }), pool, [], new Set([730])))).toEqual([730]);
    expect(applySteam(profile({ lib: false }), pool, [], new Set())).toEqual([]);
  });

  it("lets the store data, when there is any, say what is free over the curated set", () => {
    const paid = store.map((g) => (g.appid === 730 ? { ...g, free: false } : g));
    expect(appids(applySteam(profile({ lib: false }), pool, paid))).toEqual([2073850]);
  });

  it("lets a refreshed art read that marks a game paid beat a kept chart entry that still says free", () => {
    const finals = store.find((g) => g.appid === 2073850)!;
    const kept = { media: [], popular: [finals] };
    const next = nextCatalog(kept, [{ ...finals, free: false }], []);
    expect(appids(applySteam(profile({ lib: false }), pool, storeGames(next)))).toEqual([]);
  });

  it("shows a private library only the free-to-play games, marked free and not owned", () => {
    const wall = applySteam(profile({ lib: false }), pool, store);
    expect(appids(wall)).toEqual([730, 2073850]);
    for (const game of wall)
      expect(game).toMatchObject({ owned: false, f2p: true, hours: 0, last: undefined });
    expect(wall.map((g) => g.title)).not.toContain("Cyberpunk 2077");
  });

  it("shows only the owned subset of the curated games, with real hours instead of demo copy", () => {
    const wall = applySteam(profile({ owned: [[1245620, 12]], games: [[570, "Dota 2", 3]] }), pool, store);
    expect(appids(wall)).toEqual([570, 730, 1245620, 2073850]);
    const elden = wall.find((g) => g.appid === 1245620)!;
    expect(elden).toMatchObject({
      owned: true,
      hours: 12,
      personal: "12 h played",
      last: "in your library",
    });
    expect(elden.save).not.toMatch(/Liurnia/);
    expect(wall.find((g) => g.appid === 570)).toMatchObject({ owned: true, fromLibrary: true });
    expect(libraryState(profile({ owned: [[1245620, 12]] }))).toBe("ok");
  });

  it("does not show an owned free game twice, and counts it as the renter's", () => {
    const wall = applySteam(profile({ owned: [[730, 400]] }), pool, store);
    expect(wall.filter((g) => g.appid === 730)).toHaveLength(1);
    expect(wall.find((g) => g.appid === 730)).toMatchObject({ owned: true, hours: 400 });
  });

  it("says a readable library with nothing to show is empty, rather than unreadable", () => {
    expect(libraryState(profile({ size: 3 }))).toBe("none");
    expect(applySteam(profile({ size: 3 }), pool, store).every((g) => g.f2p && !g.owned)).toBe(true);
  });
});

describe("nextCatalog", () => {
  const [cs, bf] = catalog;
  const previous = { media: [bf!], popular: [cs!] };

  it("keeps the store data it has when both store reads fail", () => {
    expect(nextCatalog(previous, [], [])).toEqual(previous);
  });

  it("keeps the last chart when only the chart read fails, so its free games stay up", () => {
    const next = nextCatalog(previous, [cs!], []);
    expect(next).toEqual({ media: [cs], popular: [cs] });
    expect(storeGames(next).filter((g) => g.free)).not.toHaveLength(0);
  });

  it("keeps the last art when only the art read fails", () => {
    expect(nextCatalog(previous, [], [bf!])).toEqual({ media: [bf], popular: [bf] });
  });

  it("replaces each source with whatever its read brings back", () => {
    expect(nextCatalog(previous, [cs!], [bf!])).toEqual({ media: [cs], popular: [bf] });
  });
});

describe("art", () => {
  it("uses the catalog's exact file: 2x full-bleed, the 1x beside it for tiles", () => {
    const [cs] = popularCards(catalog, pool);
    expect(gameArt(cs!)).toBe(HERO_2X);
    expect(gameArt(cs!, 1)).toBe("https://cdn/h/library_hero.jpg");
  });

  it("uses the capsule for a catalog game without key art", () => {
    const [, bf] = popularCards(catalog, pool);
    expect(gameArt(bf!)).toBe("https://cdn/bf_capsule_2x.jpg");
  });

  it("only gives guessed art a fallback, since every layer is downloaded", () => {
    const [cs] = popularCards(catalog, pool);
    const curated = GAMES[0]!;
    expect(gameArtFallbacks(cs!)).toEqual([]);
    expect(gameArt(curated)).toBe(
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${curated.appid}/library_hero_2x.jpg`,
    );
    expect(gameArtFallbacks(curated)).toEqual([
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${curated.appid}/header.jpg`,
    ]);
  });
});

describe("trailers", () => {
  it("offers the full trailer as HLS first, then the clip, each typed so the browser can skip what it cannot play", () => {
    const [cs] = popularCards(catalog, pool);
    expect(gameTrailer(cs!)).toEqual([
      { src: "https://cdn/cs.m3u8", type: "application/vnd.apple.mpegurl" },
      { src: "https://cdn/cs.mp4", type: "video/mp4" },
    ]);
  });

  it("previews a hovered tile with the short clip only", () => {
    const [cs] = popularCards(catalog, pool);
    expect(srcs(gamePreview(cs!))).toEqual(["https://cdn/cs.mp4"]);
  });

  it("has nothing to play for a game without trailers", () => {
    const [, bf] = popularCards(catalog, pool);
    expect(gameTrailer(bf!)).toEqual([]);
    expect(gamePreview(bf!)).toEqual([]);
  });
});

describe("withMedia", () => {
  it("puts the catalog's clip ahead of a curated game's own .webm trailer", () => {
    const curated = GAMES.find((g) => g.appid === 730)!;
    const [merged] = withMedia([curated], catalog);
    expect(srcs(gamePreview(merged!))).toEqual(["https://cdn/cs.mp4"]);
    expect(srcs(gameTrailer(merged!)).at(-1)).toMatch(/\.webm$/);
    expect(gameArt(merged!)).toBe(HERO_2X);
  });

  it("leaves games the catalog does not know untouched", () => {
    const curated = GAMES.find((g) => g.appid === 1245620)!;
    expect(withMedia([curated], catalog)[0]).toBe(curated);
  });
});

describe("sign-in", () => {
  const renter = { steamId: "76561198000000001", profile: { id: "0001", persona: "kai_nx" } };
  const answer = (status: number, body?: unknown) =>
    vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));

  it("reads the return from Steam once and clears it, signing nobody in from the URL", () => {
    for (const [hash, expected] of [
      ["#steam=ok", "ok"],
      ["#steam=denied", "denied"],
      ["#steam=eyJpZCI6IjAwMDEifQ", "denied"],
    ] as const) {
      history.replaceState(null, "", `/games${hash}`);
      expect(readSteamFragment()).toBe(expected);
      expect(location.hash).toBe("");
      expect(location.pathname).toBe("/games");
    }
    expect(readSteamFragment()).toBeNull();
  });

  it("asks the server who is signed in", async () => {
    const get = answer(200, renter);
    expect(await fetchRenter(get as unknown as typeof fetch)).toEqual(renter);
    expect(get).toHaveBeenCalledWith("/api/me");
  });

  it("asks the server to read the library from Steam again on retry", async () => {
    const get = answer(200, renter);
    expect(await refreshRenter(get as unknown as typeof fetch)).toEqual(renter);
    expect(get).toHaveBeenCalledWith("/api/me/refresh", { method: "POST" });
    expect(await refreshRenter(answer(401) as unknown as typeof fetch)).toBeNull();
  });

  it("shows the wall signed out when the server signs nobody in or cannot be reached", async () => {
    expect(await fetchRenter(answer(401, { error: "sign in" }) as unknown as typeof fetch)).toBeNull();
    const offline = vi.fn(async () => Promise.reject(new TypeError("offline")));
    expect(await fetchRenter(offline as unknown as typeof fetch)).toBeNull();
  });

  it("leaves the page only once the server has signed the renter out", async () => {
    const done = vi.fn();
    const failed = vi.fn();
    await endSignIn(done, failed, answer(204) as unknown as typeof fetch);
    expect(done).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
  });

  it("reports a refused or unreachable sign-out instead of leaving the page", async () => {
    const offline = vi.fn(async () => Promise.reject(new TypeError("offline")));
    for (const get of [answer(500), offline]) {
      const done = vi.fn();
      const failed = vi.fn();
      await endSignIn(done, failed, get as unknown as typeof fetch);
      expect(done).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledOnce();
    }
  });

  it("signs out with a POST, and says so when the server refuses", async () => {
    const get = answer(204);
    await signOut(get as unknown as typeof fetch);
    expect(get).toHaveBeenCalledWith("/api/signout", { method: "POST" });
    await expect(signOut(answer(500) as unknown as typeof fetch)).rejects.toThrow("500");
  });
});
