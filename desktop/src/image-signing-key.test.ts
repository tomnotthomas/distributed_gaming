// @vitest-environment node
// The image signing key (image-set.cjs): kept on disk only encrypted, unlocked
// with its passphrase, and refused when stored as a plain PEM.

import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MANIFEST, newSigningKey, SIGNATURE, signManifest, trustEntry } from "../image-set.cjs";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swiff-signing-key-"));
  fs.writeFileSync(path.join(dir, MANIFEST), '{"version":"0.1.0"}\n');
  fs.writeFileSync(path.join(dir, "swiffos-key.cer"), "certificate");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the image signing key", () => {
  it("is made encrypted and signs a manifest its trust entry verifies", () => {
    const key = path.join(dir, "keys", "image-dev-key.pem");
    newSigningKey(key, "correct horse");

    expect(() => createPrivateKey(fs.readFileSync(key))).toThrow();
    if (process.platform !== "win32") expect(fs.statSync(key).mode & 0o777).toBe(0o600);

    signManifest(dir, key, "correct horse");
    const trust = trustEntry(key, path.join(dir, "swiffos-key.cer"), "correct horse");
    const manifest = fs.readFileSync(path.join(dir, MANIFEST));
    const signature = fs.readFileSync(path.join(dir, SIGNATURE));
    expect(verify(null, manifest, createPublicKey(trust.publicKey), signature)).toBe(true);
  });

  it("is not made over an existing file, nor without a passphrase", () => {
    const key = path.join(dir, "key.pem");
    fs.writeFileSync(key, "existing");
    expect(() => newSigningKey(key, "pass")).toThrow();
    expect(fs.readFileSync(key, "utf8")).toBe("existing");
    expect(() => newSigningKey(path.join(dir, "other.pem"), "")).toThrow(/SWIFF_OS_KEY_PASSPHRASE/);
    expect(fs.existsSync(path.join(dir, "other.pem"))).toBe(false);
  });

  it("refuses a key stored as a plain PEM, and signs nothing with it", () => {
    const key = path.join(dir, "plain.pem");
    const { privateKey } = generateKeyPairSync("ed25519");
    fs.writeFileSync(key, privateKey.export({ type: "pkcs8", format: "pem" }));

    expect(() => signManifest(dir, key, "pass")).toThrow(/not encrypted.*developer key can be deleted/);
    expect(() => trustEntry(key, path.join(dir, "swiffos-key.cer"), "pass")).toThrow(/not encrypted/);
    expect(fs.existsSync(path.join(dir, SIGNATURE))).toBe(false);
  });

  it("says when the passphrase is missing or wrong", () => {
    const key = path.join(dir, "key.pem");
    newSigningKey(key, "right");

    expect(() => signManifest(dir, key, "")).toThrow(/SWIFF_OS_KEY_PASSPHRASE/);
    expect(() => signManifest(dir, key, "wrong")).toThrow(/does not unlock.*developer key can be deleted/);
    expect(fs.existsSync(path.join(dir, SIGNATURE))).toBe(false);
  });
});
