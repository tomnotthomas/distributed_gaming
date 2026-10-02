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

function load(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage. Losing the value costs one paste.
  }
}

export const loadUrl = () => load(URL_KEY);
export const saveUrl = (url: string) => save(URL_KEY, url);
export const loadMachineId = () => load(ID_KEY) || DEFAULT_HOST_ID;
export const saveMachineId = (id: string) => save(ID_KEY, id);

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

// The owner's choices in the app, kept on this PC: which installed games they
// offer, and whether they have been through the first run.
const OFFERED_KEY = "swiff.offeredGames";
const SETUP_KEY = "swiff.setupDone";
const SESSIONS_KEY = "swiff.sessions";

/** The games the owner chose to offer; null until they choose, which offers every installed game. */
export function loadOffered(): number[] | null {
  try {
    const list: unknown = JSON.parse(load(OFFERED_KEY) || "null");
    return Array.isArray(list) ? list.filter((id): id is number => Number.isInteger(id) && id > 0) : null;
  } catch {
    return null;
  }
}
export const saveOffered = (appids: number[]) => save(OFFERED_KEY, JSON.stringify(appids));

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
export const countSession = (now: number) =>
  save(SESSIONS_KEY, `${dayOf(now)} ${loadSessionsToday(now) + 1}`);
