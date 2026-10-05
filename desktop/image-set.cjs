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
//
// Nothing is written from a file whose size or SHA-256 differs from the
// manifest's.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { MOK_CERT, SWIFF_OS, splitFile } = require("./rental.cjs");

const MANIFEST = "swiffos.json";
const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const BLOCK = 4 * 1024 * 1024;

/**
 * The image set in `dir`, from its manifest: throws unless the manifest lays
 * out exactly Swiff OS's partitions and lists every file the install needs.
 */
function readImageSet(dir, files = fs) {
  let manifest;
  try {
    manifest = JSON.parse(files.readFileSync(path.join(dir, MANIFEST), "utf8"));
  } catch {
    throw new Error(`No Swiff OS image set in ${dir}.`);
  }
  const { version, layout, files: listed } = manifest ?? {};
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
  return {
    dir,
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

/** Throws unless the file `name` of the set has the size and SHA-256 its manifest lists. */
async function verifyFile(set, name, onProgress) {
  const file = fileOf(set, name);
  const handle = await fs.promises.open(file.path, "r");
  try {
    const { size } = await handle.stat();
    if (size !== file.bytes)
      throw new Error(`${name} is ${size} bytes, not the ${file.bytes} its image set lists.`);
    const sha = await hashOf(
      async (buf, at) => (await handle.read(buf, 0, buf.length, at)).bytesRead,
      size,
      onProgress,
    );
    if (sha !== file.sha256)
      throw new Error(`${name} is not the file its image set lists: its SHA-256 differs.`);
  } finally {
    await handle.close();
  }
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
  BLOCK,
  readImageSet,
  fileOf,
  sourceOf,
  hashOf,
  verifyFile,
  certFromAuth,
  writeManifest,
};

//   node image-set.cjs cert <db.auth> <out.cer>
//   node image-set.cjs manifest <dir> <full-image.raw> <version>
if (require.main === module) {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === "cert") fs.writeFileSync(b, certFromAuth(fs.readFileSync(a)));
  else if (cmd === "manifest")
    writeManifest(a, b, c).catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
  else {
    console.error("usage: image-set.cjs cert <db.auth> <out.cer> | manifest <dir> <image.raw> <version>");
    process.exit(2);
  }
}
