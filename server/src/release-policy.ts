// The boot policy payload for one Swiff OS release (boot-policy.ts says what it
// holds), computed from the release's own files, so nobody types a digest:
//
//   npm run boot-policy -- payload --name <name> --shim <shimx64.efi>
//     --boot-loader <grubx64.efi> --uki <uki.efi> --mok <secure-boot.cer>
//     --db-cert <cert> [--db-cert <cert> ...] [--iommu] [--previous <payload.json>]
//
// swiff-os/boot-policy.sh runs it on a release's image set, then has a person
// sign the payload with the release key. What each field is computed from:
//
//   pcr11       systemd-stub's measurements of the UKI, as `systemd-measure
//               calculate` makes them: for each section it knows, in its own
//               order (not the file's) and but .pcrsig, SHA-256 of the section's
//               name with its NUL, then of its contents (VirtualSize bytes);
//               then systemd-pcrphase's phases up to `ready`, each the SHA-256 of
//               its word. A UKI with a section whose measurement depends on the
//               machine (.dtbauto, .hwids, .profile, .efifw) is refused, and so
//               is one whose own .pcrsig does not sign the value computed here.
//   pcr12/13    all zero: the release takes no command line, credential, add-on
//               or extension from outside its UKI.
//   bootApplications, uki
//               the Authenticode SHA-256 of shim, the boot loader and each UKI:
//               what the firmware, and shim for what it loads, extend into PCR 4.
//               Each must be signed, and its signature must be over that same
//               digest, so a wrong digest here never reaches a policy.
//   secureBootAuthorities
//               the EV_EFI_VARIABLE_AUTHORITY extends of PCR 7, each the SHA-256
//               of a UEFI_VARIABLE_DATA: the firmware's db entry that verified
//               shim (`db`, each --db-cert under Microsoft's owner GUID, as db
//               holds them), shim's MOK that verified the boot loader and the
//               UKI (`MokListRT`, the --mok certificate under shim's GUID, as
//               the host app enrolls it). The SbatLevel shim measures there too
//               is no authority, and the verifier takes it whatever it holds
//               (eventlog.ts).
//   iommu       --iommu only for a release that will not reach `ready` without
//               DMA remapping on; a release that does not say so is false.

import { createHash } from "node:crypto";
import type { Release } from "./boot-policy.js";

export class ReleasePolicyError extends Error {
  override name = "ReleasePolicyError";
}

const sha256 = (...parts: Buffer[]) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

// --- PE/COFF -----------------------------------------------------------------

type Section = { name: string; virtualSize: number; rawSize: number; rawOffset: number };

type Pe = {
  /** File offsets of the optional header's CheckSum and of the Certificate Table's directory entry. */
  checksumAt: number;
  certificateEntryAt: number | null;
  sizeOfHeaders: number;
  sections: Section[];
  /** The Certificate Table (WIN_CERTIFICATE entries), or null when unsigned. */
  certificates: { offset: number; size: number } | null;
};

/** The parts of the PE/COFF image `pe` that Authenticode and systemd-stub read. */
function readPe(pe: Buffer): Pe {
  const fail = (what: string): never => {
    throw new ReleasePolicyError(`not a PE image: ${what}`);
  };
  if (pe.length < 0x40 || pe.readUInt16LE(0) !== 0x5a4d) fail("no MZ header");
  const at = pe.readUInt32LE(0x3c);
  if (at + 24 > pe.length || pe.readUInt32LE(at) !== 0x00004550) fail("no PE signature");
  const sectionCount = pe.readUInt16LE(at + 6);
  const optionalSize = pe.readUInt16LE(at + 20);
  const optional = at + 24;
  if (optional + optionalSize > pe.length) fail("truncated optional header");
  const magic = pe.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) fail("unknown optional header");
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const directoryCount = pe.readUInt32LE(optional + (magic === 0x20b ? 108 : 92));
  const certificateEntryAt = directoryCount > 4 ? directories + 4 * 8 : null;
  if (certificateEntryAt !== null && certificateEntryAt + 8 > optional + optionalSize)
    fail("truncated directories");
  const sizeOfHeaders = pe.readUInt32LE(optional + 60);
  const sections: Section[] = [];
  const table = optional + optionalSize;
  if (table + sectionCount * 40 > pe.length) fail("truncated section table");
  for (let i = 0; i < sectionCount; i++) {
    const s = table + i * 40;
    const name = pe
      .subarray(s, s + 8)
      .toString("latin1")
      .replace(/\0+$/, "");
    const section = {
      name,
      virtualSize: pe.readUInt32LE(s + 8),
      rawSize: pe.readUInt32LE(s + 16),
      rawOffset: pe.readUInt32LE(s + 20),
    };
    if (section.rawOffset + section.rawSize > pe.length) fail(`section ${name} runs past the end`);
    sections.push(section);
  }
  let certificates: Pe["certificates"] = null;
  if (certificateEntryAt !== null) {
    const offset = pe.readUInt32LE(certificateEntryAt);
    const size = pe.readUInt32LE(certificateEntryAt + 4);
    if (size) {
      if (offset + size > pe.length) fail("the certificate table runs past the end");
      certificates = { offset, size };
    }
  }
  return { checksumAt: optional + 64, certificateEntryAt, sizeOfHeaders, sections, certificates };
}

/**
 * The Authenticode SHA-256 of the PE image `pe`, as the firmware measures an
 * EFI application into PCR 4: the headers but the CheckSum and the Certificate
 * Table's directory entry, every section's raw data in file order, and what
 * follows them but the Certificate Table.
 */
export function authenticodeSha256(pe: Buffer): Buffer {
  const image = readPe(pe);
  const hash = createHash("sha256");
  const certEntry = image.certificateEntryAt ?? image.sizeOfHeaders;
  hash.update(pe.subarray(0, image.checksumAt));
  hash.update(pe.subarray(image.checksumAt + 4, certEntry));
  if (image.certificateEntryAt !== null) hash.update(pe.subarray(certEntry + 8, image.sizeOfHeaders));
  let hashed = image.sizeOfHeaders;
  const sections = image.sections.filter((s) => s.rawSize).sort((a, b) => a.rawOffset - b.rawOffset);
  for (const section of sections) {
    hash.update(pe.subarray(section.rawOffset, section.rawOffset + section.rawSize));
    hashed += section.rawSize;
  }
  const rest = pe.length - (image.certificates?.size ?? 0) - hashed;
  if (rest > 0) hash.update(pe.subarray(hashed, hashed + rest));
  return hash.digest();
}

/**
 * Whether the PE image `pe` is signed over `digest`: its Certificate Table holds
 * the SHA-256 as the SpcIndirectDataContent's OCTET STRING. Null when unsigned.
 */
export function signedOver(pe: Buffer, digest: Buffer): boolean | null {
  const { certificates } = readPe(pe);
  if (!certificates) return null;
  const table = pe.subarray(certificates.offset, certificates.offset + certificates.size);
  return table.includes(Buffer.concat([Buffer.from([0x04, 0x20]), digest]));
}

/** The Authenticode SHA-256 of `pe`, checked against the digest its own signature signs. */
function signedDigest(pe: Buffer, what: string): string {
  const digest = authenticodeSha256(pe);
  const signed = signedOver(pe, digest);
  if (signed === null) throw new ReleasePolicyError(`${what} is not signed`);
  if (!signed)
    throw new ReleasePolicyError(
      `${what}'s signature is not over its Authenticode SHA-256 ${digest.toString("hex")}`,
    );
  return digest.toString("hex");
}

// --- PCR 11 ------------------------------------------------------------------

/** The UKI sections systemd-stub measures, in the order it measures them (systemd's unified_sections). */
const UKI_SECTIONS = [
  ".linux",
  ".osrel",
  ".cmdline",
  ".initrd",
  ".ucode",
  ".splash",
  ".dtb",
  ".uname",
  ".sbat",
  ".pcrsig",
  ".pcrpkey",
];
/** Never measured: it holds the signature of these measurements. */
const UNMEASURED = new Set([".pcrsig"]);
/** Measured by what the machine is, or by which profile it picks: no single value. */
const MACHINE_DEPENDENT = new Set([".profile", ".dtbauto", ".hwids", ".efifw"]);
/** The boot phases systemd-pcrphase extends into PCR 11 up to `ready`. */
export const READY_PHASES = ["enter-initrd", "leave-initrd", "sysinit", "ready"];

/** PCR 11, lowercase hex, once the UKI `uki` has booted through `phases`. */
export function ukiPcr11(uki: Buffer, phases: readonly string[] = READY_PHASES): string {
  const { sections } = readPe(uki);
  for (const section of sections) {
    if (MACHINE_DEPENDENT.has(section.name))
      throw new ReleasePolicyError(`the UKI has a ${section.name} section: no single PCR 11`);
  }
  let pcr = Buffer.alloc(32);
  const extend = (data: Buffer) => {
    pcr = sha256(pcr, sha256(data));
  };
  for (const name of UKI_SECTIONS) {
    if (UNMEASURED.has(name)) continue;
    const found = sections.filter((s) => s.name === name);
    if (found.length > 1) throw new ReleasePolicyError(`the UKI has ${found.length} ${name} sections`);
    const section = found[0];
    if (!section) continue;
    // The section as loaded: its raw data, cut or zero-filled to VirtualSize.
    const contents = Buffer.alloc(section.virtualSize);
    uki.copy(
      contents,
      0,
      section.rawOffset,
      section.rawOffset + Math.min(section.rawSize, section.virtualSize),
    );
    extend(Buffer.from(`${name}\0`, "latin1"));
    extend(contents);
  }
  for (const phase of phases) extend(Buffer.from(phase, "utf8"));
  return pcr.toString("hex");
}

/**
 * Whether the UKI's own .pcrsig (systemd-measure's signed expected PCR 11
 * policies, which the build wrote with SignExpectedPcr=yes) holds a SHA-256
 * TPM2_PolicyPCR digest over PCR 11 at `pcr11` (hex). Null when it has none.
 */
export function pcrsigHolds(uki: Buffer, pcr11: string): boolean | null {
  const section = readPe(uki).sections.find((s) => s.name === ".pcrsig");
  if (!section) return null;
  const text = uki
    .subarray(section.rawOffset, section.rawOffset + Math.min(section.rawSize, section.virtualSize))
    .toString("utf8")
    .replace(/\0+$/, "");
  let entries: unknown;
  try {
    entries = (JSON.parse(text) as { sha256?: unknown }).sha256;
  } catch {
    throw new ReleasePolicyError("the UKI's .pcrsig is not JSON");
  }
  if (!Array.isArray(entries)) return false;
  // TPM2_PolicyPCR from an empty policy: TPM_CC_PolicyPCR, then one SHA-256
  // selection of PCR 11, then the SHA-256 of the PCR's value.
  const selection = Buffer.from([0, 0, 0, 1, 0x00, 0x0b, 3, 0x00, 0x08, 0x00]);
  const policy = sha256(
    Buffer.alloc(32),
    Buffer.from([0, 0, 0x01, 0x7f]),
    selection,
    sha256(Buffer.from(pcr11, "hex")),
  );
  return entries.some((entry) => (entry as { pol?: unknown })?.pol === policy.toString("hex"));
}

// --- PCR 7 -------------------------------------------------------------------

/** A GUID's bytes as UEFI lays them out: the first three fields little-endian. */
export function guidBytes(guid: string): Buffer {
  const hex = guid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new ReleasePolicyError(`not a GUID: ${guid}`);
  const b = Buffer.from(hex, "hex");
  return Buffer.concat([
    b.subarray(0, 4).reverse(),
    b.subarray(4, 6).reverse(),
    b.subarray(6, 8).reverse(),
    b.subarray(8),
  ]);
}

export const EFI_IMAGE_SECURITY_DATABASE_GUID = "d719b2cb-3d3a-4596-a3bc-dad00e67656f";
export const SHIM_LOCK_GUID = "605dab50-e046-4300-abb6-3dd810dd8b23";
/** The SignatureOwner of Microsoft's certificates in db. */
export const MICROSOFT_OWNER_GUID = "77fa9abd-0359-4d32-bd60-28f4e78f784b";

/** The digest of an EV_EFI_VARIABLE_AUTHORITY extend: SHA-256 of its UEFI_VARIABLE_DATA. */
export function variableAuthority(guid: string, name: string, value: Buffer): string {
  const length = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  return sha256(
    guidBytes(guid),
    length(name.length),
    length(value.length),
    Buffer.from(name, "utf16le"),
    value,
  ).toString("hex");
}

/** An EFI_SIGNATURE_DATA: the owner's GUID, then the certificate. */
const signatureData = (owner: string, der: Buffer) => Buffer.concat([guidBytes(owner), der]);

// --- The release ---------------------------------------------------------------

export type ReleaseFiles = {
  name: string;
  /** shim, as the firmware starts it. */
  shim: Buffer;
  /** The boot loader shim starts (systemd-boot as grubx64.efi). */
  bootLoader: Buffer;
  /** The release's UKIs. */
  ukis: Buffer[];
  /** The certificate (DER) shim verifies the boot loader and the UKI with, enrolled as a MOK. */
  mok: Buffer;
  /** The db certificates (DER) the firmware may verify shim with. */
  dbCerts: Buffer[];
  /** The release will not reach `ready` without DMA remapping. */
  iommu: boolean;
};

const unique = (values: string[]) => [...new Set(values)];
const ZERO = "0".repeat(64);

/** The policy's entry for the release in `files`. */
export function releaseEntry(files: ReleaseFiles): Release {
  if (!files.name) throw new ReleasePolicyError("the release has no name");
  if (!files.ukis.length) throw new ReleasePolicyError("the release has no UKI");
  if (!files.dbCerts.length) throw new ReleasePolicyError("no db certificate verifies shim");
  const uki = files.ukis.map((pe, i) => signedDigest(pe, `UKI ${i + 1}`));
  const pcr11 = files.ukis.map((pe, i) => {
    const value = ukiPcr11(pe);
    if (pcrsigHolds(pe, value) === false) {
      throw new ReleasePolicyError(`UKI ${i + 1}'s .pcrsig does not sign PCR 11 ${value} at ready`);
    }
    return value;
  });
  return {
    name: files.name,
    pcr11: unique(pcr11),
    pcr12: [ZERO],
    pcr13: [ZERO],
    bootApplications: unique([
      signedDigest(files.shim, "shim"),
      signedDigest(files.bootLoader, "the boot loader"),
      ...uki,
    ]),
    uki: unique(uki),
    secureBootAuthorities: unique([
      ...files.dbCerts.map((der) =>
        variableAuthority(EFI_IMAGE_SECURITY_DATABASE_GUID, "db", signatureData(MICROSOFT_OWNER_GUID, der)),
      ),
      variableAuthority(SHIM_LOCK_GUID, "MokListRT", signatureData(SHIM_LOCK_GUID, files.mok)),
    ]),
    iommu: files.iommu,
  };
}

/**
 * A version 1 policy payload: `release` and every release of `previous` (a
 * payload) but one of the same name, which it replaces. Hosts still running an
 * earlier release keep attesting while it is listed.
 */
export function policyPayload(release: Release, previous?: unknown): { version: 1; releases: Release[] } {
  const earlier = previous === undefined ? [] : ((previous as { releases?: unknown }).releases ?? null);
  if (!Array.isArray(earlier)) throw new ReleasePolicyError("the previous payload has no releases");
  return {
    version: 1,
    releases: [...(earlier as Release[]).filter((r) => r?.name !== release.name), release],
  };
}
