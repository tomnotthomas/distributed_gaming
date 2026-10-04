// The boot policy: which Swiff OS releases a machine may have booted, signed by
// Swiff's release key so the server only ever trusts what the release pipeline
// published. The file is JSON:
//
//   { "payload": "<base64 of the payload JSON>", "signature": "<base64>" }
//
// signed over the payload's bytes exactly as they are encoded: Ed25519, or
// SHA-256 with an RSA or ECDSA key. The payload:
//
//   {
//     "version": 1,
//     "releases": [{
//       "name": "swiff-os 2026.11.0",
//       "pcr11": ["<hex SHA-256 PCR 11 once booted>"],
//       "bootApplications": ["<hex Authenticode SHA-256>", ...],
//       "iommu": true
//     }]
//   }
//
//   pcr11             What PCR 11 holds once the release has booted to the
//                     `ready` phase: every section of its unified kernel image
//                     (kernel, initrd, command line with the dm-verity root
//                     hash, os-release) and every boot phase, as
//                     `systemd-measure calculate --phase=enter-initrd:leave-initrd:sysinit:ready`
//                     precomputes it for the release's UKI.
//   bootApplications  Every EFI application the release boots through and
//                     that the firmware measures into PCR 4: shim, the boot
//                     loader if any, the UKI. A boot that ran anything else
//                     before or between them is refused, so no other signed
//                     kernel can extend the golden values into PCR 11 itself.
//   iommu             The release refuses to finish booting (reach `ready`)
//                     without DMA remapping on, so a machine that reached its
//                     PCR 11 has an IOMMU.

import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

/** One released Swiff OS image the verifier accepts. */
export type Release = {
  name: string;
  /** Lowercase hex SHA-256 values. */
  pcr11: string[];
  bootApplications: string[];
  iommu: boolean;
};

export type BootPolicy = { releases: Release[] };

export class BootPolicyError extends Error {
  override name = "BootPolicyError";
}

const HEX_DIGEST = /^[0-9a-f]{64}$/;

/** The payload's releases, or a BootPolicyError naming what is wrong. */
function readPayload(payload: unknown): BootPolicy {
  const p = payload as { version?: unknown; releases?: unknown };
  if (!p || typeof p !== "object" || p.version !== 1) throw new BootPolicyError("not a version 1 policy");
  if (!Array.isArray(p.releases)) throw new BootPolicyError("no releases");
  const digests = (value: unknown, what: string): string[] => {
    if (!Array.isArray(value) || !value.length) throw new BootPolicyError(`${what} must be a non-empty list`);
    return value.map((digest) => {
      const hex = typeof digest === "string" ? digest.toLowerCase() : "";
      if (!HEX_DIGEST.test(hex)) throw new BootPolicyError(`${what} must be hex SHA-256 digests`);
      return hex;
    });
  };
  return {
    releases: p.releases.map((release: unknown, i) => {
      const r = (release ?? {}) as Record<string, unknown>;
      if (typeof r.name !== "string" || !r.name) throw new BootPolicyError(`release ${i} has no name`);
      if (typeof r.iommu !== "boolean") throw new BootPolicyError(`${r.name}: iommu must be true or false`);
      return {
        name: r.name,
        pcr11: digests(r.pcr11, `${r.name}: pcr11`),
        bootApplications: digests(r.bootApplications, `${r.name}: bootApplications`),
        iommu: r.iommu,
      };
    }),
  };
}

/** The algorithm `crypto.sign`/`verify` take for `key`: none for Ed25519, else SHA-256. */
const algorithmFor = (key: KeyObject) =>
  key.asymmetricKeyType === "ed25519" || key.asymmetricKeyType === "ed448" ? null : "sha256";

/**
 * The policy in `file` (the signed JSON's text), when `publicKey` (PEM) signed
 * it. Throws BootPolicyError when it is unsigned, signed by another key, or
 * malformed: the server then trusts no release at all.
 */
export function readBootPolicy(file: string, publicKey: string | KeyObject): BootPolicy {
  let signed: { payload?: unknown; signature?: unknown };
  try {
    signed = JSON.parse(file) as typeof signed;
  } catch {
    throw new BootPolicyError("not JSON");
  }
  if (typeof signed?.payload !== "string" || typeof signed.signature !== "string") {
    throw new BootPolicyError("needs a payload and a signature");
  }
  const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
  const payload = Buffer.from(signed.payload, "base64");
  const signature = Buffer.from(signed.signature, "base64");
  let good: boolean;
  try {
    good = verify(algorithmFor(key), payload, key, signature);
  } catch {
    good = false;
  }
  if (!good) throw new BootPolicyError("the signature is not the policy key's");
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new BootPolicyError("the payload is not JSON");
  }
  return readPayload(parsed);
}

/**
 * Sign `payload` with `privateKey` (PEM or a key) into a policy file's text,
 * for the release pipeline and tests. The payload is checked first, so a
 * malformed policy is never signed.
 */
export function signBootPolicy(payload: unknown, privateKey: string | KeyObject): string {
  readPayload(payload);
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = sign(algorithmFor(key), bytes, key);
  return `${JSON.stringify({ payload: bytes.toString("base64"), signature: signature.toString("base64") }, null, 2)}\n`;
}

/** The release whose PCR 11 is `pcr11` (lowercase hex), or null. */
export function releaseFor(policy: BootPolicy, pcr11: string): Release | null {
  return policy.releases.find((release) => release.pcr11.includes(pcr11)) ?? null;
}
