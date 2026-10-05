// Swiff's key, as far as this app can know it. Whether shim's MokManager
// enrolled the key cannot be read from Windows: MokList is a boot-time
// variable, and shim publishes MokListRT only to what it starts, never to
// Windows Boot Manager. So the app remembers what it queued and when, and
// after the restart asks the owner what the blue screen did.
//
//   queued     a request with this code waits for the next restart
//   ask        the PC restarted since: only the owner knows whether the code went in
//   confirmed  the owner said it did
//   missed     the owner said it did not: a new code is the way on
//   timedout   Windows started in the same power-on as MokManager, twice over: the
//              10 seconds passed, the request was used up, shim fell back to
//              MokManager and on into Windows (Continue boot)
//   nokey      Windows started in the same power-on as shim, after one MokManager
//   blocked    the firmware refused shim itself (a Secure Boot violation): shim
//              never ran, so it never measured its MOK list
//
// The last two come from Windows' own measured-boot log of this start (TCG,
// one file per boot, readable without administrator rights): a clean restart
// into Windows never has Swiff's shim or MokManager in it.
//
// The code is kept in the owner's own app data until it is used up. It only
// works at the PC's keyboard, at the blue screen, once.

const fs = require("node:fs");
const path = require("node:path");

/** @typedef {{ code: string | null, queuedAt: number | null, answer: "yes" | "no" | null }} SavedKey */

/** What was saved, checked; null when nothing was. */
function savedOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const code = typeof raw.code === "string" && /^\d{8}$/.test(raw.code) ? raw.code : null;
  const queuedAt = Number.isFinite(raw.queuedAt) ? raw.queuedAt : null;
  const answer = raw.answer === "yes" || raw.answer === "no" ? raw.answer : null;
  if (!code && !answer) return null;
  return { code, queuedAt, answer };
}

/**
 * Where the key stands, from what was saved and when this PC last started
 * (`bootAt`, ms). A request queued before this start has met its blue screen.
 */
function keyOf(saved, bootAt, trail = null) {
  if (!saved) return null;
  if (saved.answer === "yes") return { state: "confirmed", code: null };
  if (saved.answer === "no") return { state: "missed", code: null };
  if (!saved.code || saved.queuedAt === null) return null;
  if (saved.queuedAt > bootAt) return { state: "queued", code: saved.code };
  // This start's own log, written after the request: Windows came up straight after shim.
  if (trail && trail.at >= saved.queuedAt && (trail.shim || trail.mokManager)) {
    if (trail.mokManager >= 2) return { state: "timedout", code: null };
    // shim never measured its MOK list: the firmware refused to start it.
    if (!trail.mokManager && !trail.mokList) return { state: "blocked", code: null };
    return { state: "nokey", code: null };
  }
  return { state: "ask", code: null };
}

/** Where Windows keeps one TCG log per start. */
const MEASURED_BOOT = String.raw`C:\Windows\Logs\MeasuredBoot`;

/** How often `needle` (lower case) is in `text`. */
const countIn = (text, needle) => text.split(needle).length - 1;

/**
 * What this start's measured-boot log says ran before Windows in the same
 * power-on: Swiff's shim, and how often MokManager. Null where there is no
 * log to read (off Windows, or none written).
 */
function bootTrail(dir = MEASURED_BOOT, files = fs) {
  try {
    const logs = files
      .readdirSync(dir)
      .filter((n) => /\.log$/i.test(n))
      .map((n) => ({ file: path.join(dir, n), at: files.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    if (!logs.length) return null;
    const bytes = files.readFileSync(logs[0].file);
    // Device paths are UTF-16: read at both byte alignments, in any case.
    const text = [bytes.toString("utf16le"), bytes.subarray(1).toString("utf16le")].join("\n").toLowerCase();
    return {
      at: logs[0].at,
      shim: countIn(text, "\\efi\\swiff\\shimx64.efi") > 0,
      mokManager: countIn(text, "mmx64.efi"),
      mokList: countIn(text, "moklist") > 0,
    };
  } catch {
    return null;
  }
}

/** The key's file in `dir` (the app's user data): read, saved, and answered. */
function keyStore(dir, files = fs) {
  const file = path.join(dir, "rental-key.json");
  const read = () => {
    try {
      return savedOf(JSON.parse(files.readFileSync(file, "utf8")));
    } catch {
      return null;
    }
  };
  const write = (saved) => {
    files.mkdirSync(dir, { recursive: true });
    files.writeFileSync(file, `${JSON.stringify(saved)}\n`);
  };
  return {
    read,
    /** A request with `code` was queued at `at`: the next restart shows it. */
    queued: (code, at) => write({ code, queuedAt: at, answer: null }),
    /** The owner's word on the blue screen, once the PC restarted. */
    answer: (yes) => write({ code: null, queuedAt: null, answer: yes ? "yes" : "no" }),
    /** Swiff OS is gone, or never was: nothing to remember. */
    forget: () => files.rmSync(file, { force: true }),
  };
}

module.exports = { savedOf, keyOf, keyStore, bootTrail };
