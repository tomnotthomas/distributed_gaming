// NVIDIA's driver for Swiff OS, in the main process. Swiff does not ship,
// bundle or mirror it: the owner installs it on their own PC, from Ubuntu's
// archive, after reading and accepting NVIDIA's licence themselves.
//
//   readManifest    the driver Swiff OS expects: its release, where Ubuntu
//                   publishes it and NVIDIA's licence for it, and each package's
//                   SHA-256 (the image's /usr/lib/swiff/nvidia-driver, copied
//                   here as swiff-os-nvidia-driver)
//   fetchLicence    NVIDIA's licence for that release, from Ubuntu, checked
//                   against the manifest: the text the driver itself carries
//   driverState     whether the owner's games drive holds the driver, and what
//                   they accepted
//   installDriver   records the owner's acceptance, then downloads each package
//                   from Ubuntu onto the games drive, under
//                   SwiffOS\nvidia\<release>\, checking each against its SHA-256
//   removeDriver    deletes that folder and the acceptance
//
// Swiff OS checks every package again at each boot before it loads any of it
// (swiff-os/NVIDIA.md).

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/** The manifest beside this file: the same as the image's /usr/lib/swiff/nvidia-driver. */
const MANIFEST_FILE = path.join(__dirname, "swiff-os-nvidia-driver");

/** Where the owner's acceptance is kept, in the app's own data folder. */
const ACCEPTANCE_FILE = "nvidia-acceptance.json";

/**
 * Swiff's hosting terms for NVIDIA cards, by version: the owner accepts these
 * beside NVIDIA's licence (desktop/src/nvidia.ts has the text). A new version
 * asks again.
 */
const TERMS_VERSION = "2026-10-06";

/**
 * The first PCI device number the driver runs: 0x1E00, the first Turing chip
 * (GeForce GTX 16 and RTX 20 series on). NVIDIA moved every older card to its
 * legacy driver branches. desktop/src/rental.ts says the same to the owner.
 */
const NVIDIA_FIRST_SUPPORTED = 0x1e00;

/** Whether one of `gpus` (rental.cjs facts) is an NVIDIA card the driver runs. */
const supportedCard = (gpus) =>
  gpus.some((g) => g.vendor === "nvidia" && g.device !== null && g.device >= NVIDIA_FIRST_SUPPORTED);

/** Room left on the games drive beyond the driver itself. */
const SPARE_BYTES = 64 * 1024 * 1024;

/** The manifest's text as fields: version, mirror, licence and its SHA-256, and each package. */
function parseManifest(text) {
  const lines = String(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(/\s+/));
  const one = (key) => {
    const found = lines.filter((l) => l[0] === key);
    if (found.length !== 1 || !found[0][1]) throw new Error(`nvidia-driver: one ${key} line expected`);
    return found[0][1];
  };
  const files = lines
    .filter((l) => l[0] === "file")
    .map(([, sha256, size, pool]) => {
      const malformed =
        !/^[0-9a-f]{64}$/.test(sha256 ?? "") ||
        !/^\d+$/.test(size ?? "") ||
        !/^pool\/[\w.+~%/-]+\.deb$/.test(pool ?? "") ||
        pool.split("/").includes("..");
      if (malformed) throw new Error("nvidia-driver: a file line is malformed");
      return { sha256, size: Number(size), path: pool, name: path.posix.basename(pool) };
    });
  if (!files.length) throw new Error("nvidia-driver: no files");
  const sha = one("licence-sha256");
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error("nvidia-driver: licence-sha256 is malformed");
  return {
    version: one("version"),
    mirror: one("mirror").replace(/\/+$/, ""),
    licence: { url: one("licence"), sha256: sha },
    files,
    bytes: files.reduce((sum, f) => sum + f.size, 0),
  };
}

/** The manifest this app was built with. */
const readManifest = (file = MANIFEST_FILE, files = fs) => parseManifest(files.readFileSync(file, "utf8"));

/** The folder on the games drive Swiff OS looks in: D:\SwiffOS\nvidia\595.91.07. */
const driverFolder = (letter, version) => path.win32.join(`${letter}:\\`, "SwiffOS", "nvidia", version);

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

/**
 * A failure as the screen explains it: `offline` (the server could not be
 * reached), `gone` (it no longer has a file), `server` (it answered with an
 * error), `changed` (what it sent is not what Swiff OS expects), `space`,
 * `write`, `cancelled`.
 */
class DriverError extends Error {
  constructor(code, detail = "") {
    super(`${code}${detail ? `: ${detail}` : ""}`);
    this.code = code;
  }
}

/** GET `url` with `fetch`, as a DriverError when it fails. */
async function get(fetch, url, signal) {
  let res;
  try {
    res = await fetch(url, { signal, cache: "no-store" });
  } catch (error) {
    if (signal?.aborted) throw new DriverError("cancelled");
    throw new DriverError("offline", error instanceof Error ? error.message : String(error));
  }
  if (res.status === 404 || res.status === 410) throw new DriverError("gone", url);
  if (!res.ok) throw new DriverError("server", `${res.status} ${url}`);
  return res;
}

/** A result for the screen: `{ ok: true, ... }`, or `{ ok: false, error }` with a DriverError's code. */
const failed = (error) => {
  if (error instanceof DriverError) return { ok: false, error: error.code };
  throw error;
};

/** NVIDIA's licence for the driver, as Ubuntu publishes it; `changed` if it is not the manifest's. */
async function fetchLicence({ manifest, fetch, signal }) {
  try {
    const res = await get(fetch, manifest.licence.url, signal);
    const body = Buffer.from(await res.arrayBuffer());
    if (sha256(body) !== manifest.licence.sha256) throw new DriverError("changed", "licence");
    return { ok: true, text: body.toString("utf8") };
  } catch (error) {
    return failed(error);
  }
}

/** The owner's recorded acceptance, or null. */
function readAcceptance(dataDir, files = fs) {
  try {
    const record = JSON.parse(files.readFileSync(path.join(dataDir, ACCEPTANCE_FILE), "utf8"));
    return record && typeof record === "object" && typeof record.acceptedAt === "string" ? record : null;
  } catch {
    return null;
  }
}

/** Whether `record` accepts this driver's licence and the current terms. */
const acceptsThis = (record, manifest) =>
  Boolean(
    record &&
    record.driver === manifest.version &&
    record.licenceSha256 === manifest.licence.sha256 &&
    record.terms === TERMS_VERSION,
  );

/**
 * The driver on this PC: where it goes on the games drive (`letter`, null
 * without one), whether every package is there at its size, and the owner's
 * acceptance of this driver's licence and the current terms, if any. Sizes
 * only: installing checked every byte, and Swiff OS checks them again.
 */
function driverState({ manifest, letter, dataDir, files = fs }) {
  const folder = letter ? driverFolder(letter, manifest.version) : null;
  const installed =
    folder !== null &&
    manifest.files.every((f) => {
      try {
        return files.statSync(path.join(folder, f.name)).size === f.size;
      } catch {
        return false;
      }
    });
  const record = readAcceptance(dataDir, files);
  return {
    version: manifest.version,
    bytes: manifest.bytes,
    folder,
    installed,
    accepted: acceptsThis(record, manifest) ? { at: record.acceptedAt } : null,
  };
}

/** The SHA-256 of a file on disk, or null when it cannot be read. */
async function fileSha256(file, files) {
  try {
    const hash = crypto.createHash("sha256");
    for await (const chunk of files.createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

/**
 * Record that the owner accepted NVIDIA's licence for this driver and Swiff's
 * terms, then download every package Ubuntu publishes for it into `folder`,
 * each checked against its SHA-256 before it takes its name. A package already
 * there and whole is kept, so a stopped install picks up where it was.
 * `free` is the games drive's free space in bytes; `onProgress(done, total)`
 * hears how far it is.
 */
async function installDriver({
  manifest,
  folder,
  dataDir,
  free,
  fetch,
  files = fs,
  signal,
  onProgress = () => {},
  now = () => new Date(),
}) {
  try {
    const record = {
      driver: manifest.version,
      licence: manifest.licence.url,
      licenceSha256: manifest.licence.sha256,
      terms: TERMS_VERSION,
      acceptedAt: now().toISOString(),
    };
    try {
      files.mkdirSync(dataDir, { recursive: true });
      files.writeFileSync(path.join(dataDir, ACCEPTANCE_FILE), `${JSON.stringify(record, null, 2)}\n`);
      files.mkdirSync(folder, { recursive: true });
    } catch (error) {
      throw new DriverError("write", error instanceof Error ? error.message : String(error));
    }
    let done = 0;
    const todo = [];
    for (const f of manifest.files) {
      if ((await fileSha256(path.join(folder, f.name), files)) === f.sha256) done += f.size;
      else todo.push(f);
    }
    const left = manifest.bytes - done;
    if (typeof free === "number" && free < left + SPARE_BYTES) throw new DriverError("space", String(left));
    onProgress(done, manifest.bytes);
    for (const f of todo) {
      if (signal?.aborted) throw new DriverError("cancelled");
      const target = path.join(folder, f.name);
      const part = `${target}.part`;
      const res = await get(fetch, `${manifest.mirror}/${f.path}`, signal);
      const hash = crypto.createHash("sha256");
      let size = 0;
      let out;
      try {
        out = await files.promises.open(part, "w");
      } catch (error) {
        throw new DriverError("write", error instanceof Error ? error.message : String(error));
      }
      try {
        for await (const chunk of res.body) {
          if (signal?.aborted) throw new DriverError("cancelled");
          const bytes = Buffer.from(chunk);
          hash.update(bytes);
          size += bytes.length;
          if (size > f.size) throw new DriverError("changed", f.name);
          try {
            await out.write(bytes);
          } catch (error) {
            throw new DriverError("write", error instanceof Error ? error.message : String(error));
          }
          onProgress(done + size, manifest.bytes);
        }
        await out.close();
      } catch (error) {
        await out.close().catch(() => {});
        files.rmSync(part, { force: true });
        if (error instanceof DriverError) throw error;
        throw new DriverError(signal?.aborted ? "cancelled" : "offline", String(error));
      }
      if (size !== f.size || hash.digest("hex") !== f.sha256) {
        files.rmSync(part, { force: true });
        throw new DriverError("changed", f.name);
      }
      try {
        files.renameSync(part, target);
      } catch (error) {
        throw new DriverError("write", error instanceof Error ? error.message : String(error));
      }
      done += f.size;
    }
    onProgress(manifest.bytes, manifest.bytes);
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/** Delete the driver from the games drive, and the owner's acceptance with it. */
function removeDriver({ folder, dataDir, files = fs }) {
  try {
    files.rmSync(folder, { recursive: true, force: true });
    files.rmSync(path.join(dataDir, ACCEPTANCE_FILE), { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: "write", detail: String(error) };
  }
}

module.exports = {
  MANIFEST_FILE,
  ACCEPTANCE_FILE,
  TERMS_VERSION,
  SPARE_BYTES,
  NVIDIA_FIRST_SUPPORTED,
  supportedCard,
  parseManifest,
  readManifest,
  driverFolder,
  fetchLicence,
  readAcceptance,
  driverState,
  installDriver,
  removeDriver,
};
