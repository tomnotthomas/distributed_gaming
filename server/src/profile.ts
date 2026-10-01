// What a host reports about itself, in its availability and heartbeat bodies:
// a name, its hardware, the Steam games installed and ready to launch, the
// controls it can take and its network. Every section is optional and, when
// present, replaces what was stored for it, so the host sends `games` only
// when its library changes. The exact payload is in docs/system-design/host.md.
//
// Every field is checked and bounded here, before anything is stored: a
// report is input from a machine on someone else's desk.

import type { Control, Encoder } from "@swiff/rank";

/** The most installed games one report may list. */
export const MAX_GAMES = 2_000;

const ENCODERS: readonly Encoder[] = ["h264", "hevc", "av1"];
const CONTROLS: readonly Control[] = ["kb", "mouse", "pad"];

export type Display = { width: number; height: number; refreshHz: number };

export type Hardware = {
  gpu: string;
  vramMb: number;
  ramMb: number;
  cpu: string;
  cores: number;
  encoders: Encoder[];
  display: Display;
};

export type Net = { rttMs: number; jitterMs: number; upMbps: number };

/** A validated host report. A missing section leaves what is stored for it. */
export type HostReport = {
  name?: string;
  hardware?: Hardware;
  /** Steam appids installed and ready to launch. */
  games?: number[];
  controls?: Control[];
  net?: Net;
};

/** A report that breaks the contract; the message names the field, never its value. */
export class ReportError extends Error {}

type Json = Record<string, unknown>;

/** A JSON object, or a ReportError naming the field. */
function object(value: unknown, field: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReportError(`${field} must be an object`);
  return value as Json;
}

/** A non-empty string of at most `max` characters, trimmed. */
function text(value: unknown, field: string, max: number): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > max)
    throw new ReportError(`${field} must be text of 1 to ${max} characters`);
  return trimmed;
}

/** A whole number from `min` to `max`. */
function whole(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new ReportError(`${field} must be a whole number from ${min} to ${max}`);
  return value as number;
}

/** Whole MB from 0 to `max`, snapped to a whole GB when within 3% of it. */
function memory(value: unknown, field: string, max: number): number {
  const mb = whole(value, field, 0, max);
  const gb = Math.round(mb / 1024) * 1024;
  return Math.abs(mb - gb) <= gb * 0.03 ? gb : mb;
}

/** A finite number from 0 to `max`. */
function amount(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max)
    throw new ReportError(`${field} must be a number from 0 to ${max}`);
  return value;
}

/** A list drawn from `allowed`, without repeats, in the order given. */
function subset<T extends string>(value: unknown, field: string, allowed: readonly T[]): T[] {
  if (!Array.isArray(value) || !value.every((v) => allowed.includes(v)))
    throw new ReportError(`${field} must be a list of ${allowed.join(", ")}`);
  return [...new Set(value as T[])];
}

/** The hardware section: every field required. */
function hardware(value: unknown): Hardware {
  const hw = object(value, "hardware");
  const display = object(hw.display, "hardware.display");
  return {
    gpu: text(hw.gpu, "hardware.gpu", 200),
    vramMb: memory(hw.vramMb, "hardware.vramMb", 256 * 1024),
    ramMb: memory(hw.ramMb, "hardware.ramMb", 4096 * 1024),
    cpu: text(hw.cpu, "hardware.cpu", 200),
    cores: whole(hw.cores, "hardware.cores", 1, 1024),
    encoders: subset(hw.encoders, "hardware.encoders", ENCODERS),
    display: {
      width: whole(display.width, "hardware.display.width", 1, 16_384),
      height: whole(display.height, "hardware.display.height", 1, 16_384),
      refreshHz: whole(display.refreshHz, "hardware.display.refreshHz", 1, 1_000),
    },
  };
}

/** Installed appids: positive whole numbers, at most MAX_GAMES, repeats dropped. */
function games(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > MAX_GAMES)
    throw new ReportError(`games must be a list of at most ${MAX_GAMES} appids`);
  return [...new Set(value.map((appid) => whole(appid, "games[]", 1, 2 ** 31 - 1)))];
}

/** The net section: every field required. */
function net(value: unknown): Net {
  const n = object(value, "net");
  return {
    rttMs: amount(n.rttMs, "net.rttMs", 60_000),
    jitterMs: amount(n.jitterMs, "net.jitterMs", 60_000),
    upMbps: amount(n.upMbps, "net.upMbps", 100_000),
  };
}

/**
 * The host report in an availability or heartbeat body. Other fields in the
 * body are left to the caller. Throws ReportError on the first bad field.
 */
export function parseHostReport(body: Json): HostReport {
  const report: HostReport = {};
  if (body.name !== undefined) report.name = text(body.name, "name", 64);
  if (body.hardware !== undefined) report.hardware = hardware(body.hardware);
  if (body.games !== undefined) report.games = games(body.games);
  if (body.controls !== undefined) report.controls = subset(body.controls, "controls", CONTROLS);
  if (body.net !== undefined) report.net = net(body.net);
  return report;
}
