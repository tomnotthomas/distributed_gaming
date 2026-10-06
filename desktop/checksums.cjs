// SHA-256 of what Swiff publishes for hosts: the host app's installer and the
// Swiff OS image set. The release step makes them; the website's download page
// shows them as text (web/src/swiff/release.json), so an owner can check a
// download with Windows' own Get-FileHash before running it.
//
//   node checksums.cjs sums <SHA256SUMS> <file>...
//       each file's SHA-256, as sha256sum prints it, into SHA256SUMS
//   node checksums.cjs release <release.json> [--host <file>] [--url <url>] [--image <dir>]
//       what the download page shows: the installer's name, its SHA-256 and
//       size (and where it is downloaded from, once that is published), and
//       Swiff OS's version with each file of its set (from the set's
//       SHA256SUMS, which image-set.sh writes)

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const HEX = /^[0-9a-f]{64}$/;

/** A file's SHA-256 and size, read in chunks: the image set's are gigabytes. */
function sumOf(file, files = fs) {
  const hash = crypto.createHash("sha256");
  const buf = Buffer.alloc(4 * 1024 * 1024);
  const fd = files.openSync(file, "r");
  let bytes = 0;
  try {
    for (let n; (n = files.readSync(fd, buf, 0, buf.length, null)) > 0; bytes += n)
      hash.update(buf.subarray(0, n));
  } finally {
    files.closeSync(fd);
  }
  return { name: path.basename(file), sha256: hash.digest("hex"), bytes };
}

/** Lines as sha256sum prints them (two spaces: text mode), which `sha256sum -c` checks. */
const sumsText = (sums) => sums.map((s) => `${s.sha256}  ${s.name}\n`).join("");

/** A SHA256SUMS file's entries; a line that is not one is refused, never skipped. */
function parseSums(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) => {
      const m = /^([0-9a-f]{64}) [ *](\S.*)$/.exec(line);
      if (!m) throw new Error(`Not a SHA256SUMS line: ${line}`);
      return { name: m[2], sha256: m[1] };
    });
}

/**
 * Whether `url` is a public download address the page may show: https, with a
 * host, and nothing that could carry a credential (no user name or password,
 * no query string, no fragment).
 */
function httpsUrl(url) {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      u.hostname !== "" &&
      u.username === "" &&
      u.password === "" &&
      u.search === "" &&
      u.hash === "" &&
      !/[?#@]/.test(url)
    );
  } catch {
    return false;
  }
}

/**
 * What the download page shows (web/src/swiff/release.json): `host` the
 * installer's sum, with the address it is published at or null; `image` the
 * image set's version and its files' sums.
 */
function releaseOf({ host = null, url = null, image = null } = {}) {
  if (url !== null && !httpsUrl(url))
    throw new Error("--url takes a public https:// address, with no user name, password, query or fragment.");
  if (host && !HEX.test(host.sha256)) throw new Error("Not a SHA-256.");
  return {
    host: host ? { file: host.name, sha256: host.sha256, bytes: host.bytes, url } : null,
    image: image
      ? {
          version: image.version,
          files: image.files.map(({ name, sha256 }) => {
            if (!HEX.test(sha256)) throw new Error(`Not a SHA-256 for ${name}.`);
            return { name, sha256 };
          }),
        }
      : null,
  };
}

/** The image set in `dir`: its version from the manifest, its files from its SHA256SUMS. */
function imageSums(dir, files = fs) {
  const manifest = JSON.parse(files.readFileSync(path.join(dir, "swiffos.json"), "utf8"));
  return {
    version: String(manifest.version),
    files: parseSums(files.readFileSync(path.join(dir, "SHA256SUMS"), "utf8")),
  };
}

/** The command line's words and --name value pairs; a --name with no value after it is refused. */
function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) out._.push(args[i]);
    else if (i + 1 < args.length && !args[i + 1].startsWith("--")) out[args[i].slice(2)] = args[++i];
    else throw new Error(`${args[i]} takes a value.`);
  }
  return out;
}

/** The command line: `sums` writes SHA256SUMS, `release` writes the download page's release.json. */
function main([cmd, ...rest]) {
  const opts = flags(rest);
  if (cmd === "sums" && opts._.length >= 2) {
    const [out, ...list] = opts._;
    const sums = list.map((f) => sumOf(f));
    fs.writeFileSync(out, sumsText(sums));
    process.stdout.write(sumsText(sums));
    return;
  }
  if (cmd === "release" && opts._.length === 1) {
    const release = releaseOf({
      host: opts.host ? sumOf(opts.host) : null,
      url: opts.url ?? null,
      image: opts.image ? imageSums(opts.image) : null,
    });
    fs.writeFileSync(opts._[0], `${JSON.stringify(release, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(release, null, 2)}\n`);
    return;
  }
  console.error(
    "usage: checksums.cjs sums <SHA256SUMS> <file>... | release <release.json> [--host <file>] [--url <url>] [--image <dir>]",
  );
  process.exitCode = 2;
}

module.exports = { sumOf, sumsText, parseSums, releaseOf, imageSums, flags };

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`checksums: ${error.message}`);
    process.exitCode = 1;
  }
}
