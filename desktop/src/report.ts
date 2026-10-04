// What this PC tells the platform about itself, and when: the host report of
// docs/system-design/host.md, over the Host API with the machine key.
//
//   go live          PUT  availability { available: true, until, ...every section known }
//   every 5 s        POST heartbeat    { ...only the sections that changed }
//   share-until set  PUT  availability { available: true, until }
//   pause or stop    PUT  availability { available: false }
//
// The open signaling socket is the PC's presence. The beat keeps it fresh for
// the platform's liveness gate (E1, 15 s) all the same, also while the room is
// handed to a session key. The network figures come from that socket's pings,
// which the server answers without touching its database: `rttMs` the median
// of the latest round trips, `jitterMs` how much they vary from one to the
// next. `upMbps` is timed from an upload test, at going live and every 30
// minutes after, never while a player is on. `net` is sent once all three are
// known, then whenever one has moved.

import { httpOrigin } from "@swiff/rtc";
import type { Control, Encoder, PcRead } from "../pc.cjs";

/** How often the PC beats while it is offered: three missed beats is the platform's 15 s. */
export const BEAT_MS = 5_000;
/** A beat still unanswered this late is given up, so the next one goes out on time. */
export const BEAT_TIMEOUT_MS = 4_000;
/** What one upload test sends. The server takes up to 8 MB (server/src/api.ts). */
export const UPLOAD_TEST_BYTES = 4 * 1024 * 1024;
export const UPLOAD_TEST_EVERY_MS = 30 * 60_000;
/** An upload test that failed is tried again this much later. */
const UPLOAD_RETRY_MS = 60_000;
/** An upload test still running this late is given up and tried again later. */
export const UPLOAD_TIMEOUT_MS = 30_000;
/** Round trips kept: the burst at connect, then about five minutes of pings. */
const RTT_SAMPLES = 12;
/** Round trips needed before they are reported. */
const MIN_RTT_SAMPLES = 3;
/** The largest figures the platform takes (server/src/profile.ts). */
const MAX_MS = 60_000;
const MAX_UP_MBPS = 100_000;

export type ReportHardware = {
  gpu: string;
  vramMb: number;
  ramMb: number;
  cpu: string;
  cores: number;
  encoders: Encoder[];
  display: { width: number; height: number; refreshHz: number };
};

export type Net = { rttMs: number; jitterMs: number; upMbps: number };

/** The report's sections. A section left out keeps what the platform has for it. */
export type HostReport = {
  name?: string;
  hardware?: ReportHardware;
  games?: number[];
  controls?: Control[];
  net?: Net;
};

/** The hardware section: only when every field is known, as the platform requires. */
export function reportHardware(hw: PcRead["hardware"] | null | undefined): ReportHardware | null {
  if (!hw) return null;
  const { gpu, vramMb, ramMb, cpu, cores, encoders, display } = hw;
  if (gpu === null || vramMb === null || ramMb === null || cpu === null || cores === null) return null;
  if (encoders === null || display === null || display.refreshHz === null) return null;
  return {
    gpu: gpu.slice(0, 200),
    vramMb,
    ramMb,
    cpu: cpu.slice(0, 200),
    cores,
    encoders,
    display: { width: display.width, height: display.height, refreshHz: display.refreshHz },
  };
}

/**
 * The sections this PC can report now: its name, and once the PC has been
 * read, its hardware (when complete), its controls and the games the owner
 * offers, which are the only ones the platform matches it on.
 */
export function hostReport({
  name,
  pc,
  offered,
}: {
  name: string;
  pc: PcRead | null;
  offered: number[] | null;
}): HostReport {
  const report: HostReport = {};
  const shown = name.trim().slice(0, 64);
  if (shown) report.name = shown;
  if (!pc) return report;
  const hardware = reportHardware(pc.hardware);
  if (hardware) report.hardware = hardware;
  report.controls = pc.controls;
  if (offered) report.games = [...offered].sort((a, b) => a - b);
  return report;
}

/** `n` to one decimal place. */
const tenth = (n: number) => Math.round(n * 10) / 10;

/** The network section from the latest round trips and upload speed; null until both are known. */
export function netOf(rtts: readonly number[], upMbps: number | null): Net | null {
  if (rtts.length < MIN_RTT_SAMPLES || upMbps === null) return null;
  const sorted = [...rtts].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  // Jitter as RTP measures it: the mean change from one round trip to the next.
  let change = 0;
  for (let i = 1; i < rtts.length; i++) change += Math.abs(rtts[i]! - rtts[i - 1]!);
  return {
    rttMs: tenth(Math.min(median, MAX_MS)),
    jitterMs: tenth(Math.min(change / (rtts.length - 1), MAX_MS)),
    upMbps: tenth(Math.min(upMbps, MAX_UP_MBPS)),
  };
}

/** Whether `next` is worth sending over `sent`: the first figures, or one that has moved by more than noise. */
export function netMoved(sent: Net | null, next: Net): boolean {
  if (!sent) return true;
  const moved = (a: number, b: number, floor: number, share: number) =>
    Math.abs(a - b) > Math.max(floor, a * share);
  return (
    moved(sent.rttMs, next.rttMs, 5, 0.2) ||
    moved(sent.jitterMs, next.jitterMs, 2, 0.5) ||
    moved(sent.upMbps, next.upMbps, 1, 0.2)
  );
}

/** The sections of `next` that differ from what the platform was last sent. */
export function changedSections(sent: HostReport, next: HostReport): HostReport {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(value) !== JSON.stringify(sent[key as keyof HostReport])) changed[key] = value;
  }
  return changed as HostReport;
}

/** `bytes` that do not compress: the test measures the link, not a proxy's gzip. */
function noise(bytes: number): Uint8Array<ArrayBuffer> {
  const body = new Uint8Array(bytes);
  // getRandomValues fills at most 64 KB a call.
  for (let at = 0; at < bytes; at += 65_536) crypto.getRandomValues(body.subarray(at, at + 65_536));
  return body;
}

export type Machine = { url: string; machineId: string; machineKey: string };

export type HostReporter = {
  /** Offer this PC until `until` (null: until the owner stops), then beat every 5 s. */
  offer(until: number | null): void;
  /** The report as it is now: what changed goes with the next beat. */
  update(report: HostReport): void;
  /** A new share-until time, for the platform to stop new claims at. */
  setUntil(until: number | null): void;
  /** A player is on: no upload test runs meanwhile. */
  setBusy(busy: boolean): void;
  /** A round trip to the server, in ms; one taken during an upload test is left out. */
  addRtt(ms: number): void;
  /** Take this PC back and stop beating. `keepalive` lets the call outlive a closing window. */
  withdraw(options?: { keepalive?: boolean }): Promise<void>;
};

export type ReporterOptions = {
  report: HostReport;
  /** A new upload speed, in Mbit/s. */
  onUpload?: (upMbps: number) => void;
  /** Wait for this before the first call: the previous reporter's withdraw, so it cannot land after the offer. */
  after?: Promise<unknown>;
  fetch?: typeof globalThis.fetch;
  /** Milliseconds, for timing the upload test. */
  clock?: () => number;
};

/**
 * The reporter for `machine`: offers the PC with `report`, then beats every
 * 5 s with what changed, until withdrawn. Network failures are retried on the
 * next beat; nothing it does throws.
 */
export function createHostReporter(
  machine: Machine,
  {
    report,
    onUpload,
    after = Promise.resolve(),
    fetch = (...args) => globalThis.fetch(...args),
    clock = () => performance.now(),
  }: ReporterOptions,
): HostReporter {
  /** The Host API route for `action` on this machine. */
  const route = (action: string) =>
    `${httpOrigin(machine.url)}/api/machines/${encodeURIComponent(machine.machineId)}/${action}`;
  const headers = { authorization: `Bearer ${machine.machineKey}`, "content-type": "application/json" };

  let latest = report;
  /** What the platform has: the sections, the net figures and the share-until time it accepted. */
  let sent: HostReport = {};
  let netSent: Net | null = null;
  let until: number | null = null;
  let untilAsked = 0;
  let untilSent = -1;

  let rtts: number[] = [];
  let upMbps: number | null = null;
  let nextUploadAt = 0;
  let uploading = false;
  let busy = false;

  let started = false;
  let beating = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  /** Time one upload test; a failed one is tried again a minute later. */
  const uploadTest = async () => {
    uploading = true;
    try {
      const body = noise(UPLOAD_TEST_BYTES);
      const start = clock();
      const res = await fetch(route("upload-test"), {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      const seconds = (clock() - start) / 1000;
      if (res.status !== 204 || seconds <= 0) throw new Error(`upload test answered ${res.status}`);
      upMbps = (UPLOAD_TEST_BYTES * 8) / 1e6 / seconds;
      nextUploadAt = clock() + UPLOAD_TEST_EVERY_MS;
      if (!stopped) onUpload?.(tenth(upMbps));
    } catch {
      nextUploadAt = clock() + UPLOAD_RETRY_MS;
    } finally {
      uploading = false;
    }
  };

  /** One beat: the offer until the platform has it, then what changed. One at a time. */
  const beat = async () => {
    if (beating || stopped) return;
    beating = true;
    try {
      const changes = changedSections(sent, latest);
      const measured = netOf(rtts, upMbps);
      const net = measured && netMoved(netSent, measured) ? measured : null;
      const body = { ...changes, ...(net ? { net } : {}) };
      const asked = untilAsked;
      // Until the platform has the offer and its time, every beat is the offer.
      const offering = untilSent !== asked;
      const res = offering
        ? await fetch(route("availability"), {
            method: "PUT",
            headers,
            body: JSON.stringify({
              available: true,
              until: until === null ? undefined : new Date(until).toISOString(),
              ...body,
            }),
            signal: AbortSignal.timeout(BEAT_TIMEOUT_MS),
          })
        : await fetch(route("heartbeat"), {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(BEAT_TIMEOUT_MS),
          });
      if (stopped) return;
      // A refused section would be refused again: it waits for its next change instead.
      // A refused offer stored nothing, so the next beat offers again.
      if (res.ok || (res.status === 400 && !offering)) {
        sent = { ...sent, ...changes };
        if (net) netSent = net;
        if (offering) untilSent = asked;
      }
      if (res.status === 400) {
        const why = await res.json().catch(() => null);
        console.warn("[swiff] the platform refused part of this PC's report:", why?.error ?? res.status);
      }
    } catch {
      // Unreachable: the next beat tries again.
    } finally {
      beating = false;
    }
    if (!stopped && !busy && !uploading && untilSent >= 0 && clock() >= nextUploadAt) void uploadTest();
  };

  return {
    offer: (at) => {
      until = at;
      untilAsked++;
      void after.then(() => {
        if (stopped) return;
        started = true;
        void beat();
        timer = setInterval(() => void beat(), BEAT_MS);
      });
    },
    update: (next) => {
      latest = next;
    },
    setUntil: (at) => {
      if (at === until) return;
      until = at;
      untilAsked++;
      if (started) void beat();
    },
    setBusy: (on) => {
      busy = on;
    },
    addRtt: (ms) => {
      // An upload under way fills the link: its round trips say nothing about play.
      if (!uploading && Number.isFinite(ms) && ms >= 0) rtts = [...rtts, ms].slice(-RTT_SAMPLES);
    },
    withdraw: async ({ keepalive = false } = {}) => {
      stopped = true;
      clearInterval(timer);
      await fetch(route("availability"), {
        method: "PUT",
        headers,
        body: JSON.stringify({ available: false }),
        keepalive,
        // The next reporter's offer waits on this: a hung call must not hold it.
        signal: AbortSignal.timeout(BEAT_TIMEOUT_MS),
      }).catch(() => {});
    },
  };
}
