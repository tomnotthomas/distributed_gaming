// The TPM vendor trust store checked in at server/tpm-roots (from
// server/scripts/tpm-roots.mjs): what is in it is what its manifest lists, and
// every certificate in it is a real vendor's, chaining to a root kept there.
//
// A real EK certificate identifies one PC, so none is checked in. To check one
// against the store, run with TPM_REAL_EK_CERT set to its DER or PEM file (on
// Windows, the EK certificate cached under HKLM\SYSTEM\CurrentControlSet\
// Services\TPM\WMI\Endorsement\EKCertStore\Certificates, or
// `Get-TpmEndorsementKeyInfo` as an administrator; on Linux, tpm2_getekcertificate).

import assert from "node:assert/strict";
import { X509Certificate, createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TPM_ROOTS } from "../attestation.js";
import { loadTrustStore, verifyEkCertificate } from "../ek.js";
import { ekPublicFor } from "../tpm.js";

type Manifest = {
  source: string;
  cabSha256: string;
  vendors: {
    vendor: string;
    kind: "firmware" | "discrete";
    file: string;
    certificates: { role: "root" | "intermediate"; subject: string; sha256: string }[];
  }[];
  left: { file: string; why: string }[];
};

const manifest = JSON.parse(readFileSync(join(TPM_ROOTS, "manifest.json"), "utf8")) as Manifest;
const sha256 = (cert: X509Certificate) => createHash("sha256").update(cert.raw).digest("hex");
const pemsIn = (file: string) =>
  (
    readFileSync(join(TPM_ROOTS, file), "utf8").match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    ) ?? []
  ).map((pem) => new X509Certificate(pem));
const issuedBy = (cert: X509Certificate, issuer: X509Certificate) => {
  try {
    return cert.checkIssued(issuer) && cert.verify(issuer.publicKey);
  } catch {
    return false;
  }
};

describe("the TPM vendor trust store", () => {
  it("holds exactly the certificates its manifest lists, by SHA-256, in each vendor's file", () => {
    const files = ["firmware", "discrete"].flatMap((kind) =>
      readdirSync(join(TPM_ROOTS, kind)).map((file) => `${kind}/${file}`),
    );
    assert.deepEqual(files.sort(), manifest.vendors.map((v) => v.file).sort());
    for (const vendor of manifest.vendors) {
      assert.ok(vendor.file.startsWith(`${vendor.kind}/`), `${vendor.vendor} is in its kind's folder`);
      assert.deepEqual(
        pemsIn(vendor.file).map(sha256),
        vendor.certificates.map((c) => c.sha256),
        vendor.vendor,
      );
    }
  });

  it("has the roots of every TPM a gaming PC carries: firmware TPMs and discrete chips", () => {
    const kinds = Object.fromEntries(manifest.vendors.map((v) => [v.vendor, v.kind]));
    assert.deepEqual(kinds, {
      AMD: "firmware",
      Intel: "firmware",
      Infineon: "discrete",
      STMicro: "discrete",
      Nuvoton: "discrete",
      NationZ: "discrete",
      Atmel: "discrete",
    });
    for (const vendor of manifest.vendors) {
      assert.ok(
        vendor.certificates.some((c) => c.role === "root"),
        `${vendor.vendor} has a root`,
      );
    }
    const subjects = manifest.vendors.flatMap((v) => v.certificates.map((c) => c.subject));
    for (const root of [
      "CN=AMDTPM", // AMD fTPM
      "CN=Microsoft Pluton Root CA 2021", // AMD's Pluton
      "OU=TPM EK root cert signing", // Intel PTT
      "CN=Infineon OPTIGA(TM) RSA Root CA",
      "CN=GlobalSign Trusted Platform Module Root CA", // STMicro
      "CN=Nuvoton TPM Root CA 2111",
    ]) {
      assert.ok(
        subjects.some((subject) => subject.includes(root)),
        root,
      );
    }
  });

  it("never trusts a CA that issues Windows' AIK certificates, not EK certificates", () => {
    const subjects = manifest.vendors.flatMap((v) => v.certificates.map((c) => c.subject));
    assert.ok(!subjects.some((subject) => subject.includes("Microsoft TPM Root Certificate Authority 2014")));
    assert.ok(!manifest.vendors.some((v) => v.vendor === "Microsoft" || v.vendor === "QC"));
  });

  it("chains every intermediate to a root in it, and loads as the verifier loads it", () => {
    const store = loadTrustStore(TPM_ROOTS);
    const roots = manifest.vendors.flatMap((v) => v.certificates.filter((c) => c.role === "root"));
    assert.equal(store.roots.length, roots.length);
    assert.equal(
      store.intermediates.length,
      manifest.vendors.flatMap((v) => v.certificates).length - roots.length,
    );
    for (const { cert } of store.roots) assert.ok(issuedBy(cert, cert), `${cert.subject} signs itself`);
    const reaches = (cert: X509Certificate, depth = 0): boolean =>
      store.roots.some((root) => issuedBy(cert, root.cert)) ||
      (depth < 4 &&
        store.intermediates.some(
          (issuer) => issuer !== cert && issuedBy(cert, issuer) && reaches(issuer, depth + 1),
        ));
    for (const cert of store.intermediates) assert.ok(reaches(cert), `${cert.subject} reaches a root`);
    for (const { cert } of store.roots) assert.ok(cert.ca, `${cert.subject} is a CA`);
  });

  it(
    "verifies a real EK certificate given in TPM_REAL_EK_CERT",
    { skip: process.env.TPM_REAL_EK_CERT ? false : "TPM_REAL_EK_CERT is not set" },
    () => {
      const data = readFileSync(process.env.TPM_REAL_EK_CERT!);
      const pem = data
        .toString("latin1")
        .match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
      const der = pem ? new X509Certificate(pem[0]).raw : data;
      const ek = verifyEkCertificate(loadTrustStore(TPM_ROOTS), der);
      assert.ok(ek, "the EK certificate chains to a vendor root in the store");
      ekPublicFor(ek.key);
    },
  );
});
