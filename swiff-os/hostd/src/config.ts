// What swiff-hostd is told about this machine, read from one JSON file, and the
// two rental-mode policies that are still open decisions, one setting each.

import { readFile, stat } from "node:fs/promises";

/**
 * D8, open (provisional): when the owner may take the PC back to Windows while
 * it is shared. "when-idle": only while no renter's session is live, so a
 * session runs to its end (docs/system-design/host.md requirement 3); a request
 * during one is refused. "always": a request ends the live session as the
 * owner taking the machine back. The firmware boot menu stays the hard escape
 * either way, and counts as a drop.
 */
export const OWNER_TAKEOVER: OwnerTakeover = "when-idle";
export type OwnerTakeover = "when-idle" | "always";

/**
 * D3, open (provisional): the hardware this PC must have before it is offered
 * in rental mode. Each check set to false is skipped. The TPM's EK certificate
 * and the trust tier of a discrete TPM against a firmware one are judged by the
 * server's verifier when it attests the machine, not here.
 */
export const HARDWARE_FLOOR: HardwareFloor = { uefi: true, secureBoot: true, tpm2: true, iommu: true };
export type FloorCheck = "uefi" | "secureBoot" | "tpm2" | "iommu";
export type HardwareFloor = Record<FloorCheck, boolean>;

/** Where the config is read from, unless SWIFF_HOSTD_CONFIG names another file. */
export const DEFAULT_CONFIG_PATH = "/var/lib/swiff/hostd.json";

export type StreamerConfig = {
  /** The streamer executable, started once per renter session. */
  command: string;
  args: string[];
  /** The unprivileged user and group it runs as (swiff-stream), by number. */
  uid: number;
  gid: number;
};

export type Config = {
  /** ws:// or wss:// origin of the signaling server; its HTTP API is on the same origin. */
  serverUrl: string;
  /** This machine's id: its room. */
  machineId: string;
  /** The file holding the machine key, readable by root alone. */
  machineKeyFile: string;
  /** Where the agent keeps what must outlive a reboot. */
  stateDir: string;
  /** The Unix socket the local status page asks the agent through. */
  controlSocket: string;
  streamer: StreamerConfig;
};

/** A config file that is missing a field, has a wrong one, or a key file others can read. */
export class ConfigError extends Error {}

const DEFAULTS = { stateDir: "/var/lib/swiff/hostd", controlSocket: "/run/swiff-hostd/control.sock" };

/** Read and check the config at `path`. Throws ConfigError naming the first bad field. */
export async function loadConfig(path: string): Promise<Config> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new ConfigError(`cannot read ${path}: ${cause instanceof Error ? cause.message : cause}`);
  }
  return parseConfig(raw);
}

/** Check a parsed config. Throws ConfigError naming the first bad field. */
export function parseConfig(raw: unknown): Config {
  const c = record(raw, "config");
  const serverUrl = text(c.serverUrl, "serverUrl");
  if (!/^wss?:\/\//.test(serverUrl)) throw new ConfigError("serverUrl must be a ws:// or wss:// URL");
  const s = record(c.streamer, "streamer");
  const args = s.args ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    throw new ConfigError("streamer.args must be a list of strings");
  }
  return {
    serverUrl,
    machineId: text(c.machineId, "machineId"),
    machineKeyFile: text(c.machineKeyFile, "machineKeyFile"),
    stateDir: c.stateDir === undefined ? DEFAULTS.stateDir : text(c.stateDir, "stateDir"),
    controlSocket:
      c.controlSocket === undefined ? DEFAULTS.controlSocket : text(c.controlSocket, "controlSocket"),
    streamer: {
      command: text(s.command, "streamer.command"),
      args,
      uid: id(s.uid, "streamer.uid"),
      gid: id(s.gid, "streamer.gid"),
    },
  };
}

/**
 * The machine key, from a file nobody but its owner may read: a key the
 * renter's or the streamer's user could read would let them hold the room.
 */
export async function readMachineKey(path: string): Promise<string> {
  const { mode } = await stat(path);
  if (mode & 0o077) throw new ConfigError(`${path} must be readable by its owner only (chmod 600)`);
  const key = (await readFile(path, "utf8")).trim();
  if (!key) throw new ConfigError(`${path} is empty`);
  return key;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new ConfigError(`${field} must be a non-empty string`);
  return value;
}

/** A user or group id: a whole number, never root's. */
function id(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ConfigError(`${field} must be a whole number above 0: the streamer never runs as root`);
  }
  return value as number;
}
