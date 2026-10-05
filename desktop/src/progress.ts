// How long a measured step has left, said the way a person says it. The write
// rate is an exponential moving average over about the last ten seconds; the
// time left shows only once there are five seconds of data, and hides while
// the rate swings by more than half, rather than jump around.

/** Seconds the average looks back over. */
const SPAN = 10;
/** Seconds of data before a time left is said. */
const WARMUP = 5;
/** How far the last few seconds' rate may stray from the average before the time left hides. */
const SWING = 0.5;
/** Seconds the "last few seconds" rate is measured over. */
const RECENT = 2;

export type RateMeter = {
  /** When the first and the latest sample came, in ms, and the bytes done at the latest. */
  since: number;
  at: number;
  done: number;
  /** Bytes per second, averaged; null until two samples. */
  rate: number | null;
  /** A sample from a couple of seconds back, for how steady the rate is now. */
  mark: { at: number; done: number };
  /** The rate over the last couple of seconds, null until there is one. */
  recent: number | null;
};

/** The meter after `done` bytes at `at` (ms). A sample that goes backwards starts it again. */
export function meter(prev: RateMeter | null, done: number, at: number): RateMeter {
  if (!prev || done < prev.done || at < prev.at)
    return { since: at, at, done, rate: null, mark: { at, done }, recent: null };
  const dt = (at - prev.at) / 1000;
  if (dt <= 0) return { ...prev, done };
  const now = (done - prev.done) / dt;
  const weight = 1 - Math.exp(-dt / SPAN);
  const rate = prev.rate === null ? now : prev.rate + weight * (now - prev.rate);
  // The recent rate: from the mark, which moves up once it is RECENT seconds old.
  const markAge = (at - prev.mark.at) / 1000;
  const recent = markAge > 0 ? (done - prev.mark.done) / markAge : prev.recent;
  const mark = markAge >= RECENT ? { at, done } : prev.mark;
  return { since: prev.since, at, done, rate, mark, recent };
}

/**
 * "About 3 minutes left.", "About 1 minute left.", "Less than a minute left.",
 * or null while there is not enough data yet or the rate swings.
 */
export function timeLeft(m: RateMeter | null, total: number): string | null {
  if (!m || m.rate === null || m.rate <= 0) return null;
  if ((m.at - m.since) / 1000 < WARMUP) return null;
  if (m.recent !== null && Math.abs(m.recent - m.rate) > SWING * m.rate) return null;
  const seconds = Math.max(0, total - m.done) / m.rate;
  if (seconds < 60) return "Less than a minute left.";
  const minutes = Math.round(seconds / 60);
  return minutes <= 1 ? "About 1 minute left." : `About ${minutes} minutes left.`;
}

/** 131 → "2:11": a running clock. */
export const mmss = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
