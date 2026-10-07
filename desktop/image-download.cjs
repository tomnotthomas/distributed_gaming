// Lanterel OS's image set, as a host downloads it: the release's set
// (image-set.cjs) compressed and cut into parts a GitHub release takes (at most
// 2 GiB a file), and the host app's download of it into the folder the
// installer reads.
//
// The release (swiff-os/image-set.sh) packs the set before it signs it: each
// file is compressed with gzip (Node's own zlib, which the app's Electron has;
// the root image's empty space packs to almost nothing) and the compressed
// stream is cut into parts of at most PART_BYTES, each named
// `<file>.gz.<nnn>`, in `<set>/download/`. The manifest lists every part's size
// and SHA-256 under `download`, so the one signature over swiffos.json covers
// them, and a set that is not downloaded reads as before.
//
// The host app fetches swiffos.json and its signature first, and goes no
// further unless a key it trusts signed them (imageSetOf). Then it checks the
// disk has room, fetches each part into `<image-dir>/.download/` (resuming a
// part it has some of with an HTTP Range request), checks each part's size and
// SHA-256 against the manifest, and only then unpacks a file's parts into the
// file, which must come out with the size and SHA-256 the manifest lists; a
// file's parts go once it is in, before the next file's come. The
// manifest and its signature are written last, so the set is there only once
// every file of it is. A mismatch removes the part or file it found and stops
// with what to do next.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { pipeline } = require("node:stream/promises");
const { MANIFEST, SIGNATURE, imageSetOf } = require("./image-set.cjs");
const { SWIFF_OS } = require("./rental.cjs");

/** The largest part: under 1.9 GiB, well inside a GitHub release's 2 GiB a file. */
const PART_BYTES = 1900 * 1024 * 1024;
/** Where the parts wait, inside the image folder, until their file is unpacked. */
const PARTS_DIR = ".download";
/** Room kept free beyond what the download needs. */
const SPARE_BYTES = 512 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;
const HEX = /^[0-9a-f]{64}$/;

const sha256Of = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// --- the release ------------------------------------------------------------------------------

/**
 * Compress `file` with gzip and cut it into parts of at most `partBytes` in
 * `outDir`, named `<basename>.gz.000`, `.001`, …: resolves with each part's
 * name, size and SHA-256.
 */
async function packFile(file, outDir, partBytes = PART_BYTES, level = 9) {
  const base = `${path.basename(file)}.gz`;
  const parts = [];
  let fd = null;
  let hash = null;
  let written = 0;
  const close = () => {
    if (fd === null) return;
    fs.closeSync(fd);
    parts[parts.length - 1].bytes = written;
    parts[parts.length - 1].sha256 = hash.digest("hex");
    fd = null;
  };
  const write = (chunk) => {
    for (let at = 0; at < chunk.length;) {
      if (fd === null || written === partBytes) {
        close();
        const name = `${base}.${String(parts.length).padStart(3, "0")}`;
        parts.push({ name, bytes: 0, sha256: "" });
        fd = fs.openSync(path.join(outDir, name), "w");
        hash = crypto.createHash("sha256");
        written = 0;
      }
      const n = Math.min(chunk.length - at, partBytes - written);
      const slice = chunk.subarray(at, at + n);
      fs.writeSync(fd, slice);
      hash.update(slice);
      written += n;
      at += n;
    }
  };
  fs.mkdirSync(outDir, { recursive: true });
  await pipeline(
    fs.createReadStream(file, { highWaterMark: CHUNK }),
    zlib.createGzip({ level }),
    async function* (source) {
      for await (const chunk of source) write(chunk);
    },
  );
  close();
  return parts;
}

/**
 * Pack every file the manifest in `dir` lists into `dir`/download (packFile),
 * and list the parts in the manifest under `download`: run before the
 * manifest is signed, so its signature covers them.
 */
async function packSet(dir, partBytes = PART_BYTES, level = 9) {
  const file = path.join(dir, MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const out = path.join(dir, "download");
  fs.rmSync(out, { recursive: true, force: true });
  const files = {};
  for (const name of Object.keys(manifest.files ?? {}))
    files[name] = { parts: await packFile(path.join(dir, name), out, partBytes, level) };
  manifest.download = { compression: "gzip", files };
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.download;
}

// --- the host ---------------------------------------------------------------------------------

/**
 * Where the release's image set is downloaded from: image-download.json's
 * `url` beside this file, with `{version}` for Lanterel OS's version. Only https.
 */
function sourceOf(files = fs) {
  let url;
  try {
    url = JSON.parse(files.readFileSync(path.join(__dirname, "image-download.json"), "utf8")).url ?? null;
  } catch {
    url = null;
  }
  if (typeof url !== "string" || !url) return null;
  url = url.replaceAll("{version}", SWIFF_OS.version);
  if (!url.endsWith("/")) url += "/";
  try {
    if (new URL(url).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return url;
}

/** A refusal the owner reads: what went wrong, and what to do. */
class DownloadError extends Error {
  constructor(message, { retry = true } = {}) {
    super(message);
    this.retry = retry;
  }
}

/**
 * The parts to fetch for the image set `set` (imageSetOf) its manifest lists:
 * every file the install needs, each with its parts in order. Throws unless
 * every part has a plain name, a size and a SHA-256.
 */
function downloadOf(manifest, set) {
  let parsed;
  try {
    parsed = JSON.parse(manifest.toString("utf8"));
  } catch {
    parsed = null;
  }
  const download = parsed?.download;
  if (download?.compression !== "gzip" || typeof download.files !== "object" || !download.files)
    throw new DownloadError("This Lanterel OS release can't be downloaded by this Lanterel Host.", {
      retry: false,
    });
  return Object.keys(set.files).map((name) => {
    const parts = download.files[name]?.parts;
    if (
      !Array.isArray(parts) ||
      !parts.length ||
      !parts.every(
        (p) =>
          typeof p?.name === "string" &&
          /^[\w.+-]+$/.test(p.name) &&
          Number.isSafeInteger(p.bytes) &&
          p.bytes > 0 &&
          HEX.test(p.sha256),
      )
    )
      throw new DownloadError(`This Lanterel OS release doesn't list the parts of ${name}.`, {
        retry: false,
      });
    return {
      name,
      ...set.files[name],
      parts: parts.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
    };
  });
}

/** Whether `file` is there with `bytes` bytes and SHA-256 `sha256`. */
async function holds(file, { bytes, sha256 }) {
  let handle;
  try {
    handle = await fs.promises.open(file, "r");
  } catch {
    return false;
  }
  try {
    if ((await handle.stat()).size !== bytes) return false;
    const hash = crypto.createHash("sha256");
    for await (const chunk of handle.createReadStream({ highWaterMark: CHUNK, autoClose: false }))
      hash.update(chunk);
    return hash.digest("hex") === sha256;
  } finally {
    await handle.close();
  }
}

/** A file's size on disk, or 0 when it is not there. */
const sizeOf = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

/** Bytes free on the disk that holds `dir`, or null where that can't be read. */
function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** GET `url`, from byte `from` on; throws the owner's message on anything but the bytes asked for. */
async function get(fetchFn, url, from = 0, signal) {
  let res;
  try {
    res = await fetchFn(url, {
      headers: from ? { Range: `bytes=${from}-` } : {},
      signal,
      redirect: "follow",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new DownloadError(
      "Lanterel's download server didn't answer. Check this PC is online, then try again: the download carries on where it stopped.",
    );
  }
  if (from && res.status === 206) return { res, from };
  if (res.status === 200) return { res, from: 0 };
  throw new DownloadError(
    res.status === 404
      ? "This Lanterel OS release isn't on Lanterel's download server yet. Try again later, or update Lanterel Host."
      : `Lanterel's download server answered ${res.status}. Try again in a few minutes: the download carries on where it stopped.`,
  );
}

/** The whole of a small file at `url`. */
async function getAll(fetchFn, url, signal) {
  const { res } = await get(fetchFn, url, 0, signal);
  return Buffer.from(await res.arrayBuffer());
}

/** A file this PC's drive wouldn't take or give back, such as when it is full. */
const diskError = (name, error) =>
  new DownloadError(
    `${name} couldn't be written to this PC's drive (${error.code ?? error.message}). Free up space, then try again: the download carries on where it stopped.`,
  );

/**
 * Fetch `part` from `url` into `file`, carrying on from what `file` already
 * holds; `onBytes(n)` hears each new chunk. Throws, and removes the part,
 * unless it comes out with the size and SHA-256 the manifest lists.
 */
async function fetchPart(fetchFn, url, file, part, onBytes, signal) {
  let have = Math.min(sizeOf(file), part.bytes);
  if (have > 0 && sizeOf(file) > part.bytes) fs.truncateSync(file, (have = 0));
  if (have < part.bytes) {
    const { res, from } = await get(fetchFn, url, have, signal);
    if (from === 0 && have) onBytes(-have);
    const fd = fs.openSync(file, from ? "r+" : "w");
    let at = from;
    try {
      for await (const chunk of res.body) {
        if (at + chunk.length > part.bytes)
          throw new DownloadError(`${part.name} is longer than Lanterel's release lists. Try again.`);
        fs.writeSync(fd, chunk, 0, chunk.length, at);
        at += chunk.length;
        onBytes(chunk.length);
      }
    } catch (error) {
      if (error instanceof DownloadError) {
        // Too long to be the part: none of it is kept, nor counted.
        fs.rmSync(file, { force: true });
        onBytes(-at);
        throw error;
      }
      if (signal?.aborted) throw error;
      if (error.syscall) throw diskError(part.name, error);
      throw new DownloadError(
        "The download stopped part way. Check this PC is online, then try again: it carries on where it stopped.",
      );
    } finally {
      fs.closeSync(fd);
    }
  }
  if (!(await holds(file, part))) {
    onBytes(-part.bytes);
    fs.rmSync(file, { force: true });
    throw new DownloadError(
      `${part.name} didn't match what Lanterel signed, so nothing was installed from it. Try again: it is downloaded afresh.`,
    );
  }
}

const ZERO = Buffer.alloc(1024 * 1024);
/** A block of nothing but zeros: skipped when written, so empty space costs no writes. */
const zeros = (buf) => buf.length <= ZERO.length && buf.equals(ZERO.subarray(0, buf.length));

/**
 * Unpack `file`'s checked parts, in order, from `partsDir` into `to`: throws,
 * and leaves nothing at `to`, unless it comes out with the size and SHA-256 the
 * manifest lists. Only parts that don't unpack to that file go; a file it
 * couldn't write keeps them for the next try.
 */
async function unpack(file, partsDir, to, onBytes) {
  const tmp = `${to}.part`;
  const handle = await fs.promises.open(tmp, "w");
  const hash = crypto.createHash("sha256");
  let at = 0;
  let failed = null;
  try {
    await pipeline(
      async function* () {
        for (const p of file.parts)
          for await (const chunk of fs.createReadStream(path.join(partsDir, p.name), {
            highWaterMark: CHUNK,
          }))
            yield chunk;
      },
      zlib.createGunzip({ chunkSize: 1024 * 1024 }),
      async function* (source) {
        for await (const chunk of source) {
          if (at + chunk.length > file.bytes) throw new Error("too long");
          hash.update(chunk);
          if (!zeros(chunk)) await handle.write(chunk, 0, chunk.length, at);
          at += chunk.length;
          onBytes(chunk.length);
        }
      },
    );
    await handle.truncate(at);
  } catch (error) {
    if (error.syscall) failed = error;
    at = -1;
  } finally {
    await handle.close();
  }
  if (failed) {
    fs.rmSync(tmp, { force: true });
    throw diskError(file.name, failed);
  }
  if (at !== file.bytes || hash.digest("hex") !== file.sha256) {
    fs.rmSync(tmp, { force: true });
    for (const p of file.parts) fs.rmSync(path.join(partsDir, p.name), { force: true });
    throw new DownloadError(
      `${file.name} didn't unpack to the file Lanterel signed, so it wasn't kept. Try again: it is downloaded afresh.`,
    );
  }
  fs.renameSync(tmp, to);
}

/**
 * Download Lanterel OS's image set from `url` (sourceOf) into `dir`, for keys
 * in `trust`. `onProgress({ phase, done, total })` hears how far it is: phase
 * "check" (the manifest), "download" (compressed bytes) or "unpack" (the
 * files' bytes). Resolves with the set's version once its manifest and
 * signature are in `dir`, and every file it lists beside them.
 */
async function downloadSet({
  url,
  dir,
  trust,
  fetch: fetchFn = globalThis.fetch,
  onProgress = () => {},
  signal,
  free = freeBytes,
}) {
  if (!url)
    throw new DownloadError(
      "This Lanterel Host doesn't know where to download Lanterel OS from. Update Lanterel Host.",
      {
        retry: false,
      },
    );
  onProgress({ phase: "check", done: 0, total: 0 });
  const manifest = await getAll(fetchFn, `${url}${MANIFEST}`, signal);
  const signature = await getAll(fetchFn, `${url}${SIGNATURE}`, signal);
  let set;
  try {
    set = imageSetOf(manifest, signature, trust);
  } catch (error) {
    throw new DownloadError(
      `The Lanterel OS download didn't pass the check (${error.message.replace(/\.$/, "")}), so nothing was downloaded. Try again later, or update Lanterel Host.`,
      { retry: false },
    );
  }
  const files = downloadOf(manifest, set);
  fs.mkdirSync(dir, { recursive: true });
  // A set there before, perhaps another version: only this one's files count.
  fs.rmSync(path.join(dir, SIGNATURE), { force: true });
  fs.rmSync(path.join(dir, MANIFEST), { force: true });
  const partsDir = path.join(dir, PARTS_DIR);
  fs.mkdirSync(partsDir, { recursive: true });

  const todo = [];
  for (const f of files) if (!(await holds(path.join(dir, f.name), f))) todo.push(f);
  const packed = (f) => f.parts.reduce((n, p) => n + p.bytes, 0);
  const total = todo.reduce((n, f) => n + packed(f), 0);
  const have = todo.reduce(
    (n, f) => n + f.parts.reduce((m, p) => m + Math.min(sizeOf(path.join(partsDir, p.name)), p.bytes), 0),
    0,
  );
  // Every file, and the biggest file's parts beside it while it unpacks.
  const need = todo.reduce((n, f) => n + f.bytes, 0) + Math.max(0, ...todo.map(packed)) + SPARE_BYTES;
  const room = free(dir);
  if (room !== null && room < need)
    throw new DownloadError(
      `Lanterel OS needs ${gib(need)} free on the drive that holds ${dir} to download, and it has ${gib(room)}. Free up space, then try again.`,
    );

  // A file at a time: its parts, checked, then unpacked, and its parts gone before the next file's.
  let done = have;
  let out = 0;
  const unpacked = todo.reduce((n, f) => n + f.bytes, 0);
  onProgress({ phase: "download", done, total });
  for (const f of todo) {
    for (const p of f.parts)
      await fetchPart(
        fetchFn,
        `${url}${p.name}`,
        path.join(partsDir, p.name),
        p,
        (n) => onProgress({ phase: "download", done: (done += n), total }),
        signal,
      );
    onProgress({ phase: "unpack", done: out, total: unpacked });
    await unpack(f, partsDir, path.join(dir, f.name), (n) =>
      onProgress({ phase: "unpack", done: (out += n), total: unpacked }),
    );
    for (const p of f.parts) fs.rmSync(path.join(partsDir, p.name), { force: true });
  }
  fs.rmSync(partsDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, SIGNATURE), signature);
  fs.writeFileSync(path.join(dir, MANIFEST), manifest);
  return set.version;
}

module.exports = { PART_BYTES, PARTS_DIR, packFile, packSet, sourceOf, downloadSet, DownloadError };

//   node image-download.cjs pack <dir> [part-bytes]   compress and cut the set in <dir> into <dir>/download, listed in its manifest
if (require.main === module) {
  const [cmd, dir, partBytes = String(PART_BYTES)] = process.argv.slice(2);
  const bytes = Number(partBytes);
  if (cmd === "pack" && dir && Number.isSafeInteger(bytes) && bytes > 0 && bytes <= PART_BYTES)
    packSet(dir, bytes).then(
      (download) => {
        for (const [name, { parts }] of Object.entries(download.files))
          console.log(`${name}: ${parts.length} part(s), ${parts.reduce((n, p) => n + p.bytes, 0)} bytes`);
      },
      (error) => {
        console.error(error.message);
        process.exit(1);
      },
    );
  else {
    console.error("usage: image-download.cjs pack <dir> [part-bytes]");
    process.exit(2);
  }
}
