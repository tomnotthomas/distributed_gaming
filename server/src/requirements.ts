// What hardware each game needs, for the ranking in @swiff/rank: gate E3
// compares a host with the minimum, and Picture compares it with the
// recommended GPU. One row per game, in the game_requirements table.
//
//   curated   requirements-overrides.json, checked in; always wins
//   steam     parsed from the store's pc_requirements text
//   default   a GTX 1060-class minimum and an RTX 3060-class recommended,
//             for a game nobody has told us about
//
// Steam's pc_requirements is free-text HTML written by each publisher, e.g.
// "Graphics: NVIDIA GEFORCE GTX 1060 3 GB or AMD RADEON RX 580 4 GB". The
// parser finds the Memory and Graphics lines, reads RAM and VRAM sizes with a
// regex, maps each card through the rank package's GPU score table, and keeps
// the lower of the alternatives: the game runs on either. A card older than
// the table (a GTX 760, a Radeon HD 7870, Intel HD graphics) scores as the
// table's lowest card; any other card the table does not know is skipped
// rather than guessed.
//
// RAM and VRAM of 0 mean "not stated": E3 then gates on the GPU alone.

import { gpuScore, normalizeGpu, type GameRequirements } from "@swiff/rank";
import gpuTable from "@swiff/rank/gpu-scores.json" with { type: "json" };
import overrides from "./requirements-overrides.json" with { type: "json" };
import { getJson } from "./catalog.js";
import type { Queryable } from "./db.js";

export type RequirementsSource = "steam" | "curated" | "default";

/** Requirements for one game in the rank package's units, and where they came from. */
export type Requirements = GameRequirements & { source: RequirementsSource };

/** What one Steam tier (minimum or recommended) states; null where it states nothing we can read. */
export type ParsedTier = { gpuScore: number | null; ramMb: number | null; vramMb: number | null };

/** One game_requirements row. */
export type RequirementsRow = {
  appid: number;
  minGpuScore: number;
  recGpuScore: number;
  minRamMb: number;
  minVramMb: number;
  source: RequirementsSource;
  updatedAt: number;
};

type Stored = Omit<RequirementsRow, "appid" | "updatedAt">;

/**
 * A curated entry. Requirements name cards, so every number traces back to the
 * GPU score table. `cloud` is whether the publisher allows its game to be
 * played on rented PCs (playable.ts), which no API says, with `cloudWhy` the
 * evidence; an entry may carry either part, or both.
 */
type Override = {
  name: string;
  minGpu?: string;
  recGpu?: string;
  minRamGb?: number;
  minVramGb?: number;
  why?: string;
  cloud?: CloudPermission;
  cloudWhy?: string;
};

/** A publisher's stance on its game being played on rented PCs: allowed, or objected to. */
export type CloudPermission = "allow" | "deny";

const MB_PER_GB = 1024;

/** For a game with nothing better known: GTX 1060-class minimum, RTX 3060-class recommended. */
export const DEFAULT_REQUIREMENTS: Stored = {
  minGpuScore: gpuScore("GTX 1060"),
  recGpuScore: gpuScore("RTX 3060"),
  minRamMb: 0,
  minVramMb: 0,
  source: "default",
};

type Row = {
  appid: number;
  min_gpu_score: number;
  rec_gpu_score: number;
  min_ram_mb: number;
  min_vram_mb: number;
  source: RequirementsSource;
  updated_at: number;
};

// --- parsing Steam's text ------------------------------------------------------

const GRAPHICS_LABEL = /^(?:graphics|graphics card|video card|video|gpu)\s*:\s*/i;
const MEMORY_LABEL = /^(?:memory|system memory|ram)\s*:\s*/i;
/** A VRAM size stated on its own, on any line: "VRAM: 6 GB", "Additional Notes: VRAM 6 GB". */
const STATED_VRAM = /\b(?:vram|video memory|video ram)\s*:?\s*(\d+(?:\.\d+)?\s*(?:GB|MB))\b/gi;
const SIZE = /(\d+(?:\.\d+)?)\s*(GB|MB)\b/gi;
/** "or better" and friends would otherwise split off as an alternative card. */
const OR_BETTER = /\(?\bor\s+(?:better|higher|above|newer|greater|equivalent|similar)\b\)?/gi;
/** Between alternative cards: "or", "/", ",", ";" and "|". */
const ALTERNATIVES = /\s+or\s+|\s*[/,;|]\s*/i;
const FAMILY = /\b(?:GTX|RTX|GT|RX|HD|R[579]|ARC|IRIS|UHD|QUADRO|VEGA)\b/;

/** Cards older and weaker than the table's lowest: GT, GTX 760 and older, HD, R7, R9 280 and older, RX 460/560 and Intel's integrated graphics. */
const OLDER_THAN_TABLE = [
  /\b(?:GTS? \d{3}|GTX [2-6]\d{2}|GTX 7[1-6]0)\b/,
  /\bGT 10[1-3]0\b/,
  /\b\d{4} (?:GTX?|GTS)\b/,
  /\bU?HD ?\d{3,4}\b/,
  /\b(?:R7 \d{3}|R9 (?:2[0-8]\d|370))X?\b/,
  /\bRX [45][0-6]0\b/,
  /\bINTEL (?:U?HD|IRIS)\b/,
];

/** The GPU table's lowest score, given to a card older than the table. */
const FLOOR_SCORE = Math.min(...Object.values(gpuTable as Record<string, number>));

/** Table names, normalized and longest first, so "RTX 2060 SUPER" is found before "RTX 2060". */
const GPU_NAMES = Object.keys(gpuTable as Record<string, number>)
  .map(normalizeGpu)
  .sort((a, b) => b.length - a.length);

/** Publisher HTML to plain lines: one per <br>, <li> or paragraph, tags dropped and entities decoded. */
function textLines(html: string): string[] {
  return html
    .replace(/<br\s*\/?>|<\/?li[^>]*>|<\/?p[^>]*>|<\/?ul[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** The text after a label such as "Graphics:", or null when no line carries it. */
function field(lines: string[], label: RegExp): string | null {
  const line = lines.find((l) => label.test(l));
  return line === undefined ? null : line.replace(label, "");
}

/** Every size in the text, in MB: "3 GB" is 3072, "512MB" is 512. */
function sizesMb(text: string): number[] {
  return [...text.matchAll(SIZE)].map(([, n, unit]) =>
    Math.round(Number(n) * (unit!.toUpperCase() === "GB" ? MB_PER_GB : 1)),
  );
}

/**
 * One alternative in a Graphics line ("NVIDIA GeForce GTX 1060 3 GB") to its
 * score in the GPU table, the table's lowest score for a card older than the
 * table ("GTX 760", "Intel HD Graphics 4000"), or null for any other name.
 * Tolerates the usual spellings: "GTX1060", "RX 6600XT", "GeForce® RTX™",
 * and a bare "Nvidia 2060 Super" or "GeForce 1070 Ti" with no GTX or RTX.
 */
export function cardScore(text: string): number | null {
  const padded = ` ${cardName(text)} `;
  const found = GPU_NAMES.find((known) => padded.includes(` ${known} `));
  if (found !== undefined) return gpuScore(found);
  return OLDER_THAN_TABLE.some((older) => older.test(padded)) ? FLOOR_SCORE : null;
}

/** One alternative in a Graphics line in the GPU table's spelling, its model numbers spelled out. */
function cardName(text: string): string {
  let name = normalizeGpu(text.replace(/[®™]/g, " "))
    .replace(/\b(GTX|RTX|RX|GT)(?=\d)/g, "$1 ")
    .replace(/(\d)(TI|SUPER|XTX|XT)\b/g, "$1 $2");
  // A bare model number only counts next to its vendor's name, so a stray
  // "480 MB" is never read as an RX 480.
  if (!FAMILY.test(name)) {
    if (/\b(?:NVIDIA|GEFORCE)\b/i.test(text))
      name = name.replace(
        /\b(1[06][5-8]0|[234]0[5-9]0)\b/,
        (model) => `${model.startsWith("1") ? "GTX" : "RTX"} ${model}`,
      );
    else if (/\b(?:AMD|RADEON)\b/i.test(text)) name = name.replace(/\b([45][0-9]0|[5-7][0-9]00)\b/, "RX $1");
  }
  return name;
}

/**
 * Read one tier of Steam's pc_requirements HTML. The GPU is the lowest-scoring
 * card cardScore recognises among the alternatives, RAM is the Memory line's size,
 * and VRAM is the smallest size stated as VRAM, else the smallest in the Graphics line.
 */
export function parseTier(html: unknown): ParsedTier {
  if (typeof html !== "string") return { gpuScore: null, ramMb: null, vramMb: null };
  const lines = textLines(html);

  const graphics = field(lines, GRAPHICS_LABEL);
  const scores = (graphics ?? "")
    .replace(OR_BETTER, " ")
    .split(ALTERNATIVES)
    .map(cardScore)
    .filter((score): score is number => score !== null);

  const ram = sizesMb(field(lines, MEMORY_LABEL) ?? "")[0];
  // A size stated as VRAM applies to every card, so it wins over a size the
  // Graphics line gives for one alternative ("RX 5500 XT 8GB").
  const stated = [...lines.join("\n").matchAll(STATED_VRAM)].map(([, size]) => size).join(" ");
  // 256 MB-48 GB: anything else in a Graphics line is not a card's memory.
  const vram = sizesMb(stated || (graphics ?? "")).filter((mb) => mb >= 256 && mb <= 48 * MB_PER_GB);

  return {
    gpuScore: scores.length ? Math.min(...scores) : null,
    ramMb: ram ?? null,
    vramMb: vram.length ? Math.min(...vram) : null,
  };
}

/** Cards newer and stronger than the table's strongest: GeForce RTX 50 and Radeon RX 9000 series. */
const NEWER_THAN_TABLE = [/\bRTX 50[5-9]0\b/, /\bRX 90[6-9]0\b/];

/**
 * Whether Steam's pc_requirements recommend more GPU than any host can have:
 * the recommended tier's Graphics line (the minimum's, where the store states
 * no recommended one) names only cards newer than the GPU table. Hosts are
 * scored by that table, so no host could run such a game as recommended. A
 * line naming any card the table knows, or no card at all, asks for nothing
 * beyond it.
 */
export function recommendsBeyondTable(pcRequirements: unknown): boolean {
  const tiers = (pcRequirements && typeof pcRequirements === "object" ? pcRequirements : {}) as {
    minimum?: unknown;
    recommended?: unknown;
  };
  const graphicsOf = (html: unknown) =>
    typeof html === "string" ? field(textLines(html), GRAPHICS_LABEL) : null;
  const graphics = graphicsOf(tiers.recommended) ?? graphicsOf(tiers.minimum);
  if (graphics === null) return false;
  const cards = graphics.replace(OR_BETTER, " ").split(ALTERNATIVES);
  return (
    cards.every((card) => cardScore(card) === null) &&
    cards.some((card) => NEWER_THAN_TABLE.some((newer) => newer.test(cardName(card))))
  );
}

/**
 * Steam's pc_requirements ({ minimum, recommended } HTML, or [] when the store
 * page has none) to a row's values. A game whose text names no recognised card
 * in either tier gets the default GPU figures, labelled "default", keeping any
 * RAM and VRAM it did state. A tier with no recognised card borrows from the other:
 * the minimum is capped at the recommended, and the recommended is never below
 * the minimum.
 */
export function requirementsFromSteam(pcRequirements: unknown): Stored {
  const tiers = (pcRequirements && typeof pcRequirements === "object" ? pcRequirements : {}) as {
    minimum?: unknown;
    recommended?: unknown;
  };
  const min = parseTier(tiers.minimum);
  const rec = parseTier(tiers.recommended);
  const memory = { minRamMb: min.ramMb ?? 0, minVramMb: min.vramMb ?? 0 };

  if (min.gpuScore === null && rec.gpuScore === null) return { ...DEFAULT_REQUIREMENTS, ...memory };

  const minGpuScore = min.gpuScore ?? Math.min(rec.gpuScore!, DEFAULT_REQUIREMENTS.minGpuScore);
  const recGpuScore = Math.max(rec.gpuScore ?? DEFAULT_REQUIREMENTS.recGpuScore, minGpuScore);
  return { minGpuScore, recGpuScore, ...memory, source: "steam" };
}

// --- curated overrides -----------------------------------------------------------

/** The checked-in overrides that state requirements, as row values, by appid. */
export function curatedRequirements(): Map<number, Stored> {
  return new Map(
    Object.entries(overrides as Record<string, Override>).flatMap(([appid, o]) =>
      o.minGpu === undefined || o.recGpu === undefined
        ? []
        : [
            [
              Number(appid),
              {
                minGpuScore: gpuScore(o.minGpu),
                recGpuScore: gpuScore(o.recGpu),
                minRamMb: Math.round((o.minRamGb ?? 0) * MB_PER_GB),
                minVramMb: Math.round((o.minVramGb ?? 0) * MB_PER_GB),
                source: "curated" as const,
              },
            ] as const,
          ],
    ),
  );
}

/** The checked-in cloud permissions, by appid: the only hand-kept input to playable.ts. */
export function curatedCloud(): Map<number, CloudPermission> {
  return new Map(
    Object.entries(overrides as Record<string, Override>).flatMap(([appid, o]) =>
      o.cloud === undefined ? [] : [[Number(appid), o.cloud] as const],
    ),
  );
}

const CURATED = curatedRequirements();

// --- the table -------------------------------------------------------------------

/** The game_requirements table (schema.ts), on whatever database the server opens. */
export class RequirementsTable {
  readonly #db: Queryable;
  readonly #now: () => number;

  /** Over `db`, which already has the table: migrate() makes it. */
  constructor(db: Queryable, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /** Insert or replace one game's row, stamped with the current time. */
  async upsert(appid: number, values: Stored): Promise<void> {
    await this.#db.query(
      `INSERT INTO game_requirements
         (appid, min_gpu_score, rec_gpu_score, min_ram_mb, min_vram_mb, source, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (appid) DO UPDATE SET
         min_gpu_score = excluded.min_gpu_score, rec_gpu_score = excluded.rec_gpu_score,
         min_ram_mb = excluded.min_ram_mb, min_vram_mb = excluded.min_vram_mb,
         source = excluded.source, updated_at = excluded.updated_at`,
      [
        appid,
        values.minGpuScore,
        values.recGpuScore,
        values.minRamMb,
        values.minVramMb,
        values.source,
        this.#now(),
      ],
    );
  }

  /** The stored row for a game, or null when it has never been seeded. */
  async row(appid: number): Promise<RequirementsRow | null> {
    const {
      rows: [row],
    } = await this.#db.query<Row>("SELECT * FROM game_requirements WHERE appid = $1", [appid]);
    return row ? fromRow(row) : null;
  }

  /**
   * What a game needs, ready for rank(): the curated override if there is one,
   * else the seeded row, else the labelled default. Never null.
   */
  async lookup(appid: number): Promise<Requirements> {
    return (await this.lookupAll([appid]))[0]!;
  }

  /** lookup() for each appid, in the same order, from one read of the table. */
  async lookupAll(appids: number[]): Promise<Requirements[]> {
    const wanted = appids.filter((appid) => !CURATED.has(appid));
    const { rows } = wanted.length
      ? await this.#db.query<Row>("SELECT * FROM game_requirements WHERE appid = ANY ($1::bigint[])", [
          wanted,
        ])
      : { rows: [] };
    const seeded = new Map(rows.map((row) => [row.appid, fromRow(row)]));
    return appids.map((appid) => {
      const values = CURATED.get(appid) ?? seeded.get(appid) ?? DEFAULT_REQUIREMENTS;
      return {
        appid,
        minGpuScore: values.minGpuScore,
        recGpuScore: values.recGpuScore,
        minRamGb: values.minRamMb / MB_PER_GB,
        minVramGb: values.minVramMb / MB_PER_GB,
        source: values.source,
      };
    });
  }
}

/** A game_requirements row as the table hands it out. */
function fromRow(row: Row): RequirementsRow {
  return {
    appid: row.appid,
    minGpuScore: row.min_gpu_score,
    recGpuScore: row.rec_gpu_score,
    minRamMb: row.min_ram_mb,
    minVramMb: row.min_vram_mb,
    source: row.source,
    updatedAt: row.updated_at,
  };
}

// --- seeding from Steam ----------------------------------------------------------

const APPDETAILS_URL = "https://store.steampowered.com/api/appdetails";
/** Between appdetails requests: the store allows roughly 200 per 5 minutes per IP. */
const SEED_PAUSE_MS = 1500;

/**
 * The parts of a store appdetails answer the seeder and playable.ts read; null
 * when Steam has no such app. `drm_notice` names third-party DRM such as
 * Denuvo, and `ext_user_account_notice` an account the game asks for besides
 * Steam's.
 */
export type AppDetails = {
  type?: string;
  name?: string;
  platforms?: { windows?: boolean; mac?: boolean; linux?: boolean };
  drm_notice?: string;
  ext_user_account_notice?: string;
  pc_requirements?: unknown;
} | null;

/**
 * One app's store details from Steam's keyless appdetails endpoint (one appid
 * per request). Throws when the store answers nothing about the app.
 */
export async function fetchAppDetails(appid: number): Promise<AppDetails> {
  const url = new URL(APPDETAILS_URL);
  url.searchParams.set("appids", String(appid));
  url.searchParams.set("l", "english");
  const body = await getJson(url);
  const entry = body?.[String(appid)];
  // A store that is shedding load answers 200 with no entry at all: that is
  // no answer, not an app that does not exist.
  if (!entry || typeof entry !== "object") throw new Error(`appdetails ${appid}: no answer`);
  const data = entry.success ? entry.data : null;
  return data && typeof data === "object" && !Array.isArray(data) ? data : null;
}

export type SeedOutcome = { appid: number; source: RequirementsSource } | { appid: number; skipped: string };

/**
 * Write a row for each appid: curated ones from the overrides file without
 * asking Steam, the rest parsed from appdetails. An app that is not a game, or
 * a request that fails, writes nothing, so a Steam outage never replaces a good
 * row with the default.
 */
export async function seedRequirements(
  table: RequirementsTable,
  appids: number[],
  {
    fetchDetails = fetchAppDetails,
    pauseMs = SEED_PAUSE_MS,
  }: { fetchDetails?: (appid: number) => Promise<AppDetails>; pauseMs?: number } = {},
): Promise<SeedOutcome[]> {
  const outcomes: SeedOutcome[] = [];
  let asked = false;
  for (const appid of new Set(appids)) {
    const curated = CURATED.get(appid);
    if (curated) {
      await table.upsert(appid, curated);
      outcomes.push({ appid, source: "curated" });
      continue;
    }
    if (asked && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    asked = true;
    const details = await fetchDetails(appid).catch((error: unknown) =>
      error instanceof Error ? error : new Error("request failed"),
    );
    if (details instanceof Error) {
      outcomes.push({ appid, skipped: details.message });
    } else if (!details || details.type !== "game") {
      outcomes.push({ appid, skipped: details ? `not a game (${details.type})` : "no such app" });
    } else {
      const values = requirementsFromSteam(details.pc_requirements);
      await table.upsert(appid, values);
      outcomes.push({ appid, source: values.source });
    }
  }
  return outcomes;
}
