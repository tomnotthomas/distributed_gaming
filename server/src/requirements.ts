// What hardware each game needs, for the ranking in @swiff/rank: gate E3
// compares a host with the minimum, and Picture compares it with the
// recommended GPU. One SQLite row per game, in the game_requirements table.
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
// the lower of the alternatives: the game runs on either. A card the table
// does not know is skipped rather than guessed.
//
// RAM and VRAM of 0 mean "not stated": E3 then gates on the GPU alone.

import type { DatabaseSync } from "node:sqlite";
import { gpuScore, normalizeGpu, type GameRequirements } from "@swiff/rank";
import gpuTable from "@swiff/rank/gpu-scores.json" with { type: "json" };
import overrides from "./requirements-overrides.json" with { type: "json" };
import { getJson } from "./catalog.js";

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

/** A curated entry: cards by name, so every number traces back to the GPU score table. */
type Override = {
  name: string;
  minGpu: string;
  recGpu: string;
  minRamGb: number;
  minVramGb: number;
  why: string;
};

const MB_PER_GB = 1024;

/** For a game with nothing better known: GTX 1060-class minimum, RTX 3060-class recommended. */
export const DEFAULT_REQUIREMENTS: Stored = {
  minGpuScore: gpuScore("GTX 1060"),
  recGpuScore: gpuScore("RTX 3060"),
  minRamMb: 0,
  minVramMb: 0,
  source: "default",
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS game_requirements (
  appid         INTEGER PRIMARY KEY,
  min_gpu_score INTEGER NOT NULL,
  rec_gpu_score INTEGER NOT NULL,
  -- 0: not stated.
  min_ram_mb    INTEGER NOT NULL DEFAULT 0,
  min_vram_mb   INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL CHECK (source IN ('steam', 'curated', 'default')),
  updated_at    INTEGER NOT NULL
);
`;

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
const VRAM_LABEL = /^(?:vram|video memory|video ram)\s*:\s*/i;
const SIZE = /(\d+(?:\.\d+)?)\s*(GB|MB)\b/gi;
/** "or better" and friends would otherwise split off as an alternative card. */
const OR_BETTER = /\(?\bor\s+(?:better|higher|above|newer|greater|equivalent|similar)\b\)?/gi;
/** Between alternative cards: "or", "/", ",", ";" and "|". */
const ALTERNATIVES = /\s+or\s+|\s*[/,;|]\s*/i;
const FAMILY = /\b(?:GTX|RTX|GT|RX|HD|R[579]|ARC|IRIS|UHD|QUADRO|VEGA)\b/;

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
 * score in the GPU table, or null when it names no card the table knows.
 * Tolerates the usual spellings: "GTX1060", "RX 6600XT", "GeForce® RTX™",
 * and a bare "Nvidia 2060 Super" or "GeForce 1070 Ti" with no GTX or RTX.
 */
export function cardScore(text: string): number | null {
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
  const padded = ` ${name} `;
  const found = GPU_NAMES.find((known) => padded.includes(` ${known} `));
  return found === undefined ? null : gpuScore(found);
}

/**
 * Read one tier of Steam's pc_requirements HTML. The GPU is the lowest-scoring
 * card the table knows among the alternatives, RAM is the Memory line's size,
 * and VRAM is the smallest size stated for graphics.
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
  // 256 MB-48 GB: anything else in a Graphics line is not a card's memory.
  const vram = sizesMb(`${graphics ?? ""} ${field(lines, VRAM_LABEL) ?? ""}`).filter(
    (mb) => mb >= 256 && mb <= 48 * MB_PER_GB,
  );

  return {
    gpuScore: scores.length ? Math.min(...scores) : null,
    ramMb: ram ?? null,
    vramMb: vram.length ? Math.min(...vram) : null,
  };
}

/**
 * Steam's pc_requirements ({ minimum, recommended } HTML, or [] when the store
 * page has none) to a row's values. A game whose text names no known card in
 * either tier gets the default GPU figures, labelled "default", keeping any
 * RAM and VRAM it did state. A tier with no known card borrows from the other:
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

/** The checked-in overrides as row values, by appid. */
export function curatedRequirements(): Map<number, Stored> {
  return new Map(
    Object.entries(overrides as Record<string, Override>).map(([appid, o]) => [
      Number(appid),
      {
        minGpuScore: gpuScore(o.minGpu),
        recGpuScore: gpuScore(o.recGpu),
        minRamMb: Math.round(o.minRamGb * MB_PER_GB),
        minVramMb: Math.round(o.minVramGb * MB_PER_GB),
        source: "curated",
      },
    ]),
  );
}

const CURATED = curatedRequirements();

// --- the table -------------------------------------------------------------------

/** The game_requirements table, on whatever SQLite database the server opens. */
export class RequirementsTable {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  /** Creates the table on `db` if it is not there yet. */
  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    this.#db.exec(SCHEMA);
  }

  /** Insert or replace one game's row, stamped with the current time. */
  upsert(appid: number, values: Stored): void {
    this.#db
      .prepare(
        `INSERT INTO game_requirements
           (appid, min_gpu_score, rec_gpu_score, min_ram_mb, min_vram_mb, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (appid) DO UPDATE SET
           min_gpu_score = excluded.min_gpu_score, rec_gpu_score = excluded.rec_gpu_score,
           min_ram_mb = excluded.min_ram_mb, min_vram_mb = excluded.min_vram_mb,
           source = excluded.source, updated_at = excluded.updated_at`,
      )
      .run(
        appid,
        values.minGpuScore,
        values.recGpuScore,
        values.minRamMb,
        values.minVramMb,
        values.source,
        this.#now(),
      );
  }

  /** The stored row for a game, or null when it has never been seeded. */
  row(appid: number): RequirementsRow | null {
    const row = this.#db.prepare("SELECT * FROM game_requirements WHERE appid = ?").get(appid) as
      Row | undefined;
    if (!row) return null;
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

  /**
   * What a game needs, ready for rank(): the curated override if there is one,
   * else the seeded row, else the labelled default. Never null.
   */
  lookup(appid: number): Requirements {
    const values = CURATED.get(appid) ?? this.row(appid) ?? DEFAULT_REQUIREMENTS;
    return {
      appid,
      minGpuScore: values.minGpuScore,
      recGpuScore: values.recGpuScore,
      minRamGb: values.minRamMb / MB_PER_GB,
      minVramGb: values.minVramMb / MB_PER_GB,
      source: values.source,
    };
  }
}

// --- seeding from Steam ----------------------------------------------------------

const APPDETAILS_URL = "https://store.steampowered.com/api/appdetails";
/** Between appdetails requests: the store allows roughly 200 per 5 minutes per IP. */
const SEED_PAUSE_MS = 1500;

/** The parts of a store appdetails answer the seeder reads; null when Steam has no such app. */
export type AppDetails = { type?: string; pc_requirements?: unknown } | null;

/** One app's store details from Steam's keyless appdetails endpoint (one appid per request). */
export async function fetchAppDetails(appid: number): Promise<AppDetails> {
  const url = new URL(APPDETAILS_URL);
  url.searchParams.set("appids", String(appid));
  url.searchParams.set("l", "english");
  const body = await getJson(url);
  const entry = body?.[String(appid)];
  const data = entry?.success ? entry.data : null;
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
      table.upsert(appid, curated);
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
      table.upsert(appid, values);
      outcomes.push({ appid, source: values.source });
    }
  }
  return outcomes;
}
