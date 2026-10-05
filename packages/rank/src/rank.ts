// Host ranking on objective criteria, no AI and no weights.
//
// Seven hard gates decide who is listed at all. Four scores come from fixed
// buckets. One fixed sort orders what is left, first difference wins, and the
// rule that separated the top two is the "Recommended" reason. Pure: the clock
// is an argument, so the same inputs always give the same order.

import { gpuScore } from "./gpu.ts";
import type {
  Candidate,
  Encoder,
  Excluded,
  GameRequirements,
  GateId,
  HostProfile,
  LinkStats,
  PicturePref,
  RankOptions,
  RankResult,
  RankedHost,
  Reason,
  RenterPrefs,
  RuleId,
  Stability,
  StabilityStats,
} from "./types.ts";

/**
 * The most a rental-mode claim waits for its renter's Steam sign-in, counted
 * from the claim across every retry; the booked minutes start after it.
 */
export const STEAM_SIGN_IN_MS = 10 * 60_000;

/** How long a session of `minutes` may hold `host` from its claim: the sign-in first on a rental-mode PC. */
export function sessionSpanMs(host: Pick<HostProfile, "rentalMode">, minutes: number): number {
  return minutes * 60_000 + (host.rentalMode ? STEAM_SIGN_IN_MS : 0);
}

/** E6 default: past this round trip a game stops feeling local. */
export const DEFAULT_MAX_RTT_MS = 80;

/** E1 default: hosts heartbeat every 5 s, so three missed beats is gone. */
export const DEFAULT_HEARTBEAT_MAX_AGE_MS = 15_000;

/** A host that can hold 4K needs one of these to fit it in the upload. */
const EFFICIENT_ENCODERS: Encoder[] = ["hevc", "av1"];

/** Whether the host's last heartbeat is recent enough to count it as live (E1). */
function heartbeatFresh(host: HostProfile, options: RankOptions): boolean {
  return options.now - host.lastHeartbeatAt < (options.heartbeatMaxAgeMs ?? DEFAULT_HEARTBEAT_MAX_AGE_MS);
}

/** Every gate the candidate fails, in gate order. Empty means it is listed. */
export function failedGates(
  { host, link }: Candidate,
  game: GameRequirements,
  renter: RenterPrefs,
  options: RankOptions,
): GateId[] {
  const maxRtt = options.maxRttMs ?? DEFAULT_MAX_RTT_MS;
  const failed: GateId[] = [];
  if (host.status !== "available" || !heartbeatFresh(host, options)) failed.push("E1");
  if (!host.installed.includes(game.appid)) failed.push("E2");
  if (gpuScore(host.gpu) < game.minGpuScore || host.ramGb < game.minRamGb || host.vramGb < game.minVramGb)
    failed.push("E3");
  if (!renter.controls.every((control) => host.controls.includes(control))) failed.push("E4");
  // The renter's own PC is never listed, recommended or matched.
  if (host.ownerId === renter.id) failed.push("E5");
  if (!link || !(link.rttMs <= maxRtt)) failed.push("E6");
  // A crew-only PC hosts only its owner's crew: anyone else never sees it, busy or free.
  if (host.crew && !host.crew.includes(renter.id)) failed.push("E7");
  return failed;
}

/** Response 1-4 from the round trip; jitter or a relayed path costs one step. */
export function responseScore(link: LinkStats): number {
  const base = link.rttMs < 10 ? 4 : link.rttMs < 20 ? 3 : link.rttMs < 35 ? 2 : 1;
  const unsteady = link.jitterP95Ms > 10 || link.relayed;
  return Math.max(1, unsteady ? base - 1 : base);
}

/**
 * Picture 1-4 from GPU headroom over the game's recommended card, the encoder
 * and the owner's upload. A 4090 on a 40 ms link cannot deliver a 4090
 * picture, so a round trip over 30 ms caps it at 2.
 */
export function pictureScore(
  headroom: number,
  host: { encoders: Encoder[]; uploadMbps: number },
  rttMs: number,
): number {
  const efficient = host.encoders.some((encoder) => EFFICIENT_ENCODERS.includes(encoder));
  const score =
    headroom >= 2 && efficient && host.uploadMbps >= 40
      ? 4
      : headroom >= 1.4 && host.uploadMbps >= 25
        ? 3
        : headroom >= 1 && host.uploadMbps >= 15
          ? 2
          : 1;
  return rttMs > 30 ? Math.min(score, 2) : score;
}

/** Seven days of history in one word. Too little history is New, which sorts as OK. */
export function stabilityOf(stats: StabilityStats): Stability {
  if (stats.sessions < 5 || stats.offeredHours < 10) return "new";
  if (
    stats.heartbeatCoverage < 0.97 ||
    stats.dropsPerHour > 0.5 ||
    stats.sessionCompletion < 0.8 ||
    stats.packetLoss > 0.03
  )
    return "shaky";
  if (
    stats.heartbeatCoverage >= 0.995 &&
    stats.dropsPerHour <= 0.1 &&
    stats.sessionCompletion >= 0.95 &&
    stats.packetLoss < 0.01
  )
    return "steady";
  return "ok";
}

/** Host GPU score over the game's recommended score: 1.0 plays it as intended. */
export function headroomOf(gpu: string, game: GameRequirements): number {
  return game.recGpuScore > 0 ? gpuScore(gpu) / game.recGpuScore : 0;
}

/** Scores for a candidate that has passed every gate, so its link is known. */
function score(
  candidate: Candidate,
  link: LinkStats,
  game: GameRequirements,
  renter: RenterPrefs,
  now: number,
) {
  const headroom = headroomOf(candidate.host.gpu, game);
  const minutesLeft = Math.floor((candidate.host.availableUntil - now) / 60_000);
  return {
    ...candidate,
    link,
    response: responseScore(link),
    picture: pictureScore(headroom, candidate.host, link.rttMs),
    stability: stabilityOf(candidate.history),
    headroom,
    minutesLeft,
    coversSession: minutesLeft * 60_000 >= sessionSpanMs(candidate.host, renter.sessionMinutes),
  } satisfies RankedHost;
}

type Step = { rule: RuleId; label: string; compare: (a: RankedHost, b: RankedHost) => number };

/** Higher first. */
const desc = (pick: (h: RankedHost) => number) => (a: RankedHost, b: RankedHost) => pick(b) - pick(a);

/** O3 is the renter's own Picture setting, so its steps depend on it. */
function preferenceSteps(picture: PicturePref): Step[] {
  const response: Step = { rule: "O3", label: "Lowest latency", compare: desc((h) => h.response) };
  const quality: Step = { rule: "O3", label: "Best picture", compare: desc((h) => h.picture) };
  if (picture === "4k") return [quality, response];
  if (picture === "120fps")
    return [{ rule: "O3", label: "120 fps", compare: desc((h) => Number(h.host.fps120)) }];
  return [response, quality];
}

/** The fixed sort, O1 to O6. */
function sortSteps(picture: PicturePref): Step[] {
  return [
    { rule: "O1", label: "Free all session", compare: desc((h) => Number(h.coversSession)) },
    { rule: "O2", label: "Most reliable", compare: desc((h) => Number(h.stability !== "shaky")) },
    ...preferenceSteps(picture),
    { rule: "O4", label: "Lowest latency", compare: (a, b) => a.link.rttMs - b.link.rttMs },
    {
      rule: "O5",
      label: "Lowest price",
      compare: (a, b) => a.host.priceCentsPerHour - b.host.priceCentsPerHour,
    },
    {
      rule: "O6",
      label: "Best match",
      compare: (a, b) => (a.host.id < b.host.id ? -1 : a.host.id > b.host.id ? 1 : 0),
    },
  ];
}

/** The first step that tells two hosts apart, or null when they are the same host. */
function decide(steps: Step[], a: RankedHost, b: RankedHost): { step: Step; order: number } | null {
  for (const step of steps) {
    const order = step.compare(a, b);
    if (order !== 0) return { step, order };
  }
  return null;
}

/**
 * Rank the hosts one renter could play one game on. Returns the listed hosts
 * best first, the busy ones that would otherwise qualify (for "back at"),
 * everything excluded with the gates it failed, and why the first beat the
 * second.
 */
export function rank(
  game: GameRequirements,
  renter: RenterPrefs,
  candidates: Candidate[],
  options: RankOptions,
): RankResult {
  const eligible: RankedHost[] = [];
  const later: Candidate[] = [];
  const excluded: Excluded[] = [];

  for (const candidate of candidates) {
    const failed = failedGates(candidate, game, renter, options);
    if (failed.length === 0 && candidate.link) {
      eligible.push(score(candidate, candidate.link, game, renter, options.now));
      continue;
    }
    excluded.push({ candidate, failed });
    // Busy but otherwise fine: hidden, and counted as coming back. A busy host
    // that has also stopped heartbeating is gone, not busy.
    const onlyBusy = failed.length === 1 && failed[0] === "E1" && candidate.host.status === "busy";
    if (onlyBusy && heartbeatFresh(candidate.host, options)) later.push(candidate);
  }

  const steps = sortSteps(renter.picture);
  const hosts = eligible.sort((a, b) => decide(steps, a, b)?.order ?? 0);
  const [first, second] = hosts;
  const decided = first && second ? decide(steps, first, second) : null;
  const reason: Reason | null = decided ? { rule: decided.step.rule, label: decided.step.label } : null;

  return { hosts, later, excluded, reason };
}
