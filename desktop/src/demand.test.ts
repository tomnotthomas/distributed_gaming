// What renters ask for, read from the platform with this PC's machine key.

import { describe, expect, it, vi } from "vitest";
import { demandGames, demandRows, demandUrl, fetchDemand } from "./demand";

describe("demandUrl", () => {
  it("is the signaling server's own HTTPS origin, for this machine", () => {
    expect(demandUrl({ url: "otter.example", machineId: "pc 1" })).toBe(
      "https://otter.example/api/machines/pc%201/demand",
    );
    expect(demandUrl({ url: "wss://otter.example/", machineId: "pc-1" })).toBe(
      "https://otter.example/api/machines/pc-1/demand",
    );
    expect(demandUrl({ url: "ws://localhost:8080", machineId: "pc-1" })).toBe(
      "http://localhost:8080/api/machines/pc-1/demand",
    );
  });

  it("is null where the key would cross the network unencrypted, or nothing is set", () => {
    expect(demandUrl({ url: "http://otter.example", machineId: "pc-1" })).toBeNull();
    expect(demandUrl({ url: "", machineId: "pc-1" })).toBeNull();
    expect(demandUrl({ url: "otter.example", machineId: " " })).toBeNull();
  });
});

describe("demand rows", () => {
  it("keeps only well-formed games", () => {
    const body = {
      games: [
        { appid: 730, name: "Counter-Strike 2", looking: 3, waiting: 1 },
        { appid: 570, name: null, looking: 1, waiting: 0 },
        { appid: -1, name: "bad", looking: 1, waiting: 0 },
        { appid: 440, name: "TF2", looking: "many", waiting: 0 },
        null,
      ],
    };
    expect(demandGames(body)).toEqual([
      { appid: 730, name: "Counter-Strike 2", looking: 3, waiting: 1 },
      { appid: 570, name: null, looking: 1, waiting: 0 },
    ]);
    expect(() => demandGames({ error: "bad machine key" })).toThrow();
  });

  it("names each game from the platform, else this PC's Steam, else its appid", () => {
    const games = [
      { appid: 730, name: "Counter-Strike 2", looking: 3, waiting: 1 },
      { appid: 570, name: null, looking: 2, waiting: 0 },
      { appid: 440, name: null, looking: 1, waiting: 0 },
    ];
    expect(demandRows(games, [{ appid: 570, name: "Dota 2" }]).map((r) => r.name)).toEqual([
      "Counter-Strike 2",
      "Dota 2",
      "Steam app 440",
    ]);
  });
});

describe("fetchDemand", () => {
  const settings = { url: "otter.example", machineId: "pc-1", machineKey: " key " };

  it("asks with the machine key as its bearer", async () => {
    const fetch = vi.fn(async () => Response.json({ windowMinutes: 60, games: [] }));
    expect(await fetchDemand(settings, fetch)).toEqual([]);
    expect(fetch).toHaveBeenCalledWith("https://otter.example/api/machines/pc-1/demand", {
      headers: { authorization: "Bearer key" },
    });
  });

  it("throws when refused, and never asks without a key or over plain http", async () => {
    await expect(fetchDemand(settings, async () => new Response("{}", { status: 401 }))).rejects.toThrow();
    const fetch = vi.fn();
    await expect(fetchDemand({ ...settings, machineKey: "" }, fetch)).rejects.toThrow();
    await expect(fetchDemand({ ...settings, url: "http://otter.example" }, fetch)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
