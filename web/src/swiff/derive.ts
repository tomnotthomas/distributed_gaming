// Every "how will this actually feel" calculation, kept pure so it can be
// tested without a DOM. Nothing here reads state or the clock except through
// its arguments.

import {
  gpuScore,
  headroomOf,
  pictureScore,
  rank,
  responseScore,
  type Candidate,
  type GameRequirements,
  type PicturePref,
  type RankResult,
} from "@swiff/rank";
import type { Game, Machine, Requirements, SessionLength } from "./data";
import type { Device, Quality } from "./useSwiff";

/**
 * The wall tells one evening's story, so "now" is pinned to 20:00 rather than
 * read off the clock: at 03:00 every machine would otherwise read as free all
 * night and the free-until times would stop meaning anything.
 */
export const NOW_MINUTES = 20 * 60;

// "All night" has no end time to compare against, so it asks for six hours.
const SESSION_MINUTES: Record<SessionLength, number> = { quick: 60, evening: 180, night: 6 * 60 };

/** Minutes until the owner wants their machine back, rolling past midnight. */
export function minsLeft(machine: Machine, now = NOW_MINUTES): number {
  if (machine.until === "late") return 12 * 60;
  const [hh = 0, mm = 0] = machine.until.split(":").map(Number);
  const at = hh * 60 + mm;
  return (at < now ? at + 24 * 60 : at) - now;
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
  return minsLeft(machine, now) >= sessionMinutes(session);
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

/** Seed machines are reached directly with a steady link; only the ping differs. */
const linkOf = (machine: Machine) => ({ rttMs: machine.ping, jitterP95Ms: 2, relayed: false });

/**
 * A seed machine as a ranking candidate for one game. Every seed machine is
 * heartbeating right now, reached directly, and has the game installed if the
 * game lists it.
 */
function candidateOf(machine: Machine, game: Game, now: number): Candidate {
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
    },
    link: linkOf(machine),
    history: machine.history,
  };
}

/** The machines a game lists, ranked for you by @swiff/rank. */
export function rankFor(
  game: Game,
  pool: Record<string, Machine>,
  session: SessionLength,
  prefs: Prefs = DEFAULT_PREFS,
  now = NOW_MINUTES,
): RankResult {
  const machines = game.machines.map((id) => pool[id]).filter((m): m is Machine => Boolean(m));
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

/**
 * Picture and Response as 1-4, the same buckets rank() sorts on: the machine's
 * GPU against the game, its encoder and upload, and your ping. A 4090 on a 40 ms link cannot deliver a 4090
 * experience, so latency caps picture too.
 */
export function meters(machine: Machine, game: Game): { picture: number; response: number } {
  return {
    picture: pictureScore(headroomOf(machine.gpu, requirementsOf(game)), machine, machine.ping),
    response: responseScore(linkOf(machine)),
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
  pool: Record<string, Machine>,
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
  pool: Record<string, Machine>,
  session: SessionLength,
  prefs: Prefs = DEFAULT_PREFS,
): Machine[] {
  const { hosts, later } = rankFor(game, pool, session, prefs);
  return [...hosts, ...later].map((c) => pool[c.host.id]!);
}

/** Free now and free for as long as you asked for. */
export function freeFor(
  game: Game,
  pool: Record<string, Machine>,
  session: SessionLength,
  prefs: Prefs = DEFAULT_PREFS,
): Machine[] {
  return rankFor(game, pool, session, prefs)
    .hosts.filter((h) => h.coversSession)
    .map((h) => pool[h.host.id]!);
}

/**
 * Wall order: playable first, then the ones you have played, then the rest.
 * A game with nothing free sinks but never disappears — it is still yours.
 */
export function wallOrder(
  games: Game[],
  pool: Record<string, Machine>,
  session: SessionLength,
  prefs: Prefs = DEFAULT_PREFS,
): Game[] {
  const free = new Map(games.map((game) => [game.id, freeFor(game, pool, session, prefs).length]));
  const place = (game: Game) => (free.get(game.id)! > 0 ? 0 : 3) + (game.last ? 0 : game.owned ? 1 : 2);
  return [...games].sort((a, b) => place(a) - place(b) || free.get(b.id)! - free.get(a.id)!);
}
