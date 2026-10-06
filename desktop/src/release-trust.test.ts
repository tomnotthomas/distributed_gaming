// @vitest-environment node
// Lanterel's release keys: what swiff-os/release-key.sh makes, what
// `image-set.cjs add-trust` puts into image-trust.json from its printed public
// halves, and that a release build then reads a set signed with that key and
// built with that Secure Boot certificate, and no other. A throwaway key pair
// made here stands in for the real one, which never leaves the signing machine.

import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addTrust,
  MANIFEST,
  readImageSet,
  releaseTrustOf,
  SIGNATURE,
  signManifest,
  trustOf,
  type Trust,
} from "../image-set.cjs";
import { splitFile, SWIFF_OS } from "../rental.cjs";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const ID = (i: number) => `00000000-0000-4000-8000-00000000000${i}`;
const SCRIPT = path.join(__dirname, "..", "..", "swiff-os", "release-key.sh");
const has = (tool: string) => {
  try {
    execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const tools = process.platform !== "win32" && ["bash", "openssl", "gpg", "tar"].every(has);

/** An image set in `dir` carrying certificate `cert`, signed by `signer` (a KeyObject, or the release key file). */
function imageSet(dir: string, cert: Buffer, signer: (manifest: Buffer) => void) {
  fs.mkdirSync(dir, { recursive: true });
  const layout = SWIFF_OS.partitions.map((p, i) => ({ ...p, id: ID(i), name: `part${i}` }));
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const p of layout.filter((p) => p.split))
    files[splitFile(p.split!)] = { bytes: p.bytes, sha256: "0".repeat(64) };
  files["swiffos-key.cer"] = { bytes: cert.length, sha256: sha256(cert) };
  const manifest = Buffer.from(JSON.stringify({ version: "0.1.0", layout, files }));
  fs.writeFileSync(path.join(dir, MANIFEST), manifest);
  fs.writeFileSync(path.join(dir, "swiffos-key.cer"), cert);
  signer(manifest);
  return dir;
}

/** The trust a build of `kind` has when image-trust.json is `release` and image-trust.dev.json is `dev`. */
function trustFor(kind: "release" | "test", release: string, dev: Trust[]) {
  const files = {
    readFileSync: (file: string) => {
      if (file.endsWith("image-trust.dev.json")) return JSON.stringify(dev);
      if (file.endsWith("image-trust.json")) return fs.readFileSync(release, "utf8");
      throw new Error("ENOENT");
    },
  } as unknown as typeof fs;
  return trustOf({ dev: kind === "test" }, files);
}

describe.skipIf(!tools)("Lanterel's release keys", () => {
  let dir: string;
  let keys: string;
  let backup: string;
  let printed: string;
  let releaseCert: Buffer;
  let trustFile: string;
  const passphrase = () => fs.readFileSync(path.join(keys, "image-signing-key.passphrase"), "utf8");
  const releaseSigned = (out: string) => () =>
    signManifest(out, path.join(keys, "image-signing-key.pem"), passphrase());

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "swiff-release-key-"));
    keys = path.join(dir, "keys");
    backup = path.join(dir, "secrets", "release-keys.tar.gpg");
    const gnupg = path.join(dir, "gnupg");
    fs.mkdirSync(gnupg, { mode: 0o700 });
    printed = execFileSync("bash", [SCRIPT, keys, backup], {
      encoding: "utf8",
      env: { ...process.env, GNUPGHOME: gnupg, SWIFF_OS_KEY_PASSPHRASE: "" },
    });
    releaseCert = new X509Certificate(fs.readFileSync(path.join(keys, "secure-boot.crt"))).raw;
    trustFile = path.join(dir, "image-trust.json");
    fs.writeFileSync(trustFile, "[]\n");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("are kept to their owner, backed up encrypted, and print only their public halves", () => {
    expect(fs.statSync(keys).mode & 0o777).toBe(0o700);
    for (const name of [
      "image-signing-key.pem",
      "image-signing-key.passphrase",
      "secure-boot.key",
      "backup.passphrase",
    ])
      expect(fs.statSync(path.join(keys, name)).mode & 0o777, name).toBe(0o600);
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(keys, "image-signing-key.pem"), "utf8")).toContain(
      "ENCRYPTED PRIVATE KEY",
    );

    expect(printed).not.toMatch(/PRIVATE KEY/);
    for (const name of ["image-signing-key.passphrase", "backup.passphrase"])
      expect(printed).not.toContain(fs.readFileSync(path.join(keys, name), "utf8"));
    expect(printed).toContain(fs.readFileSync(path.join(keys, "public.txt"), "utf8"));
    expect(printed).toMatch(/CN=Lanterel OS Secure Boot/);

    const raw = fs.readFileSync(backup);
    expect(raw.includes(Buffer.from("PRIVATE KEY"))).toBe(false);
    const listed = execFileSync(
      "sh",
      [
        "-c",
        'gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$1" -d "$2" | tar -tf -',
        "sh",
        path.join(keys, "backup.passphrase"),
        backup,
      ],
      { encoding: "utf8", env: { ...process.env, GNUPGHOME: path.join(dir, "gnupg") } },
    );
    expect(listed.trim().split("\n").sort()).toEqual(
      ["image-signing-key.passphrase", "image-signing-key.pem", "secure-boot.crt", "secure-boot.key"].sort(),
    );
  });

  it("refuses to make a key over an existing one", () => {
    expect(() =>
      execFileSync("bash", [SCRIPT, keys, path.join(dir, "other.tar.gpg")], { stdio: "pipe" }),
    ).toThrow(/already there/);
    expect(fs.existsSync(path.join(dir, "other.tar.gpg"))).toBe(false);
  });

  it("are taken back when a run stops part way, so the next run is not refused", () => {
    const failing = path.join(dir, "failing");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    // A gpg that leaves half a backup where it was to write one, and fails.
    fs.writeFileSync(
      path.join(bin, "gpg"),
      '#!/bin/sh\nfor a; do out=$a; done\necho half > "$out"\nexit 1\n',
      { mode: 0o755 },
    );
    const run = (env: NodeJS.ProcessEnv) =>
      execFileSync("bash", [SCRIPT, failing, path.join(dir, "failing.tar.gpg")], { stdio: "pipe", env });
    expect(() => run({ ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` })).toThrow();
    expect(fs.readdirSync(failing)).toEqual([]);
    expect(fs.existsSync(path.join(dir, "failing.tar.gpg"))).toBe(false);

    const gnupg = path.join(dir, "gnupg");
    run({ ...process.env, GNUPGHOME: gnupg });
    expect(fs.readFileSync(path.join(failing, "public.txt"), "utf8")).toMatch(/BEGIN CERTIFICATE/);
  });

  it("go into image-trust.json from the printed output, once", () => {
    expect(addTrust(printed, trustFile)).toBe(true);
    expect(addTrust(printed, trustFile)).toBe(false);
    const list = JSON.parse(fs.readFileSync(trustFile, "utf8"));
    expect(list).toHaveLength(1);
    const [entry] = list;
    expect(Object.keys(entry).sort()).toEqual(["certSha256", "publicKey"]);
    expect(entry.certSha256).toBe(sha256(releaseCert));
    expect(createPublicKey(entry.publicKey).asymmetricKeyType).toBe("ed25519");
    expect(JSON.stringify(list)).not.toMatch(/PRIVATE/);
  });

  it("are not taken from output that was changed or holds a private key", () => {
    const certHash = printed.match(/certificate SHA-256[^:\n]*: ([0-9a-f]{64})/)![1]!;
    expect(() => releaseTrustOf(printed.replace(certHash, "0".repeat(64)))).toThrow(/certificate SHA-256/);
    const { privateKey } = generateKeyPairSync("ed25519");
    expect(() =>
      releaseTrustOf(`${printed}\n${privateKey.export({ type: "pkcs8", format: "pem" })}`),
    ).toThrow(/private key/);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
      type: "spki",
      format: "pem",
    });
    expect(() =>
      releaseTrustOf(
        printed.replace(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/, String(rsa).trim()),
      ),
    ).toThrow(/not an Ed25519 key/);
  });

  it("are what a release build reads a set by: dev-signed and tampered sets are refused", () => {
    if (JSON.parse(fs.readFileSync(trustFile, "utf8")).length === 0) addTrust(printed, trustFile);
    const devKey = generateKeyPairSync("ed25519");
    const devCert = Buffer.from("3082010a0282010100decafbad", "hex");
    const dev = [
      {
        publicKey: devKey.publicKey.export({ type: "spki", format: "pem" }) as string,
        certSha256: sha256(devCert),
      },
    ];
    const release = trustFor("release", trustFile, dev);
    const test = trustFor("test", trustFile, dev);
    const devSigned = (out: string) => (m: Buffer) =>
      fs.writeFileSync(path.join(out, SIGNATURE), sign(null, m, devKey.privateKey));

    const good = path.join(dir, "good");
    imageSet(good, releaseCert, releaseSigned(good));
    expect(readImageSet(good, { trust: release }).version).toBe("0.1.0");
    expect(readImageSet(good, { trust: test }).version).toBe("0.1.0");

    // A developer's set: a test build reads it, a release build does not.
    const devSet = path.join(dir, "dev");
    imageSet(devSet, devCert, devSigned(devSet));
    expect(readImageSet(devSet, { trust: test }).version).toBe("0.1.0");
    expect(() => readImageSet(devSet, { trust: release })).toThrow(/Lanterel did not sign this image set/);
    // Nor with the release certificate in it.
    const devWithRelease = path.join(dir, "dev-release-cert");
    imageSet(devWithRelease, releaseCert, devSigned(devWithRelease));
    expect(() => readImageSet(devWithRelease, { trust: release })).toThrow(
      /Lanterel did not sign this image set/,
    );

    // Signed with the release key, but built with another Secure Boot certificate.
    const otherCert = path.join(dir, "other-cert");
    imageSet(otherCert, devCert, releaseSigned(otherCert));
    expect(() => readImageSet(otherCert, { trust: release })).toThrow(/certificate is not Lanterel's/);

    // Changed after it was signed: the manifest, or the signature.
    const manifest = JSON.parse(fs.readFileSync(path.join(good, MANIFEST), "utf8"));
    fs.writeFileSync(path.join(good, MANIFEST), JSON.stringify({ ...manifest, version: "0.1.1" }));
    expect(() => readImageSet(good, { trust: release })).toThrow(/Lanterel did not sign this image set/);
    imageSet(good, releaseCert, releaseSigned(good));
    const signature = fs.readFileSync(path.join(good, SIGNATURE));
    signature[0]! ^= 1;
    fs.writeFileSync(path.join(good, SIGNATURE), signature);
    expect(() => readImageSet(good, { trust: release })).toThrow(/Lanterel did not sign this image set/);
  });
});

describe("the shipped image-trust.json", () => {
  it("lists only Ed25519 release keys, each with a certificate hash", () => {
    const list = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "image-trust.json"), "utf8"));
    expect(Array.isArray(list)).toBe(true);
    for (const entry of list) {
      expect(Object.keys(entry).sort()).toEqual(["certSha256", "publicKey"]);
      expect(createPublicKey(entry.publicKey).asymmetricKeyType).toBe("ed25519");
      expect(entry.certSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(trustOf({ dev: false })).toHaveLength(list.length);
  });
});
