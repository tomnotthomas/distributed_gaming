// This PC's TPM identity with the server (server/src/tpm-verifier.ts), over
// the Host API with the machine key, at Go live:
//
//   which one it has   GET  /api/machines/:id/ek   → { fingerprint }
//   register this one  PUT  /api/machines/:id/ek   { certificate, intermediates }
//
// The server releases Lanterel OS's state key only to a PC that proves with
// this EK's TPM that it booted an untouched Lanterel OS. Registering the same
// EK again tells the server the TPM was cleared: it holds the PC for a day.
// So the app registers only an EK the server does not have: the first, or a
// new TPM's.

import { httpOrigin } from "@swiff/rtc";
import type { EkCertificate } from "../rental.cjs";
import type { Machine } from "./report";

/**
 * Why the EK did not register: the app has no machine key to ask with, the
 * server knows no such PC, refused the machine key, or does not trust the
 * TPM's maker; or it did not answer.
 */
export type EkError = "no-machine" | "unknown-machine" | "bad-key" | "untrusted" | "failed";

/** Registered now, already registered, or a server that takes no EKs (its verifier attests without one). */
export type EkResult =
  { ok: true; registered: "now" | "already" | "not-needed" } | { ok: false; error: EkError };

const TIMEOUT_MS = 15_000;

/** SHA-256 of a base64 DER certificate, in hex: how the server names the EK it has. */
async function fingerprint(certificate: string): Promise<string> {
  const der = Uint8Array.from(atob(certificate), (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What a refusal means for the owner. */
function refusal(status: number, body: unknown): EkError {
  if (status === 401) return "bad-key";
  if (status === 404) return "unknown-machine";
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (status === 403 && (detail === "ek-untrusted" || detail === "ek-unsupported")) return "untrusted";
  return "failed";
}

/** Register `ek` as `machine`'s, unless the server has it already. Nothing it does throws. */
export async function registerEk(
  machine: Machine,
  ek: EkCertificate,
  fetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args),
): Promise<EkResult> {
  let route: string;
  try {
    route = `${httpOrigin(machine.url)}/api/machines/${encodeURIComponent(machine.machineId)}/ek`;
  } catch {
    return { ok: false, error: "failed" };
  }
  const authorization = `Bearer ${machine.machineKey}`;
  try {
    const has = await fetch(route, { headers: { authorization }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body: unknown = await has.json().catch(() => null);
    if (has.status === 503 && (body as { error?: unknown } | null)?.error === "not-configured")
      return { ok: true, registered: "not-needed" };
    if (!has.ok) return { ok: false, error: refusal(has.status, body) };
    if ((body as { fingerprint?: unknown } | null)?.fingerprint === (await fingerprint(ek.certificate)))
      return { ok: true, registered: "already" };
    const put = await fetch(route, {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ certificate: ek.certificate, intermediates: ek.intermediates }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (put.status === 204) return { ok: true, registered: "now" };
    return { ok: false, error: refusal(put.status, await put.json().catch(() => null)) };
  } catch {
    return { ok: false, error: "failed" };
  }
}
