// Every "how will this actually feel" calculation, kept pure so it can be
// tested without a DOM. Nothing here reads state or the clock except through
// its arguments.

import type { Game, Machine, SessionLength } from "./data";

/**
 * The wall tells one evening's story, so "now" is pinned to 20:00 rather than
 * read off the clock: at 03:00 every machine would otherwise read as free all
 * night and the free-until times would stop meaning anything.
 */
export const NOW_MINUTES = 20 * 60;

const SESSION_MINUTES: Record<SessionLength, number> = { quick: 60, evening: 180, night: 0 };

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

/** Whether this machine covers the whole session you said you wanted. */
export function lasts(machine: Machine, session: SessionLength, now = NOW_MINUTES): boolean {
  const need = SESSION_MINUTES[session];
  // "All night" has no end time to compare against, so it asks for six hours.
  return need === 0 ? minsLeft(machine, now) >= 6 * 60 : minsLeft(machine, now) >= need;
}

/**
 * Picture and Response as 1-4, from the machine's ceiling and your ping. A 4090
 * on a 40 ms link cannot deliver a 4090 experience, so latency caps picture too.
 */
export function meters(machine: Machine): { picture: number; response: number } {
  return {
    picture: machine.ping > 30 ? Math.min(machine.pic, 2) : machine.pic,
    response: machine.ping < 10 ? 4 : machine.ping < 20 ? 3 : machine.ping < 35 ? 2 : 1,
  };
}

/** The same two numbers in the words a player would use, plus the tech behind. */
export function feel(machine: Machine): { text: string; tech: string } {
  const { picture } = meters(machine);
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

/** Why this machine is worth picking, given what else is free. */
export function reason(machine: Machine, all: Machine[]): string {
  const free = all.filter((m) => !m.busy);
  if (free.every((m) => m.ping >= machine.ping)) return "Lowest latency";
  if (free.every((m) => m.pic <= machine.pic)) return "Best picture";
  return "Longest free window";
}

/**
 * The machines a game can run on, best first: free before busy, then the ones
 * that cover your whole session, then lowest ping.
 */
export function machinesFor(
  game: Game,
  pool: Record<string, Machine>,
  session: SessionLength,
): Machine[] {
  return game.machines
    .map((id) => pool[id])
    .filter((m): m is Machine => Boolean(m))
    .sort(
      (a, b) =>
        Number(a.busy) - Number(b.busy) ||
        Number(lasts(b, session)) - Number(lasts(a, session)) ||
        a.ping - b.ping,
    );
}

/** Free now and free for as long as you asked for. */
export function freeFor(game: Game, pool: Record<string, Machine>, session: SessionLength): Machine[] {
  return machinesFor(game, pool, session).filter((m) => !m.busy && lasts(m, session));
}

/**
 * Wall order: playable first, then the ones you have played, then the rest.
 * A game with nothing free sinks but never disappears — it is still yours.
 */
export function wallOrder(
  games: Game[],
  pool: Record<string, Machine>,
  session: SessionLength,
): Game[] {
  const rank = (game: Game) => {
    const free = freeFor(game, pool, session).length > 0 ? 0 : 3;
    return free + (game.last ? 0 : game.owned ? 1 : 2);
  };
  return [...games].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      freeFor(b, pool, session).length - freeFor(a, pool, session).length,
  );
}
