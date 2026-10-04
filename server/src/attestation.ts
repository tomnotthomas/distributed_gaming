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
//   POST /api/machines/:id/attest-challenge ───► { nonce, expiresAt }       one minute, one use
//   TPM quote over SHA-256(nonce), event log,
//   EK certificate and AK proof
//   POST /api/machines/:id/attest            ───► AttestationVerifier judges the evidence,
//     { nonce, evidence }                         HARDWARE_FLOOR picks the tier
//                                            ◄─── { hostCert, tier, expiresAt }   ten minutes
//
// The verifier sits behind an interface. The only one built so far is
// `insecure-dev`, which believes whatever the evidence claims: for VMs and tests,
// never for a server renters reach. The real one (Keylime, or Swiff's own:
// EK chain, AK activation, event-log replay, golden PCR 11) is a later stage.
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
import type { AttestChallengeGrant, AttestRefusal, HostCertGrant } from "./protocol.js";

/**
 * How long a host certificate admits anything. It is checked when a socket
 * registers and when a host session starts, not while a socket stays open, so
 * a machine attests again at least once per renter: before every session start.
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

/** A verifier's judgement: what it verified about the machine, or that it could not. */
export type Verdict = { ok: true; facts: PlatformFacts } | { ok: false };

/** Judges a machine's attestation evidence. Keylime, Swiff's own, or the insecure dev stub. */
export type AttestationVerifier = {
  /** Named in the startup log. */
  readonly name: string;
  /**
   * Whether `evidence` proves machine `room` booted an untouched Swiff OS just
   * now, and what it proves about its hardware. `nonce` is the challenge this
   * server issued; a real verifier requires the quote's qualifying data to be
   * its SHA-256. Rejects only when the verifier itself fails.
   */
  verify(input: { room: string; nonce: string; evidence: unknown }): Promise<Verdict>;
};

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
 * The development stub: evidence `{ facts: PlatformFacts }` passes, and its
 * facts are believed. It proves nothing — anyone can claim any facts — so it
 * exists only to drive the hosting gate in VMs and tests until a real verifier
 * exists. The server warns at startup whenever it is configured.
 */
export const insecureDevVerifier: AttestationVerifier = {
  name: "insecure-dev",
  async verify({ evidence }) {
    const facts = platformFacts((evidence as { facts?: unknown } | null)?.facts);
    return facts ? { ok: true, facts } : { ok: false };
  },
};

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
 * ATTESTATION_VERIFIER (unset, or `insecure-dev`). An unknown policy is read as
 * `required` and an unknown verifier as none: a typo never opens hosting up.
 */
export function attestationFromEnv(env: NodeJS.ProcessEnv): AttestationConfig {
  const warnings: string[] = [];
  const policy = env.HOSTING_ATTESTATION?.trim().toLowerCase() || "optional";
  if (policy !== "optional" && policy !== "required") {
    warnings.push(`HOSTING_ATTESTATION is not "optional" or "required" — hosting requires attestation`);
  }
  const attestedOnly = policy !== "optional";

  const name = env.ATTESTATION_VERIFIER?.trim() ?? "";
  let verifier: AttestationVerifier | null = null;
  if (name === insecureDevVerifier.name) {
    verifier = insecureDevVerifier;
    warnings.push(
      "ATTESTATION_VERIFIER=insecure-dev believes any evidence — never use it where renters play",
    );
  } else if (name) {
    warnings.push(`ATTESTATION_VERIFIER "${name}" is unknown — no machine can attest`);
  }
  if (attestedOnly && !verifier)
    warnings.push("hosting requires attestation and no verifier is set — no PC can host");
  if (!attestedOnly)
    warnings.push("HOSTING_ATTESTATION=optional — machine keys host unattested (development only)");
  return { attestedOnly, verifier, warnings };
}

/** A credential a gaming PC presented, and whether it may host. */
export type Credential =
  /** The control credential. `hosting` is null when hosting requires attestation. */
  | { kind: "machine-key"; hosting: "unattested" | null }
  /** The hosting credential, at the tier attestation found. */
  | { kind: "host-cert"; hosting: HostCert["tier"] };

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
   * Judge `evidence` quoted over `nonce` by machine `room`, and mint a host
   * certificate when it passes and the machine meets the hardware floor. The
   * challenge is spent whatever the outcome. Rejects when the verifier fails.
   */
  attest(
    room: string,
    nonce: unknown,
    evidence: unknown,
    now?: number,
  ): Promise<{ ok: true; grant: HostCertGrant } | Refusal>;
  /** What `token` is for machine `room`: its machine key, a host certificate for it, or null. */
  credential(room: string, token: unknown, now?: number): Credential | null;
};

/**
 * Attestation for the machines in `access`, signed with its secret, judged by
 * `verifier` against `floor`. Spent challenges are kept in memory until they
 * expire: a restart forgets them, and they had at most a minute left.
 */
export function createAttestation({
  access,
  verifier = null,
  attestedOnly = false,
  floor = HARDWARE_FLOOR,
  ttlSeconds = HOST_CERT_TTL_SECONDS,
}: {
  access: Access;
  verifier?: AttestationVerifier | null;
  attestedOnly?: boolean;
  floor?: HardwareFloor;
  ttlSeconds?: number;
}): Attestation {
  /** Challenge id → when it expires (Unix ms). */
  const spent = new Map<string, number>();
  const refuse = (status: number, body: AttestRefusal): Refusal => ({ ok: false, status, body });

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

    async attest(room, nonce, evidence, now = Date.now()) {
      if (!access.secret || !verifier) return refuse(503, { error: "not-configured" });
      if (!access.machines.has(room)) return refuse(404, { error: "not-found" });
      if (typeof nonce !== "string" || evidence === undefined) return refuse(400, { error: "bad-request" });
      for (const [id, until] of spent) if (until <= now) spent.delete(id);
      const challenge = verifyChallenge(access.secret, nonce, now);
      if (!challenge || challenge.room !== room || spent.has(challenge.id)) {
        return refuse(401, { error: "bad-nonce" });
      }
      // Spent before the verifier runs: one challenge, one attempt, however it ends.
      spent.set(challenge.id, challenge.exp * 1000);

      const verdict = await verifier.verify({ room, nonce, evidence });
      if (!verdict.ok) return refuse(403, { error: "attestation-refused", reason: "evidence-rejected" });
      const tier = tierFor(verdict.facts, floor);
      if (!tier) return refuse(403, { error: "attestation-refused", reason: "below-hardware-floor" });
      return {
        ok: true,
        grant: {
          hostCert: mintHostCert(access.secret, room, tier, ttlSeconds, now),
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
      if (cert && cert.room === room && access.machines.has(room))
        return { kind: "host-cert", hosting: cert.tier };
      return null;
    },
  };
}

/** A machine key never has a dot; a signed token always does. Only picks which refusal to name. */
export const looksLikeHostCert = (token: unknown): boolean =>
  typeof token === "string" && token.includes(".");
