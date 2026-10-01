import { describe, expect, it, vi } from "vitest";
import { GAMES } from "./data";
import {
  fetchRenter,
  gameArt,
  gameArtFallbacks,
  gamePreview,
  gameTrailer,
  popularCards,
  readSteamFragment,
  signOut,
  withMedia,
  type CatalogGame,
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

  it("gives every card machines from the shared pool, so none reads as broken", () => {
    for (const card of popularCards(catalog, pool)) {
      expect(card.machines.length).toBeGreaterThan(0);
      expect(card.machines.every((id) => pool.includes(id))).toBe(true);
    }
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

  it("shows the wall signed out when the server signs nobody in or cannot be reached", async () => {
    expect(await fetchRenter(answer(401, { error: "sign in" }) as unknown as typeof fetch)).toBeNull();
    const offline = vi.fn(async () => Promise.reject(new TypeError("offline")));
    expect(await fetchRenter(offline as unknown as typeof fetch)).toBeNull();
  });

  it("signs out with a POST, and says so when the server refuses", async () => {
    const get = answer(204);
    await signOut(get as unknown as typeof fetch);
    expect(get).toHaveBeenCalledWith("/api/signout", { method: "POST" });
    await expect(signOut(answer(500) as unknown as typeof fetch)).rejects.toThrow("500");
  });
});
