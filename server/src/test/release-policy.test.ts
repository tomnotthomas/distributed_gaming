// The boot policy payload generator (release-policy.ts): the digests it
// computes from a release's files, checked against what the verifier is fed.
// The PE images here are built by the test; the formulas were also checked
// against a real release's shim, systemd-boot and UKI and a real PC's TCG log
// (the values in "PCR 7 authorities").

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readBootPolicy, signBootPolicy } from "../boot-policy.js";
import {
  EFI_IMAGE_SECURITY_DATABASE_GUID,
  MICROSOFT_OWNER_GUID,
  ReleasePolicyError,
  SHIM_LOCK_GUID,
  authenticodeSha256,
  guidBytes,
  pcrsigHolds,
  policyPayload,
  releaseEntry,
  signedOver,
  ukiPcr11,
  variableAuthority,
} from "../release-policy.js";
import { memoryStore, tpmVerifier } from "../tpm-verifier.js";
import { trustStore } from "../ek.js";
import fixture from "./fixtures/tpm-attestation.json" with { type: "json" };

const sha256 = (...parts: Buffer[]) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

const FILE_ALIGNMENT = 0x200;
const align = (n: number) => Math.ceil(n / FILE_ALIGNMENT) * FILE_ALIGNMENT;

type PeLayout = {
  image: Buffer;
  checksumAt: number;
  certEntryAt: number;
  sizeOfHeaders: number;
  certAt: number | null;
};

/**
 * A PE32+ image with `sections` (raw data padded to the file alignment, in this
 * order in the file), `trailer` after them, and a Certificate Table holding
 * `signature` when given.
 */
function pe(
  sections: { name: string; data: Buffer }[],
  { trailer = Buffer.alloc(0), signature = null as Buffer | null } = {},
): PeLayout {
  const optionalSize = 240;
  const headerEnd = 0x40 + 4 + 20 + optionalSize + 40 * sections.length;
  const sizeOfHeaders = align(headerEnd);
  const header = Buffer.alloc(sizeOfHeaders);
  header.write("MZ", 0, "latin1");
  header.writeUInt32LE(0x40, 0x3c);
  header.writeUInt32LE(0x00004550, 0x40);
  const coff = 0x44;
  header.writeUInt16LE(0x8664, coff);
  header.writeUInt16LE(sections.length, coff + 2);
  header.writeUInt16LE(optionalSize, coff + 16);
  const optional = coff + 20;
  header.writeUInt16LE(0x20b, optional);
  header.writeUInt32LE(sizeOfHeaders, optional + 60);
  header.writeUInt32LE(0xdeadbeef, optional + 64); // CheckSum: never hashed
  header.writeUInt32LE(16, optional + 108);
  const certEntryAt = optional + 112 + 4 * 8;
  let offset = sizeOfHeaders;
  const raws: Buffer[] = [];
  sections.forEach(({ name, data }, i) => {
    const s = optional + optionalSize + i * 40;
    header.write(name, s, "latin1");
    header.writeUInt32LE(data.length, s + 8); // VirtualSize
    header.writeUInt32LE(0x1000 * (i + 1), s + 12);
    const raw = Buffer.alloc(align(data.length));
    data.copy(raw);
    header.writeUInt32LE(raw.length, s + 16);
    header.writeUInt32LE(offset, s + 20);
    raws.push(raw);
    offset += raw.length;
  });
  const body = Buffer.concat([...raws, trailer]);
  let certAt: number | null = null;
  let table = Buffer.alloc(0);
  if (signature) {
    certAt = align(sizeOfHeaders + body.length);
    const entry = Buffer.alloc(8 + signature.length);
    entry.writeUInt32LE(entry.length, 0);
    entry.writeUInt16LE(0x0200, 4);
    entry.writeUInt16LE(0x0002, 6);
    signature.copy(entry, 8);
    table = Buffer.concat([Buffer.alloc(certAt - sizeOfHeaders - body.length), entry]);
    header.writeUInt32LE(certAt, certEntryAt);
    header.writeUInt32LE(entry.length, certEntryAt + 4);
  }
  return {
    image: Buffer.concat([header, body, table]),
    checksumAt: optional + 64,
    certEntryAt,
    sizeOfHeaders,
    certAt,
  };
}

/** `layout`'s image signed over its own Authenticode digest, as sbsign signs (an OCTET STRING of the SHA-256 in the PKCS#7). */
function signed(sections: { name: string; data: Buffer }[], trailer = Buffer.alloc(0)): Buffer {
  const unsigned = pe(sections, { trailer, signature: Buffer.alloc(40) }).image;
  const digest = authenticodeSha256(unsigned);
  return pe(sections, {
    trailer,
    signature: Buffer.concat([Buffer.from("pkcs7:"), Buffer.from([0x04, 0x20]), digest]),
  }).image;
}

const section = (name: string, text: string) => ({ name, data: Buffer.from(text, "latin1") });

describe("Authenticode", () => {
  it("hashes the headers but the CheckSum and the certificate entry, the sections in file order and the rest but the signature", () => {
    const sections = [section(".text", "code"), section(".data", "data")];
    const trailer = Buffer.from("appended");
    const layout = pe(sections, { trailer, signature: Buffer.from("signature") });
    const { image, checksumAt, certEntryAt, sizeOfHeaders, certAt } = layout;
    const expected = sha256(
      image.subarray(0, checksumAt),
      image.subarray(checksumAt + 4, certEntryAt),
      image.subarray(certEntryAt + 8, sizeOfHeaders),
      image.subarray(sizeOfHeaders, certAt!),
    );
    assert.equal(authenticodeSha256(image).toString("hex"), expected.toString("hex"));
    // The CheckSum and the signature change nothing.
    const other = Buffer.from(image);
    other.writeUInt32LE(1, checksumAt);
    other.writeUInt8(other.readUInt8(other.length - 1) ^ 0xff, other.length - 1);
    assert.equal(authenticodeSha256(other).toString("hex"), expected.toString("hex"));
    // Code does.
    const patched = Buffer.from(image);
    patched.writeUInt8(patched.readUInt8(sizeOfHeaders) ^ 0xff, sizeOfHeaders);
    assert.notEqual(authenticodeSha256(patched).toString("hex"), expected.toString("hex"));
  });

  it("knows whether an image is signed over its digest", () => {
    const sections = [section(".text", "code")];
    const image = signed(sections);
    assert.equal(signedOver(image, authenticodeSha256(image)), true);
    assert.equal(
      signedOver(pe(sections, { signature: Buffer.from("other") }).image, authenticodeSha256(image)),
      false,
    );
    assert.equal(signedOver(pe(sections).image, authenticodeSha256(image)), null);
  });

  it("refuses what is not a PE image", () => {
    assert.throws(() => authenticodeSha256(Buffer.from("not a PE image")), ReleasePolicyError);
    const truncated = pe([section(".text", "code")]).image.subarray(0, 0x100);
    assert.throws(() => authenticodeSha256(truncated), ReleasePolicyError);
  });
});

/** A UKI with the fixture boot's sections: systemd-stub measured `${uki}${section}` for each. */
const ukiSections = (uki: string) => [
  // Out of systemd-stub's order on purpose, with sections it never measures.
  section(".text", "stub code"),
  section(".initrd", `${uki}.initrd`),
  section(".uname", `${uki}.uname`),
  section(".linux", `${uki}.linux`),
  section(".cmdline", `${uki}.cmdline`),
  section(".osrel", `${uki}.osrel`),
  section(".reloc", "relocations"),
];

describe("PCR 11", () => {
  it("is what systemd-stub and systemd-pcrphase extend: the fixture TPM's", () => {
    assert.equal(ukiPcr11(pe(ukiSections("swiff-os-1")).image), fixture.release.pcr11);
    assert.equal(ukiPcr11(pe(ukiSections("tampered")).image), fixture.tamperedPcr11);
  });

  it("matches systemd-measure for a UKI with every section it measures", () => {
    // `systemd-measure calculate --linux=… --osrel=… --cmdline=… --initrd=… --uname=… --sbat=…
    //  --pcrpkey=… --bank=sha256 --phase=enter-initrd:leave-initrd:sysinit:ready` (systemd 255)
    // with each file holding the section's text below.
    const uki = pe([
      section(".pcrpkey", "pcrpkey"),
      section(".sbat", "sbat"),
      section(".pcrsig", "{}"),
      section(".linux", "linux"),
      section(".osrel", "osrel"),
      section(".cmdline", "cmdline"),
      section(".initrd", "initrd"),
      section(".uname", "uname"),
    ]).image;
    assert.equal(ukiPcr11(uki), "68e287b94b30ed915281094bd86aa925d2d74b8ff9bcc52aaca026d91d860770");
  });

  it("refuses a UKI whose measurements depend on the machine, or that has a section twice", () => {
    assert.throws(() => ukiPcr11(pe([...ukiSections("a"), section(".profile", "ID=1")]).image), /\.profile/);
    assert.throws(() => ukiPcr11(pe([...ukiSections("a"), section(".linux", "again")]).image), /2 \.linux/);
  });

  it("knows whether the UKI's own .pcrsig signed it", () => {
    const pcr11 = ukiPcr11(pe(ukiSections("swiff-os-1")).image);
    const policy = sha256(
      Buffer.alloc(32),
      Buffer.from([0, 0, 0x01, 0x7f]),
      Buffer.from([0, 0, 0, 1, 0x00, 0x0b, 3, 0x00, 0x08, 0x00]),
      sha256(Buffer.from(pcr11, "hex")),
    ).toString("hex");
    const withSig = (pol: string) =>
      pe([
        ...ukiSections("swiff-os-1"),
        section(".pcrsig", JSON.stringify({ sha256: [{ pcrs: [11], pol }] })),
      ]).image;
    assert.equal(pcrsigHolds(withSig(policy), pcr11), true);
    assert.equal(pcrsigHolds(withSig("00".repeat(32)), pcr11), false);
    assert.equal(pcrsigHolds(pe(ukiSections("swiff-os-1")).image, pcr11), null);
  });
});

describe("PCR 7 authorities", () => {
  it("are the SHA-256 of the UEFI_VARIABLE_DATA, as a real PC's firmware and shim measured them", () => {
    // From a real PC's TCG log (C:\Windows\Logs\MeasuredBoot), a boot through Ubuntu's shim 15.8:
    // the firmware's db entry that verified shim, and the SbatLevel shim measured.
    const uefiCa2011 = readFileSync(
      new URL("../../../swiff-os/secure-boot/microsoft-uefi-ca-2011.der", import.meta.url),
    );
    assert.equal(
      variableAuthority(
        EFI_IMAGE_SECURITY_DATABASE_GUID,
        "db",
        Buffer.concat([guidBytes(MICROSOFT_OWNER_GUID), uefiCa2011]),
      ),
      "4d4a8e2c74133bbdc01a16eaf2dbb5d575afeb36f5d8dfcf609ae043909e2ee9",
    );
    const level = "sbat,1,2025051000\nshim,4\ngrub,5\ngrub.debian,4\ngrub.peimage,2\ngrub.proxmox,2";
    assert.equal(
      variableAuthority(SHIM_LOCK_GUID, "SbatLevel", Buffer.from(level, "latin1")),
      "1aa7536ef59b5344a3703b5819facce1a68b8ec028fc3f5fce3dc0fcc317ea9b",
    );
  });

  it("lays out GUIDs as UEFI does", () => {
    assert.equal(guidBytes(SHIM_LOCK_GUID).toString("hex"), "50ab5d6046e00043abb63dd810dd8b23");
    assert.throws(() => guidBytes("not-a-guid"), ReleasePolicyError);
  });
});

describe("a release's payload", () => {
  const mok = Buffer.from("the release's Secure Boot certificate");
  const db = Buffer.from("Microsoft UEFI CA");
  const files = {
    name: "swiffos 1.0.0",
    shim: signed([section(".text", "shim")]),
    bootLoader: signed([section(".text", "systemd-boot")]),
    ukis: [signed(ukiSections("swiff-os-1"))],
    mok,
    dbCerts: [db],
    iommu: false,
  };

  it("lists the release's PCRs, boot chain and authorities, and claims no IOMMU unless told", () => {
    const release = releaseEntry(files);
    const app = (image: Buffer) => authenticodeSha256(image).toString("hex");
    assert.deepEqual(release, {
      name: "swiffos 1.0.0",
      pcr11: [fixture.release.pcr11],
      pcr12: ["0".repeat(64)],
      pcr13: ["0".repeat(64)],
      bootApplications: [app(files.shim), app(files.bootLoader), app(files.ukis[0]!)],
      uki: [app(files.ukis[0]!)],
      secureBootAuthorities: [
        variableAuthority(
          EFI_IMAGE_SECURITY_DATABASE_GUID,
          "db",
          Buffer.concat([guidBytes(MICROSOFT_OWNER_GUID), db]),
        ),
        variableAuthority(SHIM_LOCK_GUID, "MokListRT", Buffer.concat([guidBytes(SHIM_LOCK_GUID), mok])),
      ],
      iommu: false,
    });
    assert.equal(releaseEntry({ ...files, iommu: true }).iommu, true);
  });

  it("refuses an unsigned binary, one signed over other bytes, and a UKI its .pcrsig does not sign", () => {
    assert.throws(
      () => releaseEntry({ ...files, shim: pe([section(".text", "shim")]).image }),
      /shim is not signed/,
    );
    const resigned = pe([section(".text", "systemd-boot")], {
      signature: Buffer.concat([Buffer.from([0x04, 0x20]), Buffer.alloc(32)]),
    }).image;
    assert.throws(
      () => releaseEntry({ ...files, bootLoader: resigned }),
      /boot loader's signature is not over/,
    );
    const badSig = signed([
      ...ukiSections("swiff-os-1"),
      section(".pcrsig", JSON.stringify({ sha256: [{ pol: "00" }] })),
    ]);
    assert.throws(() => releaseEntry({ ...files, ukis: [badSig] }), /\.pcrsig does not sign/);
    assert.throws(() => releaseEntry({ ...files, ukis: [] }), /no UKI/);
    assert.throws(() => releaseEntry({ ...files, dbCerts: [] }), /no db certificate/);
  });

  it("keeps the previous payload's releases, replacing one of the same name", () => {
    const release = releaseEntry(files);
    const older = { ...release, name: "swiffos 0.9.0" };
    const payload = policyPayload(release, {
      version: 1,
      releases: [older, { ...release, pcr11: ["ab".repeat(32)] }],
    });
    assert.deepEqual(
      payload.releases.map((r) => [r.name, r.pcr11]),
      [
        ["swiffos 0.9.0", release.pcr11],
        ["swiffos 1.0.0", release.pcr11],
      ],
    );
    assert.throws(() => policyPayload(release, { version: 1 }), /no releases/);
  });

  it("signs into a policy the server reads, and the verifier refuses a boot of a tampered UKI", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const encrypted = privateKey.export({
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: "release",
    });
    const { createPrivateKey } = await import("node:crypto");
    const release = releaseEntry(files);
    // The fixture TPM's boot chain and authorities are synthetic digests; PCR 11 is the generator's.
    const policy = readBootPolicy(
      signBootPolicy(
        policyPayload({
          ...release,
          bootApplications: fixture.release.bootApplications,
          uki: fixture.release.uki,
          secureBootAuthorities: fixture.release.secureBootAuthorities,
        }),
        createPrivateKey({ key: encrypted, passphrase: "release" }),
      ),
      publicKey,
    );
    const verifier = tpmVerifier({
      store: memoryStore(),
      roots: trustStore([
        { der: fixture.vendorRoot, kind: "firmware" },
        { der: fixture.vendorIntermediate, kind: "firmware" },
      ]),
      policy,
      activationKey: createHash("sha256").update(fixture.activationKeyLabel).digest(),
      securityLog: () => {},
    });
    const machine = fixture.machines["pc-rsa"];
    assert.deepEqual(
      await verifier.enroll({ room: "pc-rsa", certificate: machine.ekCertificate, now: fixture.now }),
      { ok: true },
    );
    const quotes = machine.quotes as Record<string, { nonce: string; evidence: unknown }>;
    const judge = (label: string) =>
      verifier.verify({
        room: "pc-rsa",
        nonce: quotes[label]!.nonce,
        evidence: quotes[label]!.evidence,
        now: fixture.now,
      });
    assert.equal((await judge("first")).ok, true);
    assert.deepEqual(await judge("tampered-uki"), { ok: false, reason: "unknown-boot-image" });
  });
});
