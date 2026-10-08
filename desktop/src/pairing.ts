// Pairing this PC with its owner's Steam account (server/src/pairing.ts): how
// the app gets its machine id and key without anyone making one by hand.
//
//   the app     makes a machine key, and opens <server>/pair?k=<SHA-256 of the key>
//   the owner   signs in with Steam on that page and adds the PC
//   the app     asks GET /api/pairings/mine with the key until the server
//               answers with the machine id, then keeps both (settings.ts)
//
// The key stays on this PC: the page and the server see only its hash. The app
// and the page both show a few characters of it (pairingCode), so the owner can
// see that the PC they add is this one, and the app shows the Steam account the
// PC is paired with, so they can see it is theirs. Pairing again uses the key
// the app keeps, which the server answers with the same machine id; only a PC
// with no key makes a new one.

import { httpOrigin } from "@swiff/rtc";
import type { Pairing } from "./model";

/** How often the app asks whether the owner has added the PC yet. */
export const PAIR_POLL_MS = 2_000;
const TIMEOUT_MS = 10_000;

/** A machine id provisioning can hand Lanterel OS (provision.cjs): the server's "pc-" ids, or one MACHINE_KEYS names. */
const MACHINE_ID = /^[^\s,:/\\]{1,128}$/;

/** A new machine key: 32 random bytes, base64url, as `npm run machine-key` makes them. */
export function newMachineKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** SHA-256 of the key, in hex: what the page and the server see of it. */
export async function keyHashOf(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The few characters of the hash the owner compares with the page's: "3F9-A2C". */
export const pairingCode = (keyHash: string): string =>
  `${keyHash.slice(0, 3)}-${keyHash.slice(3, 6)}`.toUpperCase();

/** The page on the server (a ws:// or wss:// address) where the owner adds the PC; null for an address that is not one. */
export function pairLink(serverUrl: string, keyHash: string): string | null {
  try {
    return `${httpOrigin(serverUrl)}/pair?k=${keyHash}`;
  } catch {
    return null;
  }
}

/** Whether the server knows the key yet: its machine id and owner (Steam persona or id), not yet, or no answer. */
export type PairAnswer = { machineId: string; owner: string | null } | "waiting" | "unanswered";

/** Ask the server at `serverUrl` which machine `key` is. Nothing it does throws. */
export async function askPaired(
  serverUrl: string,
  key: string,
  fetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args),
): Promise<PairAnswer> {
  try {
    const res = await fetch(`${httpOrigin(serverUrl)}/api/pairings/mine`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return "waiting";
    if (!res.ok) return "unanswered";
    const body = (await res.json()) as { machineId?: unknown; owner?: unknown } | null;
    const machineId = body?.machineId;
    const owner = typeof body?.owner === "string" && body.owner.trim() ? body.owner.trim() : null;
    return typeof machineId === "string" && MACHINE_ID.test(machineId) ? { machineId, owner } : "unanswered";
  } catch {
    return "unanswered";
  }
}

/**
 * Whether `step` waits for this PC to be paired: Go live and Get paid do,
 * after rental mode's own wait (rental.ts stepLocked), while not live. Never
 * while the saved key is still being read, nor while sharing this Windows
 * desktop, which signs in with Settings' connection (devShare.ts).
 */
export const pairLocked = (
  step: string,
  view: { pairing: Pairing; live: { kind: string } },
  share = false,
): boolean =>
  (step === "live" || step === "paid") &&
  !share &&
  view.live.kind === "off" &&
  view.pairing.kind !== "paired" &&
  view.pairing.kind !== "checking";

/** Where pairing stands, in a few words: the rail's line under it. */
export function pairLine(pairing: Pairing): string {
  switch (pairing.kind) {
    case "checking":
      return "Checking";
    case "unpaired":
      return "Pair with Steam";
    case "waiting":
      return "Waiting for you in the browser";
    case "failed":
      return "Not paired";
    case "paired":
      return "Paired with Steam";
  }
}
