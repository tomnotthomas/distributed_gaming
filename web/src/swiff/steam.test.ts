import { afterEach, describe, expect, it, vi } from "vitest";
import { GAMES } from "./data";
import { gameArt, gameArtFallbacks, gamePreview, gameTrailer, popularCards, withMedia, type CatalogGame } from "./steam";

const art = (hero: string | null, capsule: string | null = null) => ({ hero, capsule, header: null });
const catalog: CatalogGame[] = [
  { appid: 730, name: "Counter-Strike 2", free: true, art: art("https://cdn/cs_hero_2x.jpg"), preview: "https://cdn/cs.mp4", trailer: "https://cdn/cs.m3u8" },
  { appid: 2807960, name: "Battlefield 6", free: false, art: art(null, "https://cdn/bf_capsule_2x.jpg"), preview: null, trailer: null },
];
const pool = ["glass", "ember", "tide", "moss"];

/** Pretend the browser can (or cannot) play HLS in a plain <video>. */
function hls(supported: boolean) {
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockImplementation((type) =>
    supported && type === "application/vnd.apple.mpegurl" ? "maybe" : "",
  );
}
afterEach(() => vi.restoreAllMocks());

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
  it("uses the catalog's exact hi-res file, else the guessable 2x key art", () => {
    const [cs, bf] = popularCards(catalog, pool);
    expect(gameArt(cs!)).toBe("https://cdn/cs_hero_2x.jpg");
    expect(gameArt(bf!)).toBe("https://cdn.cloudflare.steamstatic.com/steam/apps/2807960/library_hero_2x.jpg");
  });

  it("falls back to the 1x key art, then the capsule", () => {
    const [, bf] = popularCards(catalog, pool);
    expect(gameArtFallbacks(bf!)).toEqual([
      "https://cdn.cloudflare.steamstatic.com/steam/apps/2807960/library_hero.jpg",
      "https://cdn/bf_capsule_2x.jpg",
    ]);
  });
});

describe("trailers", () => {
  it("plays the full HLS trailer where the browser can, else the short clip", () => {
    const [cs] = popularCards(catalog, pool);
    hls(true);
    expect(gameTrailer(cs!)).toBe("https://cdn/cs.m3u8");
    hls(false);
    expect(gameTrailer(cs!)).toBe("https://cdn/cs.mp4");
  });

  it("previews a hovered tile with the short clip, which plays everywhere", () => {
    const [cs] = popularCards(catalog, pool);
    hls(true);
    expect(gamePreview(cs!)).toBe("https://cdn/cs.mp4");
  });

  it("has nothing to play for a game without trailers", () => {
    const [, bf] = popularCards(catalog, pool);
    expect(gameTrailer(bf!)).toBeNull();
    expect(gamePreview(bf!)).toBeNull();
  });
});

describe("withMedia", () => {
  it("gives a curated game the catalog's clip over its own .webm trailer", () => {
    const curated = GAMES.find((g) => g.appid === 730)!;
    hls(false);
    const [merged] = withMedia([curated], catalog);
    expect(gamePreview(merged!)).toBe("https://cdn/cs.mp4");
    expect(gameArt(merged!)).toBe("https://cdn/cs_hero_2x.jpg");
  });

  it("leaves games the catalog does not know untouched", () => {
    const curated = GAMES.find((g) => g.appid === 1245620)!;
    expect(withMedia([curated], catalog)[0]).toBe(curated);
  });
});
