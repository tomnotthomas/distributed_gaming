// Endorsement key certificates: the TPM manufacturer's statement that an EK
// lives in a genuine TPM of theirs. A software TPM has none that chains to a
// vendor, so it cannot pass.
//
// The trust store is a directory with two subdirectories, by what kind of TPM
// each vendor's roots certify:
//
//   firmware/   in the CPU's firmware: Intel PTT, AMD fTPM, Microsoft Pluton, ...
//   discrete/   a chip on the board: Infineon, STMicro, Nuvoton, ...
//
// Each holds the vendor's root certificates and any intermediates, as PEM (one
// or more per file) or DER. A self-signed certificate is a root; any other is an
// intermediate, usable by an EK certificate of either kind, which the root at
// the end of its chain decides. Microsoft's TrustedTpm.cab is one source of
// them; see docs/system-design/session-keys.md.

import { X509Certificate, createHash, type KeyObject } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type TpmKind = "firmware" | "discrete";

export type TrustStore = {
  roots: { cert: X509Certificate; kind: TpmKind }[];
  intermediates: X509Certificate[];
};

/** A trust store of `certs`: each the PEM or DER of a root or an intermediate. */
export function trustStore(certs: { der: Buffer | string; kind: TpmKind }[]): TrustStore {
  const store: TrustStore = { roots: [], intermediates: [] };
  for (const { der, kind } of certs) {
    for (const cert of readCertificates(der)) {
      if (cert.checkIssued(cert) && cert.verify(cert.publicKey)) store.roots.push({ cert, kind });
      else store.intermediates.push(cert);
    }
  }
  return store;
}

/** The trust store in `dir`: its `firmware/` and `discrete/` subdirectories. A missing one is empty. */
export function loadTrustStore(dir: string): TrustStore {
  const certs: { der: Buffer; kind: TpmKind }[] = [];
  for (const kind of ["firmware", "discrete"] as const) {
    let files: string[];
    try {
      files = readdirSync(join(dir, kind));
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      if (!/\.(pem|crt|cer|der)$/i.test(file)) continue;
      certs.push({ der: readFileSync(join(dir, kind, file)), kind });
    }
  }
  return trustStore(certs);
}

/** Every certificate in `data`: PEM, one or more, or a single DER. */
function readCertificates(data: Buffer | string): X509Certificate[] {
  const text = typeof data === "string" ? data : data.toString("latin1");
  const pems = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (pems) return pems.map((pem) => new X509Certificate(pem));
  return [new X509Certificate(typeof data === "string" ? Buffer.from(data, "base64") : data)];
}

/** An EK certificate that chains to a vendor root: what kind of TPM, and its key. */
export type TrustedEk = {
  kind: TpmKind;
  key: KeyObject;
  /** SHA-256 of the EK certificate's DER: which EK this is. */
  fingerprint: Buffer;
};

/** How deep a chain may go below its root: vendors use one or two intermediates. */
const MAX_INTERMEDIATES = 4;

/**
 * The EK certificate `der` checked against `store` at `now` (Unix ms): it must
 * chain, through the store's intermediates and `extra` (the ones the machine
 * supplied, trusted for nothing on their own), to a vendor root, with every
 * signature good and every certificate in date. Null when it does not.
 */
export function verifyEkCertificate(
  store: TrustStore,
  der: Buffer,
  extra: Buffer[] = [],
  now = Date.now(),
): TrustedEk | null {
  let leaf: X509Certificate;
  let pool: X509Certificate[];
  try {
    leaf = new X509Certificate(der);
    pool = [...store.intermediates, ...extra.map((cert) => new X509Certificate(cert))];
  } catch {
    return null;
  }
  if (leaf.ca || !inDate(leaf, now)) return null;
  const kind = chainKind(store, leaf, pool, now, 0);
  if (!kind) return null;
  let key: KeyObject;
  try {
    key = leaf.publicKey;
  } catch {
    return null;
  }
  return { kind, key, fingerprint: createHash("sha256").update(leaf.raw).digest() };
}

function chainKind(
  store: TrustStore,
  cert: X509Certificate,
  pool: X509Certificate[],
  now: number,
  depth: number,
): TpmKind | null {
  const issued = (issuer: X509Certificate) => {
    try {
      return cert.checkIssued(issuer) && cert.verify(issuer.publicKey) && inDate(issuer, now);
    } catch {
      return false;
    }
  };
  for (const root of store.roots) if (issued(root.cert)) return root.kind;
  if (depth >= MAX_INTERMEDIATES) return null;
  for (const issuer of pool) {
    if (issuer === cert || !issuer.ca || !issued(issuer)) continue;
    const kind = chainKind(store, issuer, pool, now, depth + 1);
    if (kind) return kind;
  }
  return null;
}

function inDate(cert: X509Certificate, now: number): boolean {
  return Date.parse(cert.validFrom) <= now && now <= Date.parse(cert.validTo);
}
