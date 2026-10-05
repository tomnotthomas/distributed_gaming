// Hosting requires attestation: which credential may serve a renter, and how a
// machine earns the one that may.
//
//   Credential        Held by                     May
//   ----------        -------                     ---
//   machine key       the owner's host app        control: set availability, price and
//   (control)         (Windows, DPAPI)            share-until, heartbeat, end a session
//                                                 (the owner's confirmed end-early)
//   host certificate  swiff-hostd in Swiff OS,    host: register the room's service
//   (hosting)         minted after attestation    socket, which hears session-claimed and
//                                                 gets TURN; start a host session, which
//                                                 mints the streamer's session keys; also
//                                                 heartbeat and end a session
//
// HOSTING_ATTESTATION picks the policy per environment:
//
//   optional  (the default, for development) the machine key hosts too, at the
//             explicit "unattested" tier, so today's desktop host app keeps working.
//   required  only a host certificate hosts. The machine key keeps its control
//             rights; a hosting call made with it is refused attestation-required.
//
// A machine earns a host certificate by attestation (protocol.ts has the wire types):
//
//   swiff-hostd                                  this server
//   POST /api/machines/:id/attest-challenge ───► { nonce, expiresAt }       one minute
//   TPM quote over SHA-256(nonce), event log,
//   EK certificate and AK proof
//   POST /api/machines/:id/attest            ───► AttestationVerifier judges the evidence,
//     { nonce, evidence }                         HARDWARE_FLOOR picks the tier
//                                            ◄─── { hostCert, tier, expiresAt }   ten minutes
//   POST /api/machines/:id/state-key         ───► the state partition key's server share,
//     Bearer hostCert                             to the boot that just attested (state-key.ts)
//
// The verifier sits behind an interface, picked with ATTESTATION_VERIFIER:
//
//   tpm           the production verifier (tpm-verifier.ts): the EK certificate
//                 the owner registered chains to a TPM vendor, the AK is
//                 activated against it, the quote is over this nonce, the event
//                 log replays to the quoted PCRs, PCRs 11-13 are a signed Swiff
//                 OS release's, PCR 7 shows only its Secure Boot authorities,
//                 the firmware is the machine's own and its TPM
//                 counters only go forward. It adds two calls of its own:
//                   PUT  /api/machines/:id/ek  (machine key) registers the EK
//                   POST /api/machines/:id/attest-activation  between challenge
//                        and attest, TPM2_MakeCredential for the AK
//   insecure-dev  believes the facts claimed by the holder of the machine's own
//                 key: for VMs and tests, never for a server renters reach.
//
// See docs/system-design/session-keys.md, "Control and hosting credentials".

import {
  mintChallenge,
  mintHostCert,
  verifyChallenge,
  verifyHostCert,
  verifyMachineKey,
  type Access,
  type HostCert,
} from "./access.js";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import type {
  AttestActivationGrant,
  AttestChallengeGrant,
  AttestRefusal,
  AttestRefusalDetail,
  HostCertGrant,
} from "./protocol.js";
import type { Queryable } from "./db.js";
import { loadTrustStore } from "./ek.js";
import { readBootPolicy } from "./boot-policy.js";
import { databaseStore, memoryStore, tpmVerifier, type TpmVerifier } from "./tpm-verifier.js";

/**
 * How long a host certificate admits anything. A socket registered with one is
 * put out when it expires, and a certificate starts one host session at most:
 * so a machine attests again before every session start, and at least every
 * this often while it waits for a renter.
 */
export const HOST_CERT_TTL_SECONDS = 10 * 60;

/** How long a challenge may be quoted over: enough for one TPM quote and the round trip. */
export const CHALLENGE_TTL_SECONDS = 60;

/** What attestation established about the machine that quoted. */
export type PlatformFacts = {
  /** Booted by UEFI firmware, not a legacy BIOS (CSM off). */
  uefi: boolean;
  /** Secure Boot was on for this boot. */
  secureBoot: boolean;
  /** The TPM 2.0 that quoted: in the CPU's firmware (fTPM, PTT) or a discrete chip. Null: none. */
  tpm: "firmware" | "discrete" | null;
  /** The TPM's endorsement key certificate chains to its manufacturer. */
  ekCertificate: boolean;
  /** DMA remapping (VT-d, AMD-Vi) was on. */
  iommu: boolean;
};

/** What a machine must have to host, and how far a discrete TPM is trusted. */
export type HardwareFloor = {
  uefi: boolean;
  secureBoot: boolean;
  ekCertificate: boolean;
  iommu: boolean;
  /**
   * A discrete TPM's bus can be sniffed or interposed on the board, unlike a
   * firmware TPM's. "lower-tier": it hosts at "attested-discrete-tpm".
   * "refused": it does not host.
   */
  discreteTpm: "lower-tier" | "refused";
};

/**
 * D3, the host hardware floor. OPEN: a provisional default the captain has not
 * decided yet, kept here as the one setting to change. Requires UEFI, Secure
 * Boot, a TPM 2.0 with an EK certificate and an IOMMU; accepts a discrete TPM
 * at a lower tier.
 */
export const HARDWARE_FLOOR: HardwareFloor = {
  uefi: true,
  secureBoot: true,
  ekCertificate: true,
  iommu: true,
  discreteTpm: "lower-tier",
};

/** The tier a machine with `facts` hosts at under `floor`, or null when it is below the floor. */
export function tierFor(
  facts: PlatformFacts,
  floor: HardwareFloor = HARDWARE_FLOOR,
): HostCert["tier"] | null {
  if (facts.tpm === null) return null;
  if (floor.uefi && !facts.uefi) return null;
  if (floor.secureBoot && !facts.secureBoot) return null;
  if (floor.ekCertificate && !facts.ekCertificate) return null;
  if (floor.iommu && !facts.iommu) return null;
  if (facts.tpm === "discrete") return floor.discreteTpm === "lower-tier" ? "attested-discrete-tpm" : null;
  return "attested";
}

/**
 * A verifier's judgement: what it verified about the machine, or that it
 * could not, and why when it can say.
 */
export type Verdict =
  /** `boot`: the quote's TPM resetCount, which counts the machine's boots, when the verifier reads one. */
  { ok: true; facts: PlatformFacts; boot?: number } | { ok: false; reason?: AttestRefusalDetail };

/** Judges a machine's attestation evidence. Keylime, Swiff's own, or the insecure dev stub. */
export type AttestationVerifier = {
  /** Named in the startup log. */
  readonly name: string;
  /**
   * Whether `evidence` proves machine `room` booted an untouched Swiff OS just
   * now, and what it proves about its hardware. `nonce` is the challenge this
   * server issued; a real verifier requires the quote's qualifying data to be
   * its SHA-256. `now` is Unix ms. Rejects only when the verifier itself fails.
   */
  verify(input: { room: string; nonce: string; evidence: unknown; now?: number }): Promise<Verdict>;
  /** Register the machine's EK certificate, when the verifier works from one (tpm-verifier.ts). */
  enroll?: Enroll;
  /** Make the AK activation credential for a challenge, when the verifier activates AKs. */
  activate?: Activate;
  /**
   * Whether machine `room` is waiting out a firmware cooldown right now: new
   * firmware seen, or its EK registered again. Its state key is not released
   * meanwhile (state-key.ts). Absent: the verifier keeps no firmware baseline.
   */
  inCooldown?: (room: string, now?: number) => Promise<boolean>;
};

/** Register machine `room`'s EK certificate (base64 DER), refusing one no vendor root vouches for. */
export type Enroll = (input: {
  room: string;
  certificate: unknown;
  intermediates?: unknown;
  now?: number;
}) => Promise<{ ok: true } | { ok: false; reason: AttestRefusalDetail }>;

/** TPM2_MakeCredential to `room`'s registered EK, for the AK `akPublic` and the challenge `nonce`. */
export type Activate = (input: {
  room: string;
  nonce: string;
  akPublic: unknown;
  now?: number;
}) => Promise<{ ok: true; activation: AttestActivationGrant } | { ok: false; reason: AttestRefusalDetail }>;

const TPM_KINDS: readonly unknown[] = ["firmware", "discrete", null];

/** `value` as PlatformFacts, or null when any field is missing or of the wrong type. */
function platformFacts(value: unknown): PlatformFacts | null {
  if (!value || typeof value !== "object") return null;
  const facts = value as Record<string, unknown>;
  const flags = ["uefi", "secureBoot", "ekCertificate", "iommu"] as const;
  if (!flags.every((flag) => typeof facts[flag] === "boolean")) return null;
  if (!TPM_KINDS.includes(facts.tpm)) return null;
  return {
    uefi: facts.uefi as boolean,
    secureBoot: facts.secureBoot as boolean,
    tpm: facts.tpm as PlatformFacts["tpm"],
    ekCertificate: facts.ekCertificate as boolean,
    iommu: facts.iommu as boolean,
  };
}

/**
 * The development stub for the machines in `machines`: evidence
 * `{ machineKey, facts: PlatformFacts, resetCount? }` passes when `machineKey`
 * is that machine's own key, and its facts and boot count are believed. A real verifier proves who is
 * asking with the TPM's endorsement key registered for the machine; the stub
 * has no TPM, so the machine key stands in for that proof, and only its holder
 * can earn a certificate. The facts prove nothing, so it exists only to drive
 * the hosting gate in VMs and tests until a real verifier exists. The server
 * warns at startup whenever it is configured.
 */
export function insecureDevVerifier(machines: Map<string, Buffer>): AttestationVerifier {
  return {
    name: INSECURE_DEV,
    async verify({ room, evidence }) {
      const claim = (evidence ?? {}) as { machineKey?: unknown; facts?: unknown };
      if (!verifyMachineKey(machines, room, claim.machineKey)) return { ok: false };
      const facts = platformFacts(claim.facts);
      if (!facts) return { ok: false };
      const boot = (claim as { resetCount?: unknown }).resetCount;
      return Number.isSafeInteger(boot) && (boot as number) >= 0
        ? { ok: true, facts, boot: boot as number }
        : { ok: true, facts };
    },
  };
}

const INSECURE_DEV = "insecure-dev";

/** The attestation configuration from the environment, and what is wrong with it. */
export type AttestationConfig = {
  /** HOSTING_ATTESTATION=required: only a host certificate hosts. */
  attestedOnly: boolean;
  /** ATTESTATION_VERIFIER; null when unset or unknown: no machine can attest. */
  verifier: AttestationVerifier | null;
  /** Lines for the startup log. */
  warnings: string[];
};

/**
 * HOSTING_ATTESTATION (`optional`, the default, or `required`) and
 * ATTESTATION_VERIFIER (unset, `tpm`, or `insecure-dev` for the machines in
 * `machines`). An unknown policy is read as `required` and an unknown verifier
 * as none: a typo never opens hosting up. `tpm` keeps each machine's EK,
 * firmware baseline and TPM counters in `database`, and needs:
 *
 *   ATTESTATION_TPM_ROOTS   directory of TPM vendor roots, in firmware/ and discrete/ (ek.ts)
 *   ATTESTATION_POLICY      the signed boot policy file (boot-policy.ts)
 *   ATTESTATION_POLICY_KEY  the PEM public key that signs it
 *   ROOM_SECRET             keys the AK activation credentials
 *
 * Any of them missing or unreadable leaves no verifier, with a warning saying which.
 */
export function attestationFromEnv(
  env: NodeJS.ProcessEnv,
  machines: Map<string, Buffer> = new Map(),
  database?: Queryable,
): AttestationConfig {
  const warnings: string[] = [];
  const policy = env.HOSTING_ATTESTATION?.trim().toLowerCase() || "optional";
  if (policy !== "optional" && policy !== "required") {
    warnings.push(`HOSTING_ATTESTATION is not "optional" or "required" — hosting requires attestation`);
  }
  const attestedOnly = policy !== "optional";

  const name = env.ATTESTATION_VERIFIER?.trim() ?? "";
  let verifier: AttestationVerifier | null = null;
  if (name === INSECURE_DEV) {
    verifier = insecureDevVerifier(machines);
    warnings.push(
      "ATTESTATION_VERIFIER=insecure-dev believes any facts from a machine-key holder — never use it where renters play",
    );
  } else if (name === "tpm") {
    try {
      verifier = tpmVerifierFromEnv(env, database);
    } catch (error) {
      warnings.push(
        `ATTESTATION_VERIFIER=tpm is not configured — no machine can attest: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (verifier && !database) {
      warnings.push(
        "ATTESTATION_VERIFIER=tpm keeps its machines in memory — a restart forgets firmware baselines",
      );
    }
  } else if (name) {
    warnings.push(`ATTESTATION_VERIFIER "${name}" is unknown — no machine can attest`);
  }
  if (attestedOnly && !verifier)
    warnings.push("hosting requires attestation and no verifier is set — no PC can host");
  if (!attestedOnly)
    warnings.push("HOSTING_ATTESTATION=optional — machine keys host unattested (development only)");
  return { attestedOnly, verifier, warnings };
}

/** The TPM verifier from the environment; throws naming what is missing or unreadable. */
function tpmVerifierFromEnv(env: NodeJS.ProcessEnv, database?: Queryable): TpmVerifier {
  const setting = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`${key} is not set`);
    return value;
  };
  const secret = setting("ROOM_SECRET");
  const roots = loadTrustStore(setting("ATTESTATION_TPM_ROOTS"));
  if (!roots.roots.length) throw new Error("ATTESTATION_TPM_ROOTS has no root certificates");
  const policy = readBootPolicy(
    readFileSync(setting("ATTESTATION_POLICY"), "utf8"),
    readFileSync(setting("ATTESTATION_POLICY_KEY"), "utf8"),
  );
  return tpmVerifier({
    store: database ? databaseStore(database) : memoryStore(),
    roots,
    policy,
    activationKey: createHmac("sha256", secret).update("swiff-ak-activation-key").digest(),
  });
}

/** A credential a gaming PC presented, and whether it may host. */
export type Credential =
  /** The control credential. `hosting` is null when hosting requires attestation. */
  | { kind: "machine-key"; hosting: "unattested" | null }
  /**
   * The hosting credential, at the tier attestation found. `spent`: it has
   * started a host session, so it may no longer register or start another;
   * it may still report that session's renter in, heartbeat and end it.
   */
  | {
      kind: "host-cert";
      hosting: HostCert["tier"];
      id: string;
      exp: number;
      spent: boolean;
      /** When it was minted (Unix seconds) and the boot it was minted for (access.ts HostCert). */
      iat: number | null;
      boot: number | null;
    };

/** A refused challenge or attestation, with the HTTP status to answer it with. */
export type Refusal = { ok: false; status: number; body: AttestRefusal };

export type Attestation = {
  /** Whether only a host certificate hosts. */
  readonly attestedOnly: boolean;
  /**
   * A fresh challenge for machine `room`, or a refusal: 404 for a machine with
   * no key configured, 503 when no secret or no verifier is configured.
   * `now` is Unix milliseconds.
   */
  challenge(room: string, now?: number): { ok: true; grant: AttestChallengeGrant } | Refusal;
  /**
   * The AK activation for challenge `nonce` of machine `room`: TPM2_MakeCredential
   * to its registered EK for the AK `akPublic`. 401 bad-nonce for a challenge
   * that is not live, 403 attestation-refused (with `detail`) for an EK or AK
   * the verifier refuses, 503 not-configured when the verifier activates no AKs.
   */
  activate(
    room: string,
    nonce: unknown,
    akPublic: unknown,
    now?: number,
  ): Promise<{ ok: true; grant: AttestActivationGrant } | Refusal>;
  /**
   * Register machine `room`'s EK certificate (`certificate`, base64 DER, and
   * optional `intermediates`), called with its machine key. 403
   * attestation-refused (`ek-untrusted`) when no TPM vendor root vouches for
   * it, 503 not-configured when the verifier registers no EKs.
   */
  enroll(
    room: string,
    body: { certificate?: unknown; intermediates?: unknown },
    now?: number,
  ): Promise<{ ok: true } | Refusal>;
  /**
   * Judge `evidence` quoted over `nonce` by machine `room`, and mint a host
   * certificate when it passes and the machine meets the hardware floor. The
   * challenge is held while its attempt is judged and spent only when it earns
   * a certificate; a verifier that fails answers 503 verifier-unavailable.
   */
  attest(
    room: string,
    nonce: unknown,
    evidence: unknown,
    now?: number,
  ): Promise<{ ok: true; grant: HostCertGrant } | Refusal>;
  /** What `token` is for machine `room`: its machine key, a host certificate for it, or null. */
  credential(room: string, token: unknown, now?: number): Credential | null;
  /**
   * Spend a host certificate on the host session it is starting. False, when
   * it was already spent (one certificate, one session start) or has expired
   * since it was checked. `now` is Unix ms.
   */
  spend(credential: Credential, now?: number): boolean;
};

/**
 * Attestation for the machines in `access`, signed with its secret, judged by
 * `verifier` against `floor`. `onAttested` hears of each machine that passed,
 * with the boot its quote counted, before its certificate is minted; when it
 * fails, no certificate is (state-key.ts keeps the boots). Spent challenges and certificates are kept in
 * memory until they expire: a restart forgets them, so a certificate spent just
 * before one could start one more session within what is left of its ten minutes.
 */
export function createAttestation({
  access,
  verifier = null,
  attestedOnly = false,
  floor = HARDWARE_FLOOR,
  ttlSeconds = HOST_CERT_TTL_SECONDS,
  onAttested,
}: {
  access: Access;
  verifier?: AttestationVerifier | null;
  attestedOnly?: boolean;
  floor?: HardwareFloor;
  ttlSeconds?: number;
  onAttested?: (room: string, boot: number | null, now: number) => Promise<void>;
}): Attestation {
  /** Per machine, challenge id being judged or spent → when it expires (Unix ms). */
  const spent = new Map<string, Map<string, number>>();
  /** Host certificate id → when it expires (Unix ms), once it has started a session. */
  const spentCerts = new Map<string, number>();
  const forgetExpired = (ids: Map<string, number>, now: number) => {
    for (const [id, until] of ids) if (until <= now) ids.delete(id);
  };
  const refuse = (status: number, body: AttestRefusal): Refusal => ({ ok: false, status, body });
  const rejected = (detail: AttestRefusalDetail | undefined) =>
    refuse(403, { error: "attestation-refused", reason: "evidence-rejected", ...(detail ? { detail } : {}) });
  /** A verifier failing is the server's fault, never the machine's: logged by kind only. */
  const failed = (error: unknown) => {
    console.error("[swiff] attestation verifier failed:", error instanceof Error ? error.name : typeof error);
    return refuse(503, { error: "verifier-unavailable" });
  };

  return {
    attestedOnly,

    challenge(room, now = Date.now()) {
      if (!access.secret || !verifier) return refuse(503, { error: "not-configured" });
      if (!access.machines.has(room)) return refuse(404, { error: "not-found" });
      return {
        ok: true,
        grant: {
          nonce: mintChallenge(access.secret, room, CHALLENGE_TTL_SECONDS, now),
          expiresAt: Math.floor(now / 1000) + CHALLENGE_TTL_SECONDS,
        },
      };
    },

    async activate(room, nonce, akPublic, now = Date.now()) {
      if (!access.secret || !verifier?.activate) return refuse(503, { error: "not-configured" });
      if (!access.machines.has(room)) return refuse(404, { error: "not-found" });
      if (typeof nonce !== "string") return refuse(400, { error: "bad-request" });
      const challenge = verifyChallenge(access.secret, nonce, now);
      const roomSpent = spent.get(room);
      if (roomSpent) forgetExpired(roomSpent, now);
      if (!challenge || challenge.room !== room || roomSpent?.has(challenge.id)) {
        return refuse(401, { error: "bad-nonce" });
      }
      try {
        const made = await verifier.activate({ room, nonce, akPublic, now });
        return made.ok ? { ok: true, grant: made.activation } : rejected(made.reason);
      } catch (error) {
        return failed(error);
      }
    },

    async enroll(room, body, now = Date.now()) {
      if (!verifier?.enroll) return refuse(503, { error: "not-configured" });
      if (!access.machines.has(room)) return refuse(404, { error: "not-found" });
      try {
        const enrolled = await verifier.enroll({
          room,
          certificate: body.certificate,
          intermediates: body.intermediates ?? [],
          now,
        });
        if (enrolled.ok) return { ok: true };
        return enrolled.reason === "malformed-evidence"
          ? refuse(400, { error: "bad-request" })
          : rejected(enrolled.reason);
      } catch (error) {
        return failed(error);
      }
    },

    async attest(room, nonce, evidence, now = Date.now()) {
      if (!access.secret || !verifier) return refuse(503, { error: "not-configured" });
      if (!access.machines.has(room)) return refuse(404, { error: "not-found" });
      if (typeof nonce !== "string" || evidence === undefined) return refuse(400, { error: "bad-request" });
      const roomSpent = spent.get(room) ?? new Map<string, number>();
      spent.set(room, roomSpent);
      forgetExpired(roomSpent, now);
      const challenge = verifyChallenge(access.secret, nonce, now);
      if (!challenge || challenge.room !== room || roomSpent.has(challenge.id)) {
        return refuse(401, { error: "bad-nonce" });
      }
      // Held while judged, kept only once it earns a certificate: evidence that
      // failed fails again, so a failed attempt never uses the challenge up.
      roomSpent.set(challenge.id, challenge.exp * 1000);
      const release = (refusal: Refusal) => {
        roomSpent.delete(challenge.id);
        return refusal;
      };

      let verdict: Verdict;
      try {
        verdict = await verifier.verify({ room, nonce, evidence, now });
      } catch (error) {
        // Only the kind of failure: the evidence is the machine's.
        return release(failed(error));
      }
      if (!verdict.ok) return release(rejected(verdict.reason));
      const tier = tierFor(verdict.facts, floor);
      if (!tier)
        return release(refuse(403, { error: "attestation-refused", reason: "below-hardware-floor" }));
      const boot = verdict.boot ?? null;
      try {
        await onAttested?.(room, boot, now);
      } catch (error) {
        return release(failed(error));
      }
      return {
        ok: true,
        grant: {
          hostCert: mintHostCert(access.secret, room, tier, ttlSeconds, now, boot),
          tier,
          expiresAt: Math.floor(now / 1000) + ttlSeconds,
        },
      };
    },

    credential(room, token, now = Date.now()) {
      if (verifyMachineKey(access.machines, room, token)) {
        return { kind: "machine-key", hosting: attestedOnly ? null : "unattested" };
      }
      const cert = access.secret ? verifyHostCert(access.secret, token, now) : null;
      // A machine whose key was taken out of MACHINE_KEYS hosts no more, certificate or not.
      if (cert && cert.room === room && access.machines.has(room)) {
        return {
          kind: "host-cert",
          hosting: cert.tier,
          id: cert.id,
          exp: cert.exp,
          spent: spentCerts.has(cert.id),
          iat: cert.iat,
          boot: cert.boot,
        };
      }
      return null;
    },

    spend(credential, now = Date.now()) {
      if (credential.kind !== "host-cert") return true;
      forgetExpired(spentCerts, now);
      // Checked again here: it may have expired while the request was read.
      if (credential.exp * 1000 <= now) return false;
      if (spentCerts.has(credential.id)) return false;
      spentCerts.set(credential.id, credential.exp * 1000);
      return true;
    },
  };
}

/** A machine key never has a dot; a signed token always does. Only picks which refusal to name. */
export const looksLikeHostCert = (token: unknown): boolean =>
  typeof token === "string" && token.includes(".");
