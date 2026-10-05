// Seven days of a machine's behaviour as the server saw it, reduced to the
// StabilityStats that @swiff/rank buckets into Steady, OK, Shaky or New.
//
//   heartbeat coverage   seen_ms / offered_ms from machine_uptime
//   drops per hour       liveness drops / offered hours
//   session completion   sessions not ended by host_offline or owner_kill, of
//                        those not ended early by the host (host_end) or by
//                        the renter not arriving or not coming back (grace_expired)
//   packet loss          median of each session's mean loss from renter QoS
//
// Pure: platform.ts reads the rows, this turns them into numbers.

import { stabilityOf, type Stability, type StabilityStats } from "@swiff/rank";

/** How far back stability looks. */
export const STABILITY_WINDOW_MS = 7 * 24 * 3_600_000;

/**
 * Why a session ended, always decided by the server so a host can never claim
 * credit: renter only through the renter's own ticket, time_up only once the
 * session reaches (or nearly reaches) its expiry, host_end for any earlier end
 * the host reports, owner_kill when the owner takes the machine back,
 * host_offline and grace_expired from the server's own deadlines.
 */
export const END_REASONS = [
  "renter",
  "time_up",
  "owner_kill",
  "host_end",
  "host_offline",
  "grace_expired",
] as const;
export type EndReason = (typeof END_REASONS)[number];

/** Ends that count against the machine: it went away, or its owner took it back mid-session. */
const INCOMPLETE: readonly EndReason[] = ["host_offline", "owner_kill"];

/**
 * Ends left out of completion entirely: the host ended early, often because the
 * renter disconnected without saying so, or the renter never arrived or never
 * came back after a drop (grace_expired), perhaps because the stream was bad.
 * Neither is a completion nor a failure.
 */
const NEUTRAL: readonly EndReason[] = ["host_end", "grace_expired"];

/** One renter's report of stream quality, from getStats. */
export type QosReport = {
  fps: number;
  /** Bits per second received. */
  bitrate: number;
  rttMs: number;
  /** Share of packets lost since the last report, 0-1. */
  packetLoss: number;
};

/** A session's QoS: the mean of every report, and how many there were. */
export type QosSummary = QosReport & { reports: number };

/** Offered time and drops summed over the window. */
export type UptimeTotals = { offeredMs: number; seenMs: number; drops: number };

/** An ended session as stability reads it. */
export type EndedSession = { endReason: EndReason; packetLoss: number | null };

/** Fold one report into a session's summary, as a running mean of each number. */
export function addQos(summary: QosSummary | null, report: QosReport): QosSummary {
  const n = summary?.reports ?? 0;
  const mean = (key: keyof QosReport) => ((summary?.[key] ?? 0) * n + report[key]) / (n + 1);
  return {
    reports: n + 1,
    fps: mean("fps"),
    bitrate: mean("bitrate"),
    rttMs: mean("rttMs"),
    packetLoss: mean("packetLoss"),
  };
}

/** The middle value, or the mean of the two middle ones; 0 for none. */
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The window's uptime and sessions as rank()'s StabilityStats. With nothing
 * offered, coverage is 1 and drops per hour 0; with no sessions, completion is
 * 1; with no QoS, loss is 0. Too little of either is New regardless.
 * host_end and grace_expired sessions are left out of completion but still count as sessions
 * (for New) and towards the loss median, since the machine was really used.
 */
export function stabilityStats(uptime: UptimeTotals, sessions: EndedSession[]): StabilityStats {
  const offeredHours = uptime.offeredMs / 3_600_000;
  const judged = sessions.filter((s) => !NEUTRAL.includes(s.endReason));
  const completed = judged.filter((s) => !INCOMPLETE.includes(s.endReason)).length;
  const losses = sessions.flatMap((s) => (s.packetLoss === null ? [] : [s.packetLoss]));
  return {
    heartbeatCoverage: uptime.offeredMs > 0 ? uptime.seenMs / uptime.offeredMs : 1,
    dropsPerHour: offeredHours > 0 ? uptime.drops / offeredHours : 0,
    sessionCompletion: judged.length ? completed / judged.length : 1,
    packetLoss: median(losses),
    sessions: sessions.length,
    offeredHours,
  };
}

/** The stats and the bucket rank() sorts by. */
export function stabilityFrom(
  uptime: UptimeTotals,
  sessions: EndedSession[],
): { stats: StabilityStats; stability: Stability } {
  const stats = stabilityStats(uptime, sessions);
  return { stats, stability: stabilityOf(stats) };
}

/** The UTC calendar day of `ms`, as YYYY-MM-DD. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Split [start, end) at UTC midnights, with the part of each piece that falls
 * before `seenEnd` (the time still covered by a heartbeat).
 */
export function splitByDay(
  start: number,
  end: number,
  seenEnd: number,
): { day: string; offeredMs: number; seenMs: number }[] {
  const pieces: { day: string; offeredMs: number; seenMs: number }[] = [];
  for (let from = start; from < end;) {
    const midnight = (Math.floor(from / 86_400_000) + 1) * 86_400_000;
    const to = Math.min(end, midnight);
    pieces.push({
      day: utcDay(from),
      offeredMs: to - from,
      seenMs: Math.max(0, Math.min(to, seenEnd) - from),
    });
    from = to;
  }
  return pieces;
}
