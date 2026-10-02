// How figures, times and names read on the host app's screens.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Euros the European way, without the sign: 1.05 → "1,05". */
export const euros = (n: number, decimals = 2): string => n.toFixed(decimals).replace(".", ",");

/** A wall-clock time in the PC's own zone: "21:00". */
export const clock = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Whole minutes left until `end`, never below zero. */
export const minutesLeft = (end: number, now: number): number => Math.max(0, Math.ceil((end - now) / MINUTE));

/** "in 2 hours", "in 1 h 40 min", "in 25 min": how far off a time is. */
export function inLabel(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `in ${m} min`;
  if (!m) return `in ${h} ${h === 1 ? "hour" : "hours"}`;
  return `in ${h} h ${m} min`;
}

/** A span short enough for a dial: "37 min", "4 h", "2 h 20 min". */
export function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** A countdown: "4:59". */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The card as owners say it: "NVIDIA GeForce RTX 4080" → "RTX 4080". */
export const shortGpu = (name: string): string =>
  name
    .replace(/^NVIDIA\s+/i, "")
    .replace(/^GeForce\s+/i, "")
    .replace(/^AMD\s+/i, "")
    .replace(/^Intel(\(R\))?\s+/i, "")
    .trim() || name;

/** "1 session", "3 sessions". */
export const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export { HOUR, MINUTE };
