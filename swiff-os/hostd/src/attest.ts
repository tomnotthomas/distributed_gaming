// The attestation client: proves to the server, with this PC's TPM, that it
// booted an untouched, signed Lanterel OS just now, and gets the host
// certificate that earns (server/src/tpm-verifier.ts judges it):
//
//   EK      made from the TCG default template (RSA 2048, else ECC P-256): the
//           key the EK certificate the owner's Windows registered certifies
//   AK      a fresh ECC P-256 restricted signing key, made under the EK
//   POST attest-challenge                      ──► { nonce }
//   POST attest-activation { nonce, akPublic } ──► { credentialBlob, encryptedSecret }
//   TPM2_ActivateCredential (AK, EK)                the credential: only this TPM, holding
//                                                   both keys, can recover it
//   TPM2_Quote (AK) over SHA-256(nonce)             PCRs 0-7 and 11-13, SHA-256 bank
//   POST attest { nonce, evidence }            ──► { hostCert, expiresAt, tier }
//
// The evidence carries the PCR values the quote covers, read right after it
// (quoted again when they moved in between), and the firmware's event log.
//
// swiff-hostd runs it as state.attestCommand (swiff-attest.ts) before each try
// to open the state, and it prints { hostCert, expiresAt }.

import { createHash } from "node:crypto";
import type {
  AttestActivationGrant,
  AttestChallengeGrant,
  AttestRefusal,
  HostCertGrant,
  TpmEvidence,
} from "../../../server/src/protocol.ts";
import { AK_SCHEME, AK_TEMPLATE, b2, TpmError, type EkType, type Tpm } from "./tpm.ts";

/** The PCRs the server's verifier needs quoted, all in the SHA-256 bank (tpm-verifier.ts QUOTED_PCRS). */
export const QUOTED_PCRS = [0, 1, 2, 3, 4, 5, 6, 7, 11, 12, 13] as const;

/** The firmware's TCG event log, as the kernel exposes it. */
export const EVENT_LOG = "/sys/kernel/security/tpm0/binary_bios_measurements";

/** How long each call to the server may take. */
const CALL_TIMEOUT_MS = 20_000;
/** How many times to quote again when the PCRs moved between the quote and reading them. */
const QUOTE_TRIES = 3;

/** An attestation the server refused, or a call that did not answer as it should. */
export class AttestFailed extends Error {}

export type AttestDeps = {
  /** The server's HTTPS (or, on this machine, HTTP) origin. */
  origin: string;
  machineId: string;
  tpm: Tpm;
  /** Reads the firmware's event log: EVENT_LOG on a real PC. */
  eventLog: () => Promise<Buffer>;
  /** The EK types to try, in order: the first whose activation succeeds is the registered one. */
  ekTypes?: EkType[];
};

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();

/** Attest this boot: the host certificate the server grants for it. */
export async function attestBoot({
  origin,
  machineId,
  tpm,
  eventLog,
  ekTypes = ["rsa", "ecc"],
}: AttestDeps): Promise<HostCertGrant> {
  const api = (action: string) => new URL(`/api/machines/${encodeURIComponent(machineId)}/${action}`, origin);

  /** POST `body` as JSON; the answer when it is `expected`, else an AttestFailed naming the refusal. */
  async function post<T>(action: string, body: unknown): Promise<T> {
    const res = await fetch(api(action), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    let answer: unknown = null;
    try {
      answer = await res.json();
    } catch {
      // No JSON body: the status says enough.
    }
    if (res.ok && answer && typeof answer === "object") return answer as T;
    const refusal = (answer ?? {}) as Partial<AttestRefusal>;
    const why = [refusal.error, refusal.reason, refusal.detail].filter((part) => typeof part === "string");
    throw new AttestFailed(`${action} answered ${res.status}${why.length ? ` ${why.join(" ")}` : ""}`);
  }

  /** One attestation with the EK of `type`: null when this TPM's EK of that type is not the registered one. */
  async function attestWith(type: EkType): Promise<HostCertGrant | null> {
    let ek;
    try {
      ek = await tpm.ek(type);
    } catch (error) {
      // A TPM without that algorithm: the other EK may be the registered one.
      if (error instanceof TpmError) return null;
      throw error;
    }
    const flush: number[] = ek.persistent ? [] : [ek.handle];
    try {
      const ak = await tpm.createUnderEk(ek.handle, AK_TEMPLATE);
      flush.unshift(ak.handle);
      const akPublic = b2(ak.public).toString("base64");

      const { nonce } = await post<AttestChallengeGrant>("attest-challenge", {});
      if (typeof nonce !== "string") throw new AttestFailed("attest-challenge answered no nonce");
      const made = await post<AttestActivationGrant>("attest-activation", { nonce, akPublic });
      let activation: Buffer;
      try {
        activation = await tpm.activateCredential(
          ak.handle,
          ek.handle,
          Buffer.from(made.credentialBlob, "base64"),
          Buffer.from(made.encryptedSecret, "base64"),
        );
      } catch (error) {
        // The server wrapped the credential to another EK than this one.
        if (error instanceof TpmError) return null;
        throw error;
      }

      const { quote, signature, pcrs } = await quoteNow(tpm, ak.handle, sha256(nonce));
      const evidence: TpmEvidence = {
        akPublic,
        activation: activation.toString("base64"),
        quote: quote.toString("base64"),
        signature: signature.toString("base64"),
        pcrs,
        eventLog: (await eventLog()).toString("base64"),
      };
      const grant = await post<HostCertGrant>("attest", { nonce, evidence });
      if (typeof grant.hostCert !== "string" || typeof grant.expiresAt !== "number") {
        throw new AttestFailed("attest answered no host certificate");
      }
      return grant;
    } finally {
      for (const handle of flush) await tpm.flush(handle).catch(() => {});
    }
  }

  for (const type of ekTypes) {
    const grant = await attestWith(type);
    if (grant) return grant;
  }
  throw new AttestFailed(
    "this TPM's EK is not the one registered for this PC: register it again from Windows",
  );
}

/**
 * A quote of QUOTED_PCRS over `qualifyingData`, with the PCR values it covers:
 * read right after it and checked against its digest, quoting again when a
 * PCR moved in between (systemd extends PCR 11 at each boot phase).
 */
export async function quoteNow(
  tpm: Tpm,
  ak: number,
  qualifyingData: Buffer,
): Promise<{ quote: Buffer; signature: Buffer; pcrs: Record<string, string> }> {
  for (let tries = 1; ; tries++) {
    const { attest, signature } = await tpm.quote(ak, qualifyingData, QUOTED_PCRS, AK_SCHEME);
    const pcrs = await tpm.readPcrs(QUOTED_PCRS);
    // The TPMS_ATTEST ends with its PCR digest: SHA-256, the AK's scheme's hash, of every PCR in order.
    const quoted = attest.subarray(attest.length - 32);
    const read = sha256(Buffer.concat(QUOTED_PCRS.map((pcr) => Buffer.from(pcrs[pcr]!, "hex"))));
    if (read.equals(quoted)) return { quote: attest, signature, pcrs };
    if (tries >= QUOTE_TRIES) throw new AttestFailed("the PCRs kept changing while they were quoted");
  }
}

/** The server's HTTP origin for its ws:// or wss:// URL (config.ts has checked it). */
export function httpOrigin(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}
