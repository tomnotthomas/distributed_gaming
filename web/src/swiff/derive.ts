// Every "how will this actually feel" calculation, kept pure so it can be
// tested without a DOM. Nothing here reads state or the clock except through
// its arguments. The demo machines are ranked here, by the same @swiff/rank the
// server ranks real hosts with.

import {
  gpuScore,
  headroomOf,
  pictureScore,
  rank,
  responseScore,
  sessionSpanMs,
  type Candidate,
  type GameRequirements,
  type PicturePref,
  type RankResult,
} from "@swiff/rank";
import type { Game, Machine, Requirements, SeedMachine, SessionLength, Spot } from "./data";
import type { Device, Quality } from "./useSwiff";

/**
 * The demo tells one evening's story, so its "now" is pinned to 20:00 rather
 * than read off the clock: at 03:00 every demo machine would otherwise read as
 * free all night and its free-until times would stop meaning anything. Real
 * hosts are told by the real clock (clockMinutes).
 */
export const NOW_MINUTES = 20 * 60;

/** Minutes since local midnight: the real clock, as minsLeft() reads it. */
export const clockMinutes = (at: Date = new Date()): number => at.getHours() * 60 + at.getMinutes();

/** "21:30": a Unix ms time as the local clock shows it. */
export function clockTime(ms: number): string {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

// "All night" has no end time to compare against, so it asks for six hours.
const SESSION_MINUTES: Record<SessionLength, number> = { quick: 60, evening: 180, night: 6 * 60 };

/** The demo's evening, 20:00 today, as Unix ms: the clock the demo pages read. */
export const demoNow = (day: Date = new Date()): number => new Date(day).setHours(20, 0, 0, 0);

/** Minutes from `now` (clock minutes) to a clock time, rolling past midnight. */
function minsUntil(clock: string, now: number): number {
  const [hh = 0, mm = 0] = clock.split(":").map(Number);
  const at = hh * 60 + mm;
  return (at < now ? at + 24 * 60 : at) - now;
}

/** Minutes until the owner wants their machine back, rolling past midnight. */
export function minsLeft(machine: Machine, now = NOW_MINUTES): number {
  if (machine.until === "late") return 12 * 60;
  return minsUntil(machine.until, now);
}

/**
 * Minutes a machine stays free from `now` (Unix ms), as the pages print it. A
 * real host is told by its absolute free-until, so one whose offer has passed
 * since it was read has none left rather than rolling round to tomorrow.
 */
export function leftAt(machine: Machine, now: number): number {
  if (machine.untilAt !== undefined) return Math.max(0, Math.floor((machine.untilAt - now) / 60_000));
  return minsLeft(machine, clockMinutes(new Date(now)));
}

/** "all night", "3 h 20", "45 min" — never a bare number of minutes. */
export function fmtLeft(mins: number): string {
  if (mins >= 11 * 60) return "all night";
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  if (!hh) return `${mm} min`;
  return mm ? `${hh} h ${String(mm).padStart(2, "0")}` : `${hh} h`;
}

/** Tonight's length in minutes. */
export function sessionMinutes(session: SessionLength): number {
  return SESSION_MINUTES[session];
}

/** Whether this machine covers the whole session you said you wanted. */
export function lasts(machine: Machine, session: SessionLength, now = NOW_MINUTES): boolean {
  return minsLeft(machine, now) * 60_000 >= sessionSpanMs(machine, sessionMinutes(session));
}

/** The renter in the seed data: Nova-01's owner, so their own PC stays theirs (gate E5). */
export const RENTER_ID = "you";

/** The Profile settings that shape ranking: Picture (sort rule O3) and Controls (gate E4). */
export type Prefs = { quality: Quality; devices: Device[] };

export const DEFAULT_PREFS: Prefs = { quality: "auto", devices: ["kb", "mouse", "pad"] };

const PICTURE: Record<Quality, PicturePref> = { auto: "best", fps: "120fps", resolution: "4k" };

/** Unknown games ask for a GTX 1060 and are measured against an RTX 3060. */
const DEFAULT_REQUIREMENTS: Requirements = {
  minGpu: "GTX 1060",
  recGpu: "RTX 3060",
  minRamGb: 8,
  minVramGb: 3,
};

/** A game's requirements as rank() reads them: GPU names turned into scores. */
export function requirementsOf(game: Game): GameRequirements {
  const needs = game.requirements ?? DEFAULT_REQUIREMENTS;
  return {
    appid: game.appid,
    minGpuScore: gpuScore(needs.minGpu),
    recGpuScore: gpuScore(needs.recGpu),
    minRamGb: needs.minRamGb,
    minVramGb: needs.minVramGb,
  };
}

/** Clock minutes as rank()'s epoch milliseconds; only differences matter. */
const toMs = (minutes: number) => minutes * 60_000;

/** Demo machines are reached directly with a steady link; only the ping differs. */
const linkOf = (machine: Machine) => ({ rttMs: machine.ping, jitterP95Ms: 2, relayed: false });

/**
 * A demo machine as a ranking candidate for one game. Every demo machine is
 * heartbeating right now, reached directly, and has the game installed if the
 * game lists it.
 */
function candidateOf(machine: SeedMachine, game: Game, now: number): Candidate {
  return {
    host: {
      id: machine.id,
      ownerId: machine.owner,
      status: machine.busy ? "busy" : "available",
      lastHeartbeatAt: toMs(now),
      installed: game.machines.includes(machine.id) ? [game.appid] : [],
      gpu: machine.gpu,
      ramGb: machine.ramGb,
      vramGb: machine.vramGb,
      controls: machine.controls,
      encoders: machine.encoders,
      uploadMbps: machine.uploadMbps,
      fps120: machine.quality.endsWith("120"),
      priceCentsPerHour: machine.priceCentsPerHour,
      availableUntil: toMs(now + minsLeft(machine, now)),
      rentalMode: machine.rentalMode,
    },
    link: linkOf(machine),
    history: machine.history,
  };
}

/** The machines a game lists, ranked for you by @swiff/rank. */
export function rankFor(
  game: Game,
  pool: Record<string, SeedMachine>,
  session: SessionLength,
  prefs: Prefs = DEFAULT_PREFS,
  now = NOW_MINUTES,
): RankResult {
  const machines = game.machines.map((id) => pool[id]).filter((m): m is SeedMachine => Boolean(m));
  const renter = {
    id: RENTER_ID,
    controls: prefs.devices,
    picture: PICTURE[prefs.quality],
    sessionMinutes: sessionMinutes(session),
  };
  return rank(
    requirementsOf(game),
    renter,
    machines.map((m) => candidateOf(m, game, now)),
    { now: toMs(now) },
  );
}

const isSeed = (machine: Machine): machine is SeedMachine => "encoders" in machine;

/**
 * Picture and Response as 1-4, the same buckets rank() sorts on: the machine's
 * GPU against the game, its encoder and upload, and your ping. A 4090 on a 40 ms link cannot deliver a 4090
 * experience, so latency caps picture too. A real host comes scored by the
 * server; only a demo machine is scored here.
 */
export function meters(machine: Machine, game: Game): { picture: number; response: number } {
  if (machine.scores) return machine.scores;
  const response = responseScore(linkOf(machine));
  if (!isSeed(machine)) return { picture: 2, response };
  return {
    picture: pictureScore(headroomOf(machine.gpu, requirementsOf(game)), machine, machine.ping),
    response,
  };
}

/** The same two numbers in the words a player would use, plus the tech behind. */
export function feel(machine: Machine, game: Game): { text: string; tech: string } {
  const { picture } = meters(machine, game);
  const look = picture >= 4 ? "Stunning picture" : picture === 3 ? "Sharp picture" : "Good picture";
  const response =
    machine.ping < 15
      ? "controls feel instant"
      : machine.ping < 30
        ? "controls feel quick"
        : "slight delay on controls";
  const res = picture >= 4 ? "4K 60" : picture === 3 ? "1440p 60" : "1080p 60";
  return { text: `${look}, ${response}`, tech: `${res} · ${machine.ping} ms` };
}

/** Why the first machine is the one to pick: the sort rule that put it above the second. */
export function reason(
  game: Game,
  pool: Record<string, SeedMachine>,
  session: SessionLength,
  prefs: Prefs = DEFAULT_PREFS,
): string | undefined {
  return rankFor(game, pool, session, prefs).reason?.label;
}

/**
 * The machines you could play a game on, best first by @swiff/rank, then the
 * busy ones that are coming back. Your own PC and anything else that fails a
 * gate is not here at all.
 */
export function machinesFor(
  game: Game,
  pool: Record<string, SeedMachine>,
  session: SessionLength,
  prefs: Prefs = DEFAULT_PREFS,
): SeedMachine[] {
  const { hosts, later } = rankFor(game, pool, session, prefs);
  return [...hosts, ...later].map((c) => pool[c.host.id]!);
}

/** Free now and free for as long as you asked for. */
export function freeFor(
  game: Game,
  pool: Record<string, SeedMachine>,
  session: SessionLength,
  prefs: Prefs = DEFAULT_PREFS,
): SeedMachine[] {
  return rankFor(game, pool, session, prefs)
    .hosts.filter((h) => h.coversSession)
    .map((h) => pool[h.host.id]!);
}

/**
 * One game on the demo machines, as the wall reads it: how many are ready for
 * the session, the best of them, and, when none is, the busy one that is back
 * soonest.
 */
export function seedSpot(
  game: Game,
  pool: Record<string, SeedMachine>,
  session: SessionLength,
  prefs: Prefs = DEFAULT_PREFS,
): Spot {
  const ready = freeFor(game, pool, session, prefs);
  const listed = machinesFor(game, pool, session, prefs);
  const back = game.machines
    .map((id) => pool[id])
    .filter((m): m is SeedMachine => Boolean(m?.back))
    .map((m) => ({ name: m.name, at: m.back!, backAt: toMs(NOW_MINUTES + minsUntil(m.back!, NOW_MINUTES)) }))
    .sort((a, b) => a.backAt - b.backAt)[0];
  return {
    free: listed.filter((m) => !m.busy).length,
    ready: ready.length,
    busy: listed.filter((m) => m.busy).length,
    best: ready[0] ?? null,
    back: back ?? null,
  };
}

/** Every game on the demo machines, by game id. */
export function seedSpots(
  games: Game[],
  pool: Record<string, SeedMachine>,
  session: SessionLength,
  prefs: Prefs = DEFAULT_PREFS,
): Map<string, Spot> {
  return new Map(games.map((game) => [game.id, seedSpot(game, pool, session, prefs)]));
}

/** How many machines are ready for a game; a game nothing is known about has none. */
export const readyFor = (spots: ReadonlyMap<string, Spot>, game: Game): number =>
  spots.get(game.id)?.ready ?? 0;

/**
 * Wall order: playable first, then the ones you have played, then the rest.
 * A game with nothing free sinks but never disappears — it is still yours.
 * With nothing known about availability (signed out), only the second part counts.
 */
export function wallOrder(games: Game[], spots: ReadonlyMap<string, Spot>): Game[] {
  const place = (game: Game) => (readyFor(spots, game) > 0 ? 0 : 3) + (game.last ? 0 : game.owned ? 1 : 2);
  return [...games].sort((a, b) => place(a) - place(b) || readyFor(spots, b) - readyFor(spots, a));
}
