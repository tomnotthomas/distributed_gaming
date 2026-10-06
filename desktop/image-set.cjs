// Swiff OS's image set: the files the rental-mode installer writes to a PC,
// side by side in one folder as swiff-os/image-set.sh leaves them, and the
// manifest that names them.
//
//   swiffos.json                        the version, the partition layout with
//                                       the image's own ids, names and attributes
//                                       (rental.cjs imageLayout), and each file's
//                                       size and SHA-256
//   swiffos_<version>.esp.raw           the boot partition: shim, MokManager,
//                                       systemd-boot and the signed UKI
//   swiffos_<version>.root-x86-64.raw   the system, and its dm-verity hashes
//   swiffos_<version>.root-x86-64-verity.raw
//   swiffos-key.cer                     Swiff's certificate, enrolled as a MOK
//   swiffos.json.sig                    Swiff's Ed25519 signature of swiffos.json
//
// Nothing is written from a file whose size or SHA-256 differs from the
// manifest's, and no manifest is read that a key the app trusts did not sign.
// The app ships the keys it trusts in image-trust.json, each with the SHA-256
// of the certificate its sets must carry. Lanterel's release keys are made and
// kept on the machine that signs releases (swiff-os/release-key.sh), never in
// the repository: image-trust.json holds only their public halves, which
// `image-set.cjs add-trust` writes there. A test build (build-kind.cjs) also
// trusts image-trust.dev.json beside this file: the public half of a key pair
// made on the developer's own machine.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { MOK_CERT, SWIFF_OS, splitFile } = require("./rental.cjs");

const MANIFEST = "swiffos.json";
const SIGNATURE = "swiffos.json.sig";
const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const BLOCK = 4 * 1024 * 1024;

/**
 * The keys an image set may be signed with, each with the SHA-256 of the
 * certificate its sets carry: the release's, and with `dev` (a test build, or
 * the VM tests' console tools) the developer's own.
 */
function trustOf({ dev }, files = fs) {
  const listed = (file) => {
    try {
      const list = JSON.parse(files.readFileSync(file, "utf8"));
      return Array.isArray(list)
        ? list.filter((t) => typeof t?.publicKey === "string" && /^[0-9a-f]{64}$/.test(t.certSha256))
        : [];
    } catch {
      return [];
    }
  };
  return [
    ...listed(path.join(__dirname, "image-trust.json")),
    ...(dev ? listed(path.join(__dirname, "image-trust.dev.json")) : []),
  ];
}

/** The manifest of the image set in `dir` and its signature, as they are on disk. */
function readSigned(dir, files = fs) {
  try {
    return {
      manifest: files.readFileSync(path.join(dir, MANIFEST)),
      signature: files.readFileSync(path.join(dir, SIGNATURE)),
    };
  } catch {
    throw new Error(`No signed Swiff OS image set in ${dir}.`);
  }
}

/** Whether `trusted`'s key signed `manifest`. */
function signedBy(trusted, manifest, signature) {
  try {
    return crypto.verify(null, manifest, crypto.createPublicKey(trusted.publicKey), signature);
  } catch {
    return false;
  }
}

/**
 * The image set `manifest` describes, once a key in `trust` is found to have
 * signed it: throws unless it lays out exactly Swiff OS's partitions, lists
 * every file the install needs, and carries the certificate that key's sets
 * carry.
 */
function imageSetOf(manifest, signature, trust) {
  const signer = trust.find((t) => signedBy(t, manifest, signature));
  if (!signer) throw new Error("Swiff did not sign this image set.");
  let parsed;
  try {
    parsed = JSON.parse(manifest.toString("utf8"));
  } catch {
    throw new Error("The image set's manifest cannot be read.");
  }
  const { version, layout, files: listed } = parsed ?? {};
  if (typeof version !== "string" || !/^[\w.+-]+$/.test(version))
    throw new Error("The image set has no version.");
  if (!Array.isArray(layout) || layout.length !== SWIFF_OS.partitions.length)
    throw new Error("The image set lays out other partitions than Swiff OS's.");
  layout.forEach((p, i) => {
    const want = SWIFF_OS.partitions[i];
    if (
      p?.role !== want.role ||
      p.type !== want.type ||
      p.bytes !== want.bytes ||
      p.split !== want.split ||
      !GUID.test(p.id) ||
      typeof p.name !== "string" ||
      p.name.length > 36 ||
      !/^0x[0-9a-f]{1,16}$/.test(p.attrs)
    )
      throw new Error(`The image set's partition ${i + 1} is not Swiff OS's ${want.role}.`);
  });
  const need = [...layout.filter((p) => p.split).map((p) => splitFile(p.split, version)), MOK_CERT];
  for (const name of need) {
    const f = listed?.[name];
    if (!f || !Number.isSafeInteger(f.bytes) || !/^[0-9a-f]{64}$/.test(f.sha256))
      throw new Error(`The image set does not list ${name}.`);
  }
  for (const p of layout.filter((p) => p.split))
    if (listed[splitFile(p.split, version)].bytes !== p.bytes)
      throw new Error(`The image set's ${p.role} is not the size of its partition.`);
  if (listed[MOK_CERT].sha256 !== signer.certSha256)
    throw new Error("The image set's certificate is not Swiff's.");
  return {
    version,
    layout: layout.map(({ role, type, bytes, split, id, name, attrs }) => ({
      role,
      type,
      bytes,
      split,
      id,
      name,
      attrs,
    })),
    files: Object.fromEntries(need.map((name) => [name, { ...listed[name] }])),
  };
}

/** The image set in `dir`, signed by a key in `trust` (imageSetOf). */
function readImageSet(dir, { trust, files = fs }) {
  const { manifest, signature } = readSigned(dir, files);
  return { ...imageSetOf(manifest, signature, trust), dir };
}

/** A file of the set, by name: only the names its manifest lists. */
function fileOf(set, name) {
  if (!Object.hasOwn(set.files, name)) throw new Error(`${name} is not in the image set.`);
  return { path: path.join(set.dir, name), ...set.files[name] };
}

/** The file a partition's contents come from. */
const sourceOf = (set, split) => fileOf(set, splitFile(split, set.version));

/**
 * SHA-256 of `bytes` bytes read through `read(buffer, offset)` (which fills the
 * buffer from `offset` on), in blocks, reporting progress after each.
 */
async function hashOf(read, bytes, onProgress = () => {}) {
  const hash = crypto.createHash("sha256");
  const buf = Buffer.alloc(BLOCK);
  for (let at = 0; at < bytes; at += BLOCK) {
    const n = Math.min(BLOCK, bytes - at);
    const got = await read(buf.subarray(0, n), at);
    if (got !== n) throw new Error("A read came back short.");
    hash.update(buf.subarray(0, n));
    onProgress(at + n, bytes);
  }
  return hash.digest("hex");
}

/**
 * Hash the first `bytes` bytes of file `from`, copying them to `to` as they go
 * unless `to` is null (a check in place, nothing written): throws unless they
 * have the SHA-256 `sha256` the image set lists, and `to` is there afterwards
 * only if they do.
 */
async function copyChecked(from, to, { bytes, sha256 }, onProgress, files = fs) {
  const name = path.basename(from);
  let src;
  try {
    src = files.openSync(from, "r");
  } catch {
    throw new Error(`${name} of the image set is not on this PC.`);
  }
  const part = to && `${to}.part`;
  let sha = null;
  let dst = null;
  try {
    if (files.fstatSync(src).size >= bytes) {
      dst = part && files.openSync(part, "w");
      sha = await hashOf(
        async (buf, at) => {
          const n = files.readSync(src, buf, 0, buf.length, at);
          if (dst !== null) files.writeSync(dst, buf, 0, n, at);
          return n;
        },
        bytes,
        onProgress,
      );
    }
  } finally {
    files.closeSync(src);
    if (dst !== null) files.closeSync(dst);
  }
  if (sha !== sha256) {
    if (part) files.rmSync(part, { force: true });
    throw new Error(`${name} is not the file its image set lists.`);
  }
  if (part) files.renameSync(part, to);
}

/** The first X.509 certificate (DER) in an authenticated variable file such as systemd-boot's db.auth. */
function certFromAuth(auth) {
  const b = Buffer.from(auth);
  // EFI_TIME, then WIN_CERTIFICATE_UEFI_GUID, whose dwLength covers itself, then the signature lists.
  for (let at = 16 + b.readUInt32LE(16); at + 28 <= b.length;) {
    const size = b.readUInt32LE(at + 16);
    const header = b.readUInt32LE(at + 20);
    const sigSize = b.readUInt32LE(at + 24);
    if (size < 28 || at + size > b.length) break;
    if (b.subarray(at, at + 16).equals(X509) && sigSize > 16)
      return b.subarray(at + 28 + header + 16, at + 28 + header + sigSize);
    at += size;
  }
  throw new Error("No certificate in the file.");
}

const X509 = Buffer.from("a159c0a5e494a74a87b5ab155c2bf072", "hex");

// The image signing key is only ever kept on disk encrypted (PKCS#8, AES-256),
// the release's and a developer's alike, and is unlocked with the passphrase in
// $SWIFF_OS_KEY_PASSPHRASE. A key file that is not encrypted is refused.
const ENCRYPTED_PEM = "-----BEGIN ENCRYPTED PRIVATE KEY-----";
const DEV_KEY_WAY_OUT =
  "A developer key can be deleted: image-set.sh then makes a new one (rebuild the test build so it trusts the new image-trust.dev.json).";

function passphraseOf(passphrase) {
  if (!passphrase) throw new Error("Set SWIFF_OS_KEY_PASSPHRASE to the image signing key's passphrase.");
  return passphrase;
}

/** The private key in encrypted PEM file `key`, unlocked with `passphrase`. */
function signingKeyOf(key, passphrase = process.env.SWIFF_OS_KEY_PASSPHRASE) {
  const pem = fs.readFileSync(key, "utf8");
  if (!pem.includes(ENCRYPTED_PEM))
    throw new Error(
      `The image signing key in ${key} is not encrypted: keep it as an encrypted PKCS#8 file (\`image-set.cjs devkey\` makes one). ${DEV_KEY_WAY_OUT}`,
    );
  try {
    return crypto.createPrivateKey({ key: pem, format: "pem", passphrase: passphraseOf(passphrase) });
  } catch (error) {
    if (!passphrase) throw error;
    throw new Error(`The passphrase does not unlock the image signing key in ${key}. ${DEV_KEY_WAY_OUT}`);
  }
}

/** Make a new Ed25519 image signing key in `file` (which must not exist yet), encrypted with `passphrase`. */
function newSigningKey(file, passphrase = process.env.SWIFF_OS_KEY_PASSPHRASE) {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({
    type: "pkcs8",
    format: "pem",
    cipher: "aes-256-cbc",
    passphrase: passphraseOf(passphrase),
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pem, { mode: 0o600, flag: "wx" });
}

/** Sign the manifest of the image set in `dir` with the Ed25519 private key in encrypted PEM file `key`. */
function signManifest(dir, key, passphrase = process.env.SWIFF_OS_KEY_PASSPHRASE) {
  const manifest = fs.readFileSync(path.join(dir, MANIFEST));
  fs.writeFileSync(path.join(dir, SIGNATURE), crypto.sign(null, manifest, signingKeyOf(key, passphrase)));
}

/** What the app must trust for sets signed with the private key in encrypted PEM file `key` that carry certificate file `cert`. */
function trustEntry(key, cert, passphrase = process.env.SWIFF_OS_KEY_PASSPHRASE) {
  return {
    publicKey: crypto.createPublicKey(signingKeyOf(key, passphrase)).export({ type: "spki", format: "pem" }),
    certSha256: crypto.createHash("sha256").update(fs.readFileSync(cert)).digest("hex"),
  };
}

/** SHA-256 of a public key's SPKI DER: its fingerprint, for people to compare. */
const fingerprintOf = (publicKey) =>
  crypto
    .createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");

/**
 * The public halves of a release key pair, as text: the image signing key in
 * encrypted PEM file `key`, the Secure Boot certificate (PEM) in `cert`, and
 * both fingerprints. What release-key.sh prints, and what add-trust reads.
 */
function publicOf(key, cert, passphrase = process.env.SWIFF_OS_KEY_PASSPHRASE) {
  const publicKey = crypto.createPublicKey(signingKeyOf(key, passphrase));
  const x509 = new crypto.X509Certificate(fs.readFileSync(cert));
  return [
    "Image signing public key (Ed25519):",
    publicKey.export({ type: "spki", format: "pem" }).trim(),
    `Image signing key fingerprint (SHA-256 of SPKI DER): ${fingerprintOf(publicKey)}`,
    `Secure Boot certificate (${x509.subject.replace(/\n/g, ", ")}):`,
    x509.toString().trim(),
    `Secure Boot certificate SHA-256 (DER, swiffos-key.cer): ${crypto.createHash("sha256").update(x509.raw).digest("hex")}`,
    "",
  ].join("\n");
}

/**
 * The image-trust.json entry for the public halves in `text` (publicOf's
 * output): its Ed25519 public key and the SHA-256 of its certificate's DER,
 * which is what swiffos-key.cer holds. Each is worked out from the PEM itself,
 * and a certificate hash printed beside it must agree.
 */
function releaseTrustOf(text) {
  if (/PRIVATE KEY-----/.test(text))
    throw new Error("This holds a private key: give only the public halves release-key.sh prints.");
  const pem = (label) => {
    const found =
      text.match(new RegExp(`-----BEGIN ${label}-----[\\s\\S]*?-----END ${label}-----`, "g")) ?? [];
    if (found.length !== 1) throw new Error(`Expected one ${label} block, found ${found.length}.`);
    return found[0];
  };
  const publicKey = crypto.createPublicKey(pem("PUBLIC KEY"));
  if (publicKey.asymmetricKeyType !== "ed25519")
    throw new Error("The image signing key is not an Ed25519 key.");
  const cert = new crypto.X509Certificate(pem("CERTIFICATE"));
  const entry = {
    publicKey: publicKey.export({ type: "spki", format: "pem" }),
    certSha256: crypto.createHash("sha256").update(cert.raw).digest("hex"),
  };
  const printed = text.match(/Secure Boot certificate SHA-256[^:\n]*: ([0-9a-f]{64})/)?.[1];
  if (printed !== undefined && printed !== entry.certSha256)
    throw new Error("The printed Secure Boot certificate SHA-256 is not the one its PEM has.");
  return entry;
}

/**
 * Add the release entry for the public halves in `text` (releaseTrustOf) to
 * the trust list in `file`, after the keys there: each stays trusted until it
 * is taken out by hand. Returns whether it was added (not already listed).
 */
function addTrust(text, file = path.join(__dirname, "image-trust.json")) {
  const entry = releaseTrustOf(text);
  const list = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(list)) throw new Error(`${file} is not a list.`);
  if (list.some((t) => t?.publicKey === entry.publicKey && t.certSha256 === entry.certSha256)) return false;
  fs.writeFileSync(file, `${JSON.stringify([...list, entry], null, 2)}\n`);
  return true;
}

/**
 * Write the manifest of the image set in `dir`: the layout of the full disk
 * image `image` it was split from, and every file's size and SHA-256.
 */
async function writeManifest(dir, image, version) {
  const { readGpt } = require("./gpt.cjs");
  const { imageLayout } = require("./rental.cjs");
  const fd = fs.openSync(image, "r");
  const layout = imageLayout(
    readGpt(
      (offset, length) => {
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, offset);
        return buf;
      },
      { diskBytes: fs.fstatSync(fd).size },
    ),
  );
  fs.closeSync(fd);
  const names = [...layout.filter((p) => p.split).map((p) => splitFile(p.split, version)), MOK_CERT];
  const listed = {};
  for (const name of names) {
    const file = path.join(dir, name);
    const handle = await fs.promises.open(file, "r");
    const { size } = await handle.stat();
    const sha256 = await hashOf(
      async (buf, at) => (await handle.read(buf, 0, buf.length, at)).bytesRead,
      size,
    );
    await handle.close();
    listed[name] = { bytes: size, sha256 };
  }
  fs.writeFileSync(
    path.join(dir, MANIFEST),
    `${JSON.stringify({ version, layout, files: listed }, null, 2)}\n`,
  );
}

module.exports = {
  MANIFEST,
  SIGNATURE,
  BLOCK,
  trustOf,
  readSigned,
  imageSetOf,
  readImageSet,
  fileOf,
  sourceOf,
  hashOf,
  copyChecked,
  certFromAuth,
  newSigningKey,
  signManifest,
  trustEntry,
  publicOf,
  releaseTrustOf,
  addTrust,
  writeManifest,
};

//   node image-set.cjs cert <db.auth> <out.cer>
//   node image-set.cjs manifest <dir> <full-image.raw> <version>
//   node image-set.cjs devkey <private-key.pem>                     a new key, encrypted with $SWIFF_OS_KEY_PASSPHRASE
//   node image-set.cjs sign <dir> <private-key.pem>
//   node image-set.cjs trust <private-key.pem> <swiffos-key.cer>     the image-trust.dev.json entry, as JSON
//   node image-set.cjs public <private-key.pem> <secure-boot.crt>    a release key pair's public halves (release-key.sh)
//   node image-set.cjs add-trust <public.txt>                        add them to image-trust.json
//   node image-set.cjs verify <dir>                                  whether a release build reads the set in <dir>
if (require.main === module) {
  const [cmd, a, b, c] = process.argv.slice(2);
  const failed = (error) => {
    console.error(error.message);
    process.exit(1);
  };
  try {
    if (cmd === "cert") fs.writeFileSync(b, certFromAuth(fs.readFileSync(a)));
    else if (cmd === "devkey") newSigningKey(a);
    else if (cmd === "sign") signManifest(a, b);
    else if (cmd === "trust") console.log(JSON.stringify([trustEntry(a, b)], null, 2));
    else if (cmd === "public") process.stdout.write(publicOf(a, b));
    else if (cmd === "add-trust")
      console.log(
        addTrust(fs.readFileSync(a, "utf8")) ? "Added to image-trust.json." : "Already in image-trust.json.",
      );
    else if (cmd === "verify")
      console.log(
        `A release build reads Swiff OS ${readImageSet(a, { trust: trustOf({ dev: false }) }).version} in ${a}.`,
      );
    else if (cmd === "manifest") writeManifest(a, b, c).catch(failed);
    else {
      console.error(
        "usage: image-set.cjs cert <db.auth> <out.cer> | manifest <dir> <image.raw> <version> | devkey <key.pem> | sign <dir> <key.pem> | trust <key.pem> <cert> | public <key.pem> <cert.pem> | add-trust <public.txt> | verify <dir>",
      );
      process.exit(2);
    }
  } catch (error) {
    failed(error);
  }
}
