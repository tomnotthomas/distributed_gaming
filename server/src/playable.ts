// Whether Swiff can run a game: a verdict per Steam appid, playable, not
// playable or unknown, with the reasons behind it, decided by fixed rules over
// public data. Nothing is guessed: the same answers always give the same verdict.
//
//   store      appdetails                          not a game, a native Mac build, Denuvo,
//                                                  a third-party account at start, a
//                                                  recommended GPU newer than any host's
//   steamos    ajaxgetdeckappcompatibilityreport   Valve rates it unsupported on SteamOS
//                                                  (its Deck rating where it has no SteamOS one)
//   anticheat  AreWeAntiCheatYet's games.json      its anti-cheat is Denied or Broken on Linux
//   cloud      requirements-overrides.json         its publisher objects to cloud play (curated:
//                                                  no API says so; an allowance is kept as
//                                                  evidence and overrules nothing)
//   sessions   the sessions table                  its launches keep failing on Swiff PCs
//
// Any objection makes a game not playable. Without one, a source with nothing
// to say (no store page, no SteamOS rating) leaves it unknown, and only a game
// every source answered for is playable. Renters are shown, and may book, only
// playable games: unknown counts as not playable. A game with a native Mac
// build is left out too: a renter on a Mac can already play it there.
//
// Checking: the games renters may be shown are asked about, Steam's most
// played and the wall's own nine first, then signed-in renters' libraries,
// and every verdict is checked again once it is a day old. One game at a
// time, PAUSE_MS between store requests (150 per 5 minutes, under the store's
// roughly 200 per IP), and AreWeAntiCheatYet's list once a day. A check where
// any request fails stores nothing, so an outage never replaces a verdict;
// one not confirmed for MAX_AGE_MS counts as unknown.
//
// Launch failures, from what the server already records when a session ends:
// a session the renter started (their first frame, which has the PC launch the
// game) that the renter or the host ended within LAUNCH_FAILURE_MS. A game
// with FAILURES_TO_DEMOTE or more in FAILURE_WINDOW_MS, on two or more
// machines, making up half or more of its started sessions, is not playable
// ("launch-failures") until they age out of the window.

import { getJson, mostPlayed } from "./catalog.js";
import type { Queryable } from "./db.js";
import {
  curatedCloud,
  curatedRequirements,
  fetchAppDetails,
  recommendsBeyondTable,
  type AppDetails,
  type CloudPermission,
} from "./requirements.js";
import { WALL_APPIDS } from "./steam.js";

const DECK_URL = "https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport";
const ANTI_CHEAT_URL =
  "https://raw.githubusercontent.com/AreWeAntiCheatYet/AreWeAntiCheatYet/master/games.json";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A verdict is checked again once it is this old. */
export const CHECK_TTL_MS = DAY;
/** A verdict not confirmed for this long, Steam unreachable since, counts as unknown. */
export const MAX_AGE_MS = 7 * DAY;
/** Between store requests: 150 per 5 minutes, under the store's roughly 200 per IP. */
export const PAUSE_MS = 2_000;
/** After a failed check, before the next store request: Steam may be telling us to slow down. */
const BACKOFF_MS = MINUTE;
const ANTI_CHEAT_TTL_MS = DAY;
/** AreWeAntiCheatYet lists over a thousand games; fewer than this is a list cut short. */
const MIN_ANTI_CHEAT_ENTRIES = 500;
/** How often the chart and every stale verdict are asked about. */
const SWEEP_EVERY_MS = HOUR;
/** How often launch failures are read again. */
const FAILURES_EVERY_MS = 5 * MINUTE;
/** The most games waiting to be checked: a few large libraries' worth. */
const MAX_QUEUE = 20_000;

/** A started session ended this soon by its renter or host counts as a failed launch. */
export const LAUNCH_FAILURE_MS = 3 * MINUTE;
/** How far back failed launches are counted. */
export const FAILURE_WINDOW_MS = 7 * DAY;
/** Failed launches, on at least two machines, that make a game not playable. */
export const FAILURES_TO_DEMOTE = 3;

export type Verdict = "playable" | "not-playable" | "unknown";

/** What makes a game not playable. */
export const OBJECTIONS = [
  "not-a-game",
  "native-mac",
  "denuvo",
  "third-party-account",
  "gpu-beyond-hosts",
  "anti-cheat-denied",
  "anti-cheat-broken",
  "steamos-unsupported",
  "cloud-denied",
  "launch-failures",
] as const;

/** What leaves a game unknown: a source with nothing to say, or no check yet. */
export const GAPS = ["not-on-store", "steamos-unrated", "not-checked"] as const;

export type Objection = (typeof OBJECTIONS)[number];
export type Reason = Objection | (typeof GAPS)[number];

/** A verdict and why: every objection when not playable, every gap when unknown, none when playable. */
export type Judgement = { verdict: Verdict; reasons: Reason[] };

/** Valve's ratings: SteamOS uses 0-2, the Deck 0-3. */
export const STEAMOS_UNRATED = 0;
export const STEAMOS_UNSUPPORTED = 1;

/** Everything one game's verdict is decided from. */
export type Evidence = {
  /** The store's appdetails; null when the store has no such app. */
  details: AppDetails;
  /** Valve's SteamOS rating, else its Deck rating: 0 unrated, 1 unsupported, 2 playable, 3 verified. Null: no report. */
  steamos: number | null;
  /** AreWeAntiCheatYet's status (Supported, Running, Planned, Broken, Denied); null when it does not list the game. */
  antiCheat: string | null;
  /** The curated cloud permission, null when there is none. */
  cloud: CloudPermission | null;
  /** Whether requirements-overrides.json states its requirements, which only name cards hosts can have. */
  curatedRequirements: boolean;
};

/** The rule: one game's verdict from its evidence. */
export function judge({ details, steamos, antiCheat, cloud, curatedRequirements }: Evidence): Judgement {
  const objections: Reason[] = [];
  const gaps: Reason[] = [];
  if (!details) gaps.push("not-on-store");
  else {
    if (details.type !== "game") objections.push("not-a-game");
    if (details.platforms?.mac === true) objections.push("native-mac");
    if (/\bdenuvo\b/i.test(details.drm_notice ?? "")) objections.push("denuvo");
    if ((details.ext_user_account_notice ?? "").trim()) objections.push("third-party-account");
    if (!curatedRequirements && recommendsBeyondTable(details.pc_requirements))
      objections.push("gpu-beyond-hosts");
  }
  if (antiCheat === "Denied") objections.push("anti-cheat-denied");
  if (antiCheat === "Broken") objections.push("anti-cheat-broken");
  if (steamos === STEAMOS_UNSUPPORTED) objections.push("steamos-unsupported");
  else if (steamos === null || steamos === STEAMOS_UNRATED) gaps.push("steamos-unrated");
  if (cloud === "deny") objections.push("cloud-denied");

  if (objections.length) return { verdict: "not-playable", reasons: objections };
  if (gaps.length) return { verdict: "unknown", reasons: gaps };
  return { verdict: "playable", reasons: [] };
}

/** One game's started sessions in the failure window, and how many of them failed to launch. */
export type LaunchStats = { appid: number; started: number; failed: number; failedMachines: number };

/** Whether a game's launches keep failing: enough of them, on more than one machine, and half or more. */
export function launchesFailing({ started, failed, failedMachines }: LaunchStats): boolean {
  return failed >= FAILURES_TO_DEMOTE && failedMachines >= 2 && failed * 2 >= started;
}

// --- the sources -------------------------------------------------------------------

/** Where a check's evidence comes from. Steam, Valve and AreWeAntiCheatYet, or recordings in tests. */
export type Sources = {
  details: (appid: number) => Promise<AppDetails>;
  steamos: (appid: number) => Promise<number | null>;
  /** Steam appid to status, every game the list names. */
  antiCheat: () => Promise<Map<number, string>>;
  /** Steam's most played games right now, most played first. */
  chart: () => Promise<number[]>;
};

/**
 * Valve's rating of one app from its compatibility report: the SteamOS one,
 * else the Deck one; null when Valve has no report for it. Throws when the
 * answer is not a report at all.
 */
export function steamOsRating(body: any): number | null {
  if (body?.success !== 1) throw new Error("steamos: no report");
  const results = body.results;
  // An app Valve knows nothing about answers an empty list.
  if (!results || typeof results !== "object" || Array.isArray(results)) return null;
  const rating = results.steamos_resolved_category ?? results.resolved_category;
  return Number.isInteger(rating) ? rating : null;
}

export async function fetchSteamOsRating(appid: number): Promise<number | null> {
  const url = new URL(DECK_URL);
  url.searchParams.set("nAppID", String(appid));
  url.searchParams.set("l", "english");
  return steamOsRating(await getJson(url));
}

/** AreWeAntiCheatYet's games.json as Steam appid to status. Throws for anything shorter than the real list. */
export function antiCheatStatuses(games: unknown): Map<number, string> {
  if (!Array.isArray(games)) throw new Error("anti-cheat: not a list");
  const statuses = new Map<number, string>();
  for (const game of games) {
    const appid = Number(game?.storeIds?.steam);
    if (Number.isSafeInteger(appid) && appid > 0 && typeof game.status === "string") {
      statuses.set(appid, game.status);
    }
  }
  return statuses;
}

async function fetchAntiCheat(): Promise<Map<number, string>> {
  const statuses = antiCheatStatuses(await getJson(ANTI_CHEAT_URL));
  if (statuses.size < MIN_ANTI_CHEAT_ENTRIES) throw new Error("anti-cheat: list cut short");
  return statuses;
}

export const steamSources: Sources = {
  details: fetchAppDetails,
  steamos: fetchSteamOsRating,
  antiCheat: fetchAntiCheat,
  chart: () => mostPlayed(),
};

// --- the verdicts ------------------------------------------------------------------

/** What the routes need: whether renters may be shown a game, and a way to have games checked. */
export type PlayableGames = {
  playable: (appid: number) => boolean;
  /** Have these games checked, ahead of the rest when `first`. */
  want: (appids: Iterable<number>, options?: { first?: boolean }) => void;
};

/** Every game playable and nothing checked: for tests and tools that are not about playability. */
export const everyGamePlayable: PlayableGames = { playable: () => true, want: () => {} };

type Known = Judgement & { checkedAt: number };
type Row = { appid: number; verdict: Verdict; reasons: string; checked_at: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (what: string) => (error: unknown) =>
  console.error(`[swiff] ${what} failed:`, error instanceof Error ? error.name : typeof error);

/**
 * The game_playability table (schema.ts), every verdict also kept in memory so
 * a route answers without a query, and the checks that keep it current.
 */
export class Playability implements PlayableGames {
  readonly #db: Queryable;
  readonly #sources: Sources;
  readonly #now: () => number;
  readonly #pauseMs: number;
  readonly #backoffMs: number;
  readonly #cloud = curatedCloud();
  readonly #curated = new Set(curatedRequirements().keys());
  readonly #known = new Map<number, Known>();
  #demoted = new Set<number>();
  /** Waiting to be checked: `first` before `rest`, each in the order asked. */
  readonly #first = new Set<number>();
  readonly #rest = new Set<number>();
  #antiCheat: { at: number; value: Promise<Map<number, string>> } | null = null;
  #draining: Promise<void> | null = null;
  /** Not before this (real time) may the next store request go. */
  #nextRequestAt = 0;
  readonly #timers: ReturnType<typeof setInterval>[] = [];
  #stopped = false;

  /** Over `db`, which already has the table: migrate() makes it. */
  constructor(
    db: Queryable,
    {
      sources = steamSources,
      now = Date.now,
      pauseMs = PAUSE_MS,
      backoffMs = BACKOFF_MS,
    }: { sources?: Sources; now?: () => number; pauseMs?: number; backoffMs?: number } = {},
  ) {
    this.#db = db;
    this.#sources = sources;
    this.#now = now;
    this.#pauseMs = pauseMs;
    this.#backoffMs = backoffMs;
  }

  /**
   * The verdict renters are shown: the stored one while it is fresh enough,
   * else unknown, and not playable whatever it says while launches keep failing.
   */
  verdict(appid: number): Judgement {
    const known = this.#known.get(appid);
    const judgement: Judgement =
      known && this.#now() - known.checkedAt < MAX_AGE_MS
        ? { verdict: known.verdict, reasons: known.reasons }
        : { verdict: "unknown", reasons: ["not-checked"] };
    if (!this.#demoted.has(appid)) return judgement;
    const objections = judgement.reasons.filter((r) => (OBJECTIONS as readonly string[]).includes(r));
    return { verdict: "not-playable", reasons: [...objections, "launch-failures"] };
  }

  playable(appid: number): boolean {
    return this.verdict(appid).verdict === "playable";
  }

  /** Read every stored verdict, and the launch failures, from the database. */
  async load(): Promise<void> {
    const { rows } = await this.#db.query<Row>("SELECT * FROM game_playability");
    for (const row of rows) {
      this.#known.set(row.appid, {
        verdict: row.verdict,
        reasons: JSON.parse(row.reasons) as Reason[],
        checkedAt: row.checked_at,
      });
    }
    await this.loadFailures();
  }

  /** Read again which games' launches keep failing. */
  async loadFailures(): Promise<void> {
    const failed = `s.end_reason IN ('renter', 'host_end') AND s.ended_at - s.started_at < $2`;
    const { rows } = await this.#db.query<LaunchStats>(
      `SELECT b.game_id AS appid,
              count(*)::int AS started,
              count(*) FILTER (WHERE ${failed})::int AS failed,
              count(DISTINCT s.machine_id) FILTER (WHERE ${failed})::int AS "failedMachines"
         FROM sessions s JOIN bookings b ON b.id = s.booking_id
        WHERE s.ended_at > $1 AND s.started_at IS NOT NULL
        GROUP BY b.game_id`,
      [this.#now() - FAILURE_WINDOW_MS, LAUNCH_FAILURE_MS],
    );
    this.#demoted = new Set(rows.filter(launchesFailing).map((row) => row.appid));
  }

  /**
   * Have these games checked, ahead of the rest when `first`. A game checked
   * within CHECK_TTL_MS is not asked about again; past MAX_QUEUE waiting, the
   * rest are dropped until asked for again.
   */
  want(appids: Iterable<number>, { first = false }: { first?: boolean } = {}): void {
    const now = this.#now();
    for (const appid of appids) {
      if (!Number.isSafeInteger(appid) || appid <= 0 || this.#first.has(appid)) continue;
      const known = this.#known.get(appid);
      if (known && now - known.checkedAt < CHECK_TTL_MS) continue;
      if (first) {
        this.#rest.delete(appid);
        this.#first.add(appid);
      } else if (!this.#rest.has(appid) && this.#first.size + this.#rest.size < MAX_QUEUE) {
        this.#rest.add(appid);
      }
    }
    this.#drain();
  }

  /** Resolves once nothing is waiting to be checked. */
  async drained(): Promise<void> {
    while (this.#draining) await this.#draining;
  }

  /**
   * Check one game now and store its verdict. Rejects, storing nothing, when
   * any source fails to answer.
   */
  async check(appid: number): Promise<Judgement> {
    const antiCheat = await this.#antiCheatList();
    await this.#turn();
    const details = await this.#sources.details(appid);
    await this.#turn();
    const steamos = await this.#sources.steamos(appid);
    const judgement = judge({
      details,
      steamos,
      antiCheat: antiCheat.get(appid) ?? null,
      cloud: this.#cloud.get(appid) ?? null,
      curatedRequirements: this.#curated.has(appid),
    });
    const checkedAt = this.#now();
    await this.#db.query(
      `INSERT INTO game_playability (appid, verdict, reasons, checked_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (appid) DO UPDATE SET
         verdict = excluded.verdict, reasons = excluded.reasons, checked_at = excluded.checked_at`,
      [appid, judgement.verdict, JSON.stringify(judgement.reasons), checkedAt],
    );
    this.#known.set(appid, { ...judgement, checkedAt });
    return judgement;
  }

  /**
   * Load what is stored, then keep it current: the chart, the wall's nine and
   * every stale verdict asked about now and hourly, launch failures read every
   * few minutes.
   */
  start(): void {
    void this.load()
      .catch(log("loading playability"))
      .then(() => this.#sweep());
    this.#timers.push(
      setInterval(() => void this.#sweep(), SWEEP_EVERY_MS),
      setInterval(() => void this.loadFailures().catch(log("reading launch failures")), FAILURES_EVERY_MS),
    );
    for (const timer of this.#timers) timer.unref?.();
  }

  /** Stop checking. A check already under way finishes. */
  stop(): void {
    this.#stopped = true;
    for (const timer of this.#timers) clearInterval(timer);
  }

  async #sweep(): Promise<void> {
    const chart = await this.#sources.chart().catch(() => [] as number[]);
    this.want([...chart, ...WALL_APPIDS], { first: true });
    this.want([...this.#known.keys(), ...this.#curated, ...this.#cloud.keys()]);
  }

  /** AreWeAntiCheatYet's list, read at most once a day; a failed read is not kept. */
  #antiCheatList(): Promise<Map<number, string>> {
    const now = this.#now();
    if (this.#antiCheat && now - this.#antiCheat.at < ANTI_CHEAT_TTL_MS) return this.#antiCheat.value;
    const value = this.#sources.antiCheat();
    this.#antiCheat = { at: now, value };
    value.catch(() => (this.#antiCheat = null));
    return value;
  }

  /** Wait for the store's turn: PAUSE_MS after the last request. */
  async #turn(): Promise<void> {
    const wait = this.#nextRequestAt - Date.now();
    if (wait > 0) await sleep(wait);
    this.#nextRequestAt = Date.now() + this.#pauseMs;
  }

  /** Check what is waiting, one game at a time, until nothing is. */
  #drain(): void {
    if (this.#draining || this.#stopped) return;
    this.#draining = (async () => {
      for (;;) {
        const appid = this.#first.values().next().value ?? this.#rest.values().next().value;
        if (appid === undefined || this.#stopped) return;
        this.#first.delete(appid);
        this.#rest.delete(appid);
        await this.check(appid).catch((error: unknown) => {
          log("playability check")(error);
          this.#nextRequestAt = Date.now() + this.#backoffMs;
        });
      }
    })().finally(() => {
      this.#draining = null;
      // Asked for while the last check was finishing.
      if (this.#first.size || this.#rest.size) this.#drain();
    });
  }
}
