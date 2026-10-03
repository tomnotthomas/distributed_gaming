// The browser half of "what can be played where" for a signed-in renter: the
// wall's counts (GET /api/availability) and one game's ranked machines
// (GET /api/games/:appid/machines), both ranked on the server by the same
// @swiff/rank the demo uses (server/src/candidates.ts). Signed out there is
// none of this: the server answers 401, and the page never asks.
//
// Both reads take the renter's round trip to the server (`rtt`), which the page
// measures by timing GET /api/ping, and how they play: controls and Picture.
// Each read spends one of the renter's budget of them (server/src/budget.ts);
// past it the server answers 429 with Retry-After, which is handed back here so
// the caller waits that long before asking again.

import type { Control, PicturePref } from "@swiff/rank";
import type { Machine, Spot } from "./data";
import { clockTime, type Prefs } from "./derive";

/** One machine's latency, as the server estimated it through itself. */
type Latency = { rttMs: number; jitterMs: number; source: "estimate" };

/** The machine a wall tile offers (server/src/candidates.ts WallMachine). */
export type WallMachine = {
  id: string;
  name: string | null;
  gpu: string;
  latency: Latency;
  availableUntil: number | null;
};

/** One game's count on the wall (server/src/candidates.ts GameAvailability). */
export type GameAvailability = {
  appid: number;
  free: number;
  ready: number;
  best: WallMachine | null;
  busy: number;
  backAt: number | null;
  backName: string | null;
};

/** One machine on a game page (server/src/candidates.ts MachineCandidate), as far as the page reads it. */
export type MachineCandidate = {
  id: string;
  name: string | null;
  gpu: string;
  cpu: string;
  refreshHz: number;
  availableUntil: number | null;
  minutesLeft: number | null;
  coversSession: boolean;
  latency: Latency;
  response: number;
  picture: number;
};

/** One game's machines (server/src/candidates.ts GameMachines), as far as the page reads it. */
export type GameMachines = {
  appid: number;
  minutes: number;
  machines: MachineCandidate[];
  reason: { rule: string; label: string } | null;
  busy: { id: string; name: string | null; backAt: number | null }[];
};

/** How the renter asks: their round trip to the server in ms, and how they play. */
export type Ask = { rttMs: number; controls: Control[]; picture: PicturePref };

/** A read's answer, or why there is none: `retryAfterMs` when over budget, else a failure to try later. */
export type Answer<T> = { ok: true; value: T } | { ok: false; retryAfterMs: number | null };

/** The most appids one availability read may ask about (MAX_AVAILABILITY_APPIDS on the server). */
export const MAX_APPIDS = 100;

/** A machine the server has no name for. */
const UNNAMED = "A shared PC";

/** At this many minutes left a machine reads as free all night (fmtLeft). */
const ALL_NIGHT_MINUTES = 12 * 60;

const PICTURE: Record<Prefs["quality"], PicturePref> = { auto: "best", fps: "120fps", resolution: "4k" };

/** The renter's settings as the reads take them. */
export const askOf = (rttMs: number, prefs: Prefs): Ask => ({
  rttMs,
  controls: prefs.devices,
  picture: PICTURE[prefs.quality],
});

const queryOf = (ask: Ask) =>
  `rtt=${Math.round(ask.rttMs)}&controls=${ask.controls.join(",")}&picture=${ask.picture}`;

/** How many pings the round trip is measured over, and the pause between them. */
const PINGS = 3;
const PING_GAP_MS = 150;

/**
 * How long the browser itself saw `url` take, from sending the request to the
 * first byte back (Resource Timing), or null when it kept no entry. Unlike a
 * stopwatch around fetch(), it does not count the wait for a page busy
 * rendering to get round to the answer, which can add a hundred ms or more.
 */
function browserTiming(url: string): number | null {
  const entries = performance.getEntriesByName?.(new URL(url, location.href).href) ?? [];
  const entry = entries[entries.length - 1] as PerformanceResourceTiming | undefined;
  if (!entry?.requestStart || !entry.responseStart) return null;
  return entry.responseStart - entry.requestStart;
}

/**
 * The renter's round trip to the server in ms: the quickest of PINGS pings, a
 * moment apart, so a cold connection or the burst of requests a page makes as
 * it loads does not count against every machine. Each is timed by the browser
 * where it can say, else by the clock. Null when the server cannot be reached.
 */
export async function measureRtt(
  get: typeof fetch = fetch,
  now = () => performance.now(),
  timing: (url: string) => number | null = browserTiming,
  gapMs = PING_GAP_MS,
): Promise<number | null> {
  let best: number | null = null;
  for (let i = 0; i < PINGS; i++) {
    if (i) await new Promise((resolve) => setTimeout(resolve, gapMs));
    // A fresh address each time, so the browser's timing entry is this ping's.
    const url = `/api/ping?n=${i}.${Date.now()}`;
    const start = now();
    try {
      const response = await get(url, { cache: "no-store" });
      if (!response.ok) return best;
    } catch {
      return best;
    }
    const took = Math.max(0, Math.round(timing(url) ?? now() - start));
    best = best === null ? took : Math.min(best, took);
  }
  return best;
}

/** Read one JSON answer, or say why there is none. */
async function read<T>(get: typeof fetch, path: string): Promise<Answer<T>> {
  let response: Response;
  try {
    response = await get(path, { cache: "no-store" });
  } catch {
    return { ok: false, retryAfterMs: null };
  }
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    return { ok: false, retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2000 };
  }
  if (!response.ok) return { ok: false, retryAfterMs: null };
  try {
    return { ok: true, value: (await response.json()) as T };
  } catch {
    return { ok: false, retryAfterMs: null };
  }
}

/**
 * Each game's availability for the renter, `MAX_APPIDS` at a time, for a
 * session of `minutes`. One part failing fails the whole read, so the wall
 * never shows half of it as fresh.
 */
export async function fetchAvailability(
  appids: number[],
  minutes: number,
  ask: Ask,
  get: typeof fetch = fetch,
): Promise<Answer<GameAvailability[]>> {
  const unique = [...new Set(appids)];
  const games: GameAvailability[] = [];
  for (let i = 0; i < unique.length; i += MAX_APPIDS) {
    const part = unique.slice(i, i + MAX_APPIDS);
    const answer = await read<GameAvailability[]>(
      get,
      `/api/availability?appids=${part.join(",")}&minutes=${minutes}&${queryOf(ask)}`,
    );
    if (!answer.ok) return answer;
    games.push(...answer.value);
  }
  return { ok: true, value: games };
}

/** The machines the renter could play one game on for `minutes`, ranked. */
export const fetchMachines = (
  appid: number,
  minutes: number,
  ask: Ask,
  get: typeof fetch = fetch,
): Promise<Answer<GameMachines>> =>
  read<GameMachines>(get, `/api/games/${appid}/machines?minutes=${minutes}&${queryOf(ask)}`);

/**
 * "late" when the owner has not said or it is twelve hours or more away, else
 * the clock time, with the absolute time kept to count down from.
 */
function untilOf(availableUntil: number | null, now: number): Pick<Machine, "until" | "untilAt"> {
  if (availableUntil === null || availableUntil - now >= ALL_NIGHT_MINUTES * 60_000) return { until: "late" };
  return { until: clockTime(availableUntil), untilAt: availableUntil };
}

/** "1440p 120": what a machine delivers for this game, from the server's Picture score and the display. */
function qualityOf(picture: number, refreshHz: number): string {
  const res = picture >= 4 ? "4K" : picture === 3 ? "1440p" : "1080p";
  return `${res} ${refreshHz >= 120 ? 120 : 60}`;
}

/** One game's availability as the wall reads it, told by the clock at `now` (Unix ms). */
export function spotOf(game: GameAvailability, now: number): Spot {
  const best = game.best;
  return {
    free: game.free,
    ready: game.ready,
    busy: game.busy,
    best: best
      ? {
          id: best.id,
          name: best.name ?? UNNAMED,
          gpu: best.gpu,
          ping: Math.round(best.latency.rttMs),
          quality: "",
          ...untilOf(best.availableUntil, now),
          busy: false,
        }
      : null,
    back:
      game.backAt === null
        ? null
        : { name: game.backName ?? UNNAMED, at: clockTime(game.backAt), backAt: game.backAt },
  };
}

/**
 * One game's machines as the game page lists them: the free ones best first,
 * scored by the server, then the busy ones that come back, soonest first.
 */
export function machinesOf(game: GameMachines, now: number): Machine[] {
  const free = game.machines.map((m): Machine => ({
    id: m.id,
    name: m.name ?? UNNAMED,
    gpu: m.gpu,
    cpu: m.cpu,
    ping: Math.round(m.latency.rttMs),
    quality: qualityOf(m.picture, m.refreshHz),
    ...untilOf(m.availableUntil, now),
    busy: false,
    scores: { picture: m.picture, response: m.response },
  }));
  const busy = game.busy.map((m): Machine => ({
    id: m.id,
    name: m.name ?? UNNAMED,
    gpu: "",
    ping: 0,
    quality: "",
    until: "late",
    busy: true,
    ...(m.backAt === null ? {} : { back: clockTime(m.backAt) }),
  }));
  return [...free, ...busy];
}
