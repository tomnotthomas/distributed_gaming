import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { gpuScore } from "@swiff/rank";
import type { Database } from "../db.js";
import {
  cardScore,
  curatedRequirements,
  DEFAULT_REQUIREMENTS,
  fetchAppDetails,
  parseTier,
  RequirementsTable,
  requirementsFromSteam,
  seedRequirements,
  type AppDetails,
} from "../requirements.js";
import { migrate } from "../schema.js";
import { testDatabase } from "./db.js";
// Real pc_requirements from Steam's appdetails, saved so the tests need no network.
import steam from "./fixtures/pc-requirements.json" with { type: "json" };

/** A Graphics/Memory list the way Steam's store renders one. */
const tier = (...items: string[]) =>
  `<strong>Minimum:</strong><br><ul class="bb_ul">${items.map((i) => `<li>${i}<br></li>`).join("")}</ul>`;
const graphics = (text: string) => `<strong>Graphics:</strong> ${text}`;
const memory = (text: string) => `<strong>Memory:</strong> ${text}`;

const GB = 1024;

describe("parsing Steam's pc_requirements", () => {
  it("reads Elden Ring: the lower card of each pair, RAM and the smaller VRAM", async () => {
    assert.deepEqual(parseTier(steam.eldenRing.minimum), {
      gpuScore: gpuScore("GTX 1060"),
      ramMb: 12 * GB,
      vramMb: 3 * GB,
    });
    // GTX 1070 (65) or RX Vega 56 (60): the Vega is the lower.
    assert.equal(parseTier(steam.eldenRing.recommended).gpuScore, gpuScore("RX Vega 56"));
    assert.deepEqual(requirementsFromSteam(steam.eldenRing), {
      minGpuScore: 45,
      recGpuScore: 60,
      minRamMb: 12 * GB,
      minVramMb: 3 * GB,
      source: "steam",
    });
  });

  it("falls back to the labelled default GPU when no card is named, keeping the stated memory", async () => {
    // "Video card must be 1 GB or more and should be a DirectX 11-compatible ..."
    assert.deepEqual(requirementsFromSteam(steam.counterStrike2), {
      ...DEFAULT_REQUIREMENTS,
      minRamMb: 8 * GB,
      minVramMb: 1 * GB,
    });
    assert.equal(DEFAULT_REQUIREMENTS.minGpuScore, gpuScore("GTX 1060"));
    assert.equal(DEFAULT_REQUIREMENTS.recGpuScore, gpuScore("RTX 3060"));
  });

  it("splits on slashes and commas, skips cards the table lacks and reads a bare model number", async () => {
    // "Nvidia GTX 970 / RX 480 / Intel Arc A380 / Qualcomm Adreno X1 (4GB+ of VRAM)"
    assert.deepEqual(parseTier(steam.baldursGate3.minimum), {
      gpuScore: gpuScore("RX 480"),
      ramMb: 8 * GB,
      vramMb: 4 * GB,
    });
    // "Nvidia 2060 Super / RX 5700 XT / Intel Arc A580 (8GB+ of VRAM)"
    assert.equal(parseTier(steam.baldursGate3.recommended).gpuScore, gpuScore("RTX 2060 Super"));
    // "AMD Radeon RX 5700, NVIDIA GeForce 1070 Ti"
    assert.equal(parseTier(steam.starfield.minimum).gpuScore, gpuScore("GTX 1070 Ti"));
    assert.equal(parseTier(steam.starfield.minimum).vramMb, null);
  });

  it("reads a single card", async () => {
    assert.equal(parseTier(tier(graphics("NVIDIA GeForce RTX 2060"))).gpuScore, gpuScore("RTX 2060"));
  });

  it("does not take 'or better' for a second card", async () => {
    assert.equal(parseTier(tier(graphics("GeForce GTX 1060 or better"))).gpuScore, gpuScore("GTX 1060"));
    assert.equal(parseTier(tier(graphics("Radeon RX 580 (or equivalent)"))).gpuScore, gpuScore("RX 580"));
  });

  it("reads VRAM from the Graphics line or its own line", async () => {
    assert.equal(parseTier(tier(graphics("GTX 1060 (6GB) / RX 580 (8GB)"))).vramMb, 6 * GB);
    assert.equal(parseTier(tier(graphics("RTX 2060"), "<strong>VRAM:</strong> 6 GB")).vramMb, 6 * GB);
  });

  it("prefers a stated VRAM size over one card's size in the Graphics line", async () => {
    // The Witcher 3's minimum: only the RX 5500 XT carries a size, the notes state the VRAM.
    const witcher = tier(
      graphics("GeForce GTX 1660 / Radeon RX 5500 XT 8GB / Arc A580"),
      "<strong>Additional Notes:</strong> VRAM 6 GB",
    );
    assert.equal(parseTier(witcher).vramMb, 6 * GB);
  });

  it("reads RAM given in MB", async () => {
    assert.equal(parseTier(tier(memory("4096 MB RAM"), graphics("GTX 1050"))).ramMb, 4096);
    assert.equal(parseTier(tier(memory("8GB RAM"))).ramMb, 8 * GB);
  });

  it("tolerates squashed spellings and prefers the longest name", async () => {
    assert.equal(cardScore("GTX1060 3GB"), gpuScore("GTX 1060"));
    assert.equal(cardScore("AMD Radeon RX 6600XT"), gpuScore("RX 6600 XT"));
    assert.equal(cardScore("NVIDIA GeForce GTX 1660 SUPER"), gpuScore("GTX 1660 Super"));
    assert.equal(cardScore("GeForce® RTX™ 3060 Ti"), gpuScore("RTX 3060 Ti"));
  });

  it("names no card for a size, a bare number without a vendor, or an unknown name", async () => {
    assert.equal(cardScore("DirectX 11 compatible, 480 MB"), null);
    assert.equal(cardScore("Intel Arc A380"), null);
    assert.equal(cardScore("Qualcomm Adreno X1"), null);
  });

  it("scores cards older than the table as its lowest card", async () => {
    const floor = gpuScore("GTX 1050");
    for (const old of [
      "NVIDIA GeForce GTX 760",
      "GTX660 2GB",
      "GeForce GT 730",
      "GeForce GT 1030",
      "GeForce 9800 GT",
      "AMD Radeon HD 7870",
      "Radeon R9 280X",
      "AMD Radeon R7 260X",
      "Radeon RX 560",
      "Intel HD Graphics 4000",
      "Intel UHD 620",
      "Intel HD Graphics",
      "Intel Iris Xe",
    ])
      assert.equal(cardScore(old), floor, old);
    assert.equal(cardScore("GTX 970"), gpuScore("GTX 970"));
  });

  it("scores older cards stronger than the floor from the table, not as the floor", async () => {
    assert.equal(cardScore("Radeon R9 290X"), 45);
    assert.equal(cardScore("AMD Radeon R9 Fury X"), 60);
    assert.equal(cardScore("GeForce GTX 780 Ti"), 40);
    assert.equal(cardScore("Radeon R9 380"), null);
    assert.equal(parseTier(tier(graphics("NVIDIA GeForce GTX 970 or AMD Radeon R9 390"))).gpuScore, 45);
    assert.equal(parseTier(tier(graphics("GTX 780 / R9 290"))).gpuScore, 35);
  });

  it("takes an older card as the lower of an 'or' pair", async () => {
    assert.equal(
      parseTier(tier(graphics("GeForce GTX 760 or Radeon RX 470"))).gpuScore,
      gpuScore("GTX 1050"),
    );
  });

  it("keeps an older minimum below a newer recommended", async () => {
    const values = requirementsFromSteam({
      minimum: tier(graphics("GeForce GTX 660")),
      recommended: tier(graphics("GTX 1060")),
    });
    assert.equal(values.minGpuScore, gpuScore("GTX 1050"));
    assert.equal(values.recGpuScore, gpuScore("GTX 1060"));
    assert.equal(values.source, "steam");
  });

  it("labels requirements naming only older cards as steam, at the table's lowest card", async () => {
    assert.deepEqual(
      requirementsFromSteam({
        minimum: tier(memory("2 GB RAM"), graphics("GeForce 8800 GT or Radeon HD 4850")),
        recommended: tier(graphics("GeForce GTX 560 or Radeon HD 6870")),
      }),
      {
        minGpuScore: gpuScore("GTX 1050"),
        recGpuScore: gpuScore("GTX 1050"),
        minRamMb: 2 * GB,
        minVramMb: 0,
        source: "steam",
      },
    );
  });

  it("handles a store page with no requirements, or only one tier", async () => {
    assert.deepEqual(requirementsFromSteam([]), DEFAULT_REQUIREMENTS);
    assert.deepEqual(parseTier(undefined), { gpuScore: null, ramMb: null, vramMb: null });
    assert.deepEqual(requirementsFromSteam({ minimum: tier(graphics("RTX 3070")) }), {
      minGpuScore: gpuScore("RTX 3070"),
      recGpuScore: gpuScore("RTX 3070"),
      minRamMb: 0,
      minVramMb: 0,
      source: "steam",
    });
  });

  it("keeps the minimum at or below the recommended", async () => {
    // Only a recommended card: the minimum is the default's, capped at it.
    const light = requirementsFromSteam({ recommended: tier(graphics("GTX 1050")) });
    assert.equal(light.minGpuScore, gpuScore("GTX 1050"));
    assert.equal(light.recGpuScore, gpuScore("GTX 1050"));
    const heavy = requirementsFromSteam({ recommended: tier(graphics("RTX 4080")) });
    assert.equal(heavy.minGpuScore, DEFAULT_REQUIREMENTS.minGpuScore);
    // A publisher's minimum above its own recommended: the recommended is raised.
    const swapped = requirementsFromSteam({
      minimum: tier(graphics("RTX 3080")),
      recommended: tier(graphics("RTX 2060")),
    });
    assert.equal(swapped.recGpuScore, gpuScore("RTX 3080"));
  });
});

describe("curated overrides", () => {
  it("name only cards the GPU table knows, with the minimum at or below the recommended", async () => {
    assert.ok(curatedRequirements().size > 0);
    for (const [appid, values] of curatedRequirements()) {
      assert.ok(values.minGpuScore > 0, `${appid} minGpu`);
      assert.ok(values.recGpuScore >= values.minGpuScore, `${appid} recGpu`);
      assert.equal(values.source, "curated");
    }
  });
});

/** The database the tests of the calling suite each get afresh, with the tables made. */
let db: Database;
function freshTables(): void {
  beforeEach(async () => {
    db = await testDatabase();
    await migrate(db);
  });
  afterEach(() => db.close());
}

describe("RequirementsTable", () => {
  freshTables();
  const open = (now = () => 1_000) => new RequirementsTable(db, now);

  it("answers the labelled default for a game it has never seen", async () => {
    assert.deepEqual(await open().lookup(42), {
      appid: 42,
      minGpuScore: gpuScore("GTX 1060"),
      recGpuScore: gpuScore("RTX 3060"),
      minRamGb: 0,
      minVramGb: 0,
      source: "default",
    });
  });

  it("stores a row in MB and answers in the rank package's GB", async () => {
    const table = open();
    await table.upsert(1245620, requirementsFromSteam(steam.eldenRing));
    assert.deepEqual(await table.row(1245620), {
      appid: 1245620,
      minGpuScore: 45,
      recGpuScore: 60,
      minRamMb: 12 * GB,
      minVramMb: 3 * GB,
      source: "steam",
      updatedAt: 1_000,
    });
    assert.deepEqual(await table.lookup(1245620), {
      appid: 1245620,
      minGpuScore: 45,
      recGpuScore: 60,
      minRamGb: 12,
      minVramGb: 3,
      source: "steam",
    });
  });

  it("replaces a row on the next upsert", async () => {
    let now = 1_000;
    const table = open(() => now);
    await table.upsert(7, DEFAULT_REQUIREMENTS);
    now = 2_000;
    await table.upsert(7, { ...DEFAULT_REQUIREMENTS, minGpuScore: 80, source: "steam" });
    assert.equal((await table.row(7))?.minGpuScore, 80);
    assert.equal((await table.row(7))?.source, "steam");
    assert.equal((await table.row(7))?.updatedAt, 2_000);
  });

  it("puts a curated override ahead of a stored Steam row", async () => {
    const table = open();
    await table.upsert(730, requirementsFromSteam(steam.counterStrike2));
    assert.equal((await table.lookup(730)).source, "curated");
    assert.equal((await table.lookup(730)).minGpuScore, curatedRequirements().get(730)?.minGpuScore);
  });

  it("looks up many games at once, in the order asked, whatever each one's source", async () => {
    const table = open();
    await table.upsert(1245620, requirementsFromSteam(steam.eldenRing));
    const games = await table.lookupAll([42, 730, 1245620, 42]);
    assert.deepEqual(
      games.map((game) => [game.appid, game.source]),
      [
        [42, "default"],
        [730, "curated"],
        [1245620, "steam"],
        [42, "default"],
      ],
    );
    assert.deepEqual(games[2], await table.lookup(1245620));
    assert.deepEqual(await table.lookupAll([]), []);
  });
});

describe("seedRequirements", () => {
  freshTables();
  const eldenRing: AppDetails = { type: "game", pc_requirements: steam.eldenRing };

  it("writes curated games without asking Steam and parses the rest", async () => {
    const table = new RequirementsTable(db);
    const asked: number[] = [];
    const outcomes = await seedRequirements(table, [730, 1245620, 1245620, 99], {
      pauseMs: 0,
      fetchDetails: async (appid) => {
        asked.push(appid);
        return appid === 1245620 ? eldenRing : { type: "game", pc_requirements: [] };
      },
    });
    assert.deepEqual(asked, [1245620, 99]);
    assert.deepEqual(outcomes, [
      { appid: 730, source: "curated" },
      { appid: 1245620, source: "steam" },
      { appid: 99, source: "default" },
    ]);
    assert.equal((await table.row(730))?.source, "curated");
    assert.equal((await table.row(1245620))?.recGpuScore, 60);
    assert.equal((await table.row(99))?.source, "default");
  });

  it("writes nothing for a failed request, an unknown app or software", async () => {
    const table = new RequirementsTable(db);
    await table.upsert(1, requirementsFromSteam(steam.eldenRing));
    const outcomes = await seedRequirements(table, [1, 2, 3], {
      pauseMs: 0,
      fetchDetails: async (appid) => {
        if (appid === 1) throw new Error("steam -> 429");
        return appid === 2 ? null : { type: "software" };
      },
    });
    assert.deepEqual(outcomes, [
      { appid: 1, skipped: "steam -> 429" },
      { appid: 2, skipped: "no such app" },
      { appid: 3, skipped: "not a game (software)" },
    ]);
    assert.equal((await table.row(1))?.source, "steam", "a Steam outage keeps the good row");
    assert.equal(await table.row(2), null);
    assert.equal(await table.row(3), null);
  });
});

describe("fetchAppDetails", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const answer = (body: unknown) => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: URL | string) => {
      urls.push(String(url));
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    return urls;
  };

  it("asks the store for one appid and returns its data", async () => {
    const urls = answer({ "1245620": { success: true, data: eldenRingDetails } });
    assert.deepEqual(await fetchAppDetails(1245620), eldenRingDetails);
    const url = new URL(urls[0]!);
    assert.equal(url.origin + url.pathname, "https://store.steampowered.com/api/appdetails");
    assert.equal(url.searchParams.get("appids"), "1245620");
  });

  it("returns null when Steam has no such app", async () => {
    answer({ "5": { success: false } });
    assert.equal(await fetchAppDetails(5), null);
    answer({ "5": { success: true, data: [] } });
    assert.equal(await fetchAppDetails(5), null);
  });
});

const eldenRingDetails = { type: "game", name: "ELDEN RING", pc_requirements: steam.eldenRing };
