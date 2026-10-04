// The Electron host is not served by the signaling server, so it cannot read
// the address off `location` the way the web app does. It remembers what was
// typed last instead — the tunnel URL changes often enough to matter.

//
// The machine id is not a secret and lives beside it. The machine key is, so it
// goes through preload.cjs to main, which stores it encrypted by the OS.

import { bridge } from "./bridge";

const URL_KEY = "swiff.signalingUrl";
const ID_KEY = "swiff.machineId";

export const DEFAULT_HOST_ID = "gaming-pc-1";

/** The stored value at `key`, or "" when there is none or storage is blocked. */
function load(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** Store `value` at `key`; blocked storage drops it. */
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage. Losing the value costs one paste.
  }
}

/** The signaling server the owner pasted, as typed. */
export const loadUrl = () => load(URL_KEY);
export const saveUrl = (url: string) => save(URL_KEY, url);
/** This PC's machine id; the default room until the owner sets one. */
export const loadMachineId = () => load(ID_KEY) || DEFAULT_HOST_ID;
export const saveMachineId = (id: string) => save(ID_KEY, id);

/** The machine key, from the OS-encrypted store when the bridge has it. */
export async function loadMachineKey(): Promise<string> {
  return (
    (await bridge()
      ?.loadMachineKey()
      .catch(() => "")) ?? ""
  );
}

/** False when the OS offers no encryption and the key was not kept. */
export async function saveMachineKey(key: string): Promise<boolean> {
  return (
    (await bridge()
      ?.saveMachineKey(key)
      .catch(() => false)) ?? false
  );
}

/** `https://x.trycloudflare.com` and `x.trycloudflare.com` both become wss://. */
export function toSocketUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^wss?:\/\//.test(trimmed)) return trimmed;
  if (/^https:\/\//.test(trimmed)) return trimmed.replace(/^https:/, "wss:");
  if (/^http:\/\//.test(trimmed)) return trimmed.replace(/^http:/, "ws:");
  return `wss://${trimmed}`;
}

/** Hosts an unencrypted address may name: this PC itself, where nothing crosses the network. */
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/**
 * Why the app will not connect to `url` (a toSocketUrl result), or null when
 * it may. The machine key travels in the first message, so anything but this
 * PC itself must be encrypted (wss://, from https:// or a bare address).
 */
export function refusedAddress(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "That signaling server address is not valid.";
  }
  if (parsed.protocol === "wss:") return null;
  if (parsed.protocol === "ws:") {
    return LOOPBACK.test(parsed.hostname)
      ? null
      : "Use an https:// or wss:// address. Over http:// or ws:// this PC's key would cross the network unencrypted.";
  }
  return "That signaling server address is not valid.";
}

// What the app keeps on this PC: whether the owner has been through the first
// run, today's session count, the name players see and the games not offered.
const SETUP_KEY = "swiff.setupDone";
const SESSIONS_KEY = "swiff.sessions";
const NAME_KEY = "swiff.name";
const NOT_OFFERED_KEY = "swiff.notOffered";

/** The name players see; empty means the machine id. */
export const loadName = () => load(NAME_KEY);
export const saveName = (name: string) => save(NAME_KEY, name);

/**
 * The installed games the owner chose not to offer. Kept this way round so a
 * game installed later is offered until the owner turns it off.
 */
export function loadNotOffered(): Set<number> {
  return new Set(
    load(NOT_OFFERED_KEY)
      .split(",")
      .map(Number)
      .filter((appid) => Number.isSafeInteger(appid) && appid > 0),
  );
}
/** Keep the games the owner turned off. */
export const saveNotOffered = (appids: ReadonlySet<number>) => save(NOT_OFFERED_KEY, [...appids].join(","));

/** Whether the owner has finished the first-run setup. */
export const loadSetupDone = () => load(SETUP_KEY) === "1";
export const saveSetupDone = () => save(SETUP_KEY, "1");

/** The day a session count belongs to, on this PC's calendar: "2026-09-24". */
const dayOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Sessions players have claimed on this PC today. */
export function loadSessionsToday(now: number): number {
  const [day, n] = load(SESSIONS_KEY).split(" ");
  return day === dayOf(now) && Number.isInteger(Number(n)) ? Number(n) : 0;
}
/** Count one more session claimed today. */
export const countSession = (now: number) =>
  save(SESSIONS_KEY, `${dayOf(now)} ${loadSessionsToday(now) + 1}`);
