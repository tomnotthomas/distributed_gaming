import { describe, expect, it } from "vitest";
import { GAMES } from "./data";
import { gameHeader, gameTrailer, popularCards, withMedia, type CatalogGame } from "./steam";

const catalog: CatalogGame[] = [
  { appid: 730, name: "Counter-Strike 2", free: true, trailer: "https://cdn/cs.webm", header: null },
  { appid: 2807960, name: "Battlefield 6", free: false, trailer: null, header: "https://cdn/h/bf.jpg" },
];
const pool = ["glass", "ember", "tide", "moss"];

describe("popularCards", () => {
  it("keeps chart order and says so on each card", () => {
    const cards = popularCards(catalog, pool);
    expect(cards.map((c) => c.appid)).toEqual([730, 2807960]);
    expect(cards.map((c) => c.personal)).toEqual(["#1 on Steam right now", "#2 on Steam right now"]);
    expect(cards.map((c) => c.popularRank)).toEqual([1, 2]);
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

  it("carries the catalog trailer, or none", () => {
    const [cs, bf] = popularCards(catalog, pool);
    expect(gameTrailer(cs!)).toBe("https://cdn/cs.webm");
    expect(gameTrailer(bf!)).toBeNull();
  });
});

describe("withMedia", () => {
  it("fills in trailers without overriding a curated one", () => {
    const curated = GAMES.find((g) => g.appid === 730)!;
    const library = popularCards([{ ...catalog[1]!, trailer: null }], pool);
    const merged = withMedia([curated, ...library], [
      { appid: 730, name: "CS2", free: true, trailer: "https://cdn/other.webm", header: null },
      { appid: 2807960, name: "Battlefield 6", free: false, trailer: "https://cdn/bf.m3u8", header: "https://cdn/h/bf.jpg" },
    ]);
    expect(gameTrailer(merged[0]!)).toBe(gameTrailer(curated));
    expect(gameTrailer(merged[1]!)).toBe("https://cdn/bf.m3u8");
  });

  it("uses the store's real header as the fallback art when it has one", () => {
    const [cs, bf] = popularCards(catalog, pool);
    expect(gameHeader(bf!)).toBe("https://cdn/h/bf.jpg");
    expect(gameHeader(cs!)).toBe("https://cdn.cloudflare.steamstatic.com/steam/apps/730/header.jpg");
  });
});
