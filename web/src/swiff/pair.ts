// Pairing a gaming PC with its owner's Steam account (server/src/pairing.ts):
// the page Lanterel on the PC opens (/pair?k=<hash>). `k` is the SHA-256 of
// the machine key the app made, which stays on the PC; the hash is no secret,
// so it rides in the address and through Steam sign-in as it is. The owner
// signs in and adds the PC; the app, asking with its key, carries on by itself.

import { STEAM_LOGIN_URL } from "./steam";

/** Where the host app sends its owner: /pair?k=<hash>. */
export const PAIR_PATH = "/pair";

/** A machine key's SHA-256, in lowercase hex. */
const KEY_HASH = /^[0-9a-f]{64}$/;

/**
 * The key hash a pairing address carries: the hash, "" for /pair with no
 * usable `k`, or null for any other path.
 */
export function pairKeyAt(pathname: string, search: string): string | null {
  if (pathname.replace(/\/+$/, "") !== PAIR_PATH) return null;
  const k = new URLSearchParams(search).get("k") ?? "";
  return KEY_HASH.test(k) ? k : "";
}

/** The few characters of the hash the owner compares with the app's: "3F9-A2C". */
export const pairingCode = (k: string): string => `${k.slice(0, 3)}-${k.slice(3, 6)}`.toUpperCase();

/** Steam sign-in that comes back to this pairing. */
export const signInToPair = (k: string): string =>
  `${STEAM_LOGIN_URL}?to=${encodeURIComponent(`${PAIR_PATH}?k=${k}`)}`;

/** Why adding the PC was refused: another Steam account has it, the owner has the most PCs, or nobody is signed in. */
export type PairRefusal = "paired-elsewhere" | "too-many" | "signed-out";

/**
 * Add the PC whose key hashes to `k` to the signed-in owner's account: its
 * machine id, why it was refused, or null when the server gave no answer.
 */
export async function addPc(
  k: string,
  get: typeof fetch = fetch,
): Promise<{ machineId: string } | PairRefusal | null> {
  try {
    const response = await get("/api/pairings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyHash: k }),
    });
    if (response.status === 401) return "signed-out";
    const body = (await response.json().catch(() => null)) as { machineId?: unknown; code?: unknown } | null;
    if (response.status === 409 && (body?.code === "paired-elsewhere" || body?.code === "too-many"))
      return body.code;
    return response.ok && typeof body?.machineId === "string" ? { machineId: body.machineId } : null;
  } catch {
    return null;
  }
}
