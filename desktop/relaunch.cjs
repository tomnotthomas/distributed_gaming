// Lanterel Host again after a restart it asked for. The key's blue screen,
// Remove Lanterel OS and Start Lanterel OS each end at a restart, and the
// owner must not be left at a Windows desktop with nothing on it: before that
// restart the app asks Windows, for this user only, to open it once at the
// next sign-in (HKCU's RunOnce, which Windows clears as it runs it). It opens
// with --after-restart, straight at the step after the restart.
//
// Whether that restart is still ahead is kept in the app's own user data, as
// when it was asked for: a start after it (whether Windows opened the app, or
// the owner did first) clears what is left, and a start before it (the app
// quit and opened again while the restart still waits) keeps it.

const fs = require("node:fs");
const path = require("node:path");

/** Windows' list of what to open once at this user's next sign-in. */
const RUN_ONCE = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce`;
/** Lanterel Host's entry in it. */
const VALUE = "LanterelHost";
/** What the app is opened with after the restart. */
const AFTER_RESTART = "--after-restart";

/** One quoted argument of a Windows command line; paths and switches here carry no quotes. */
const quoted = (arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, "")}"` : arg);

/**
 * The command Windows runs at the next sign-in: this app's exe (the portable
 * exe the owner started, not the copy it unpacked into Temp, which is gone by
 * then), its folder when it runs unpackaged (`electron .`), --after-restart,
 * and the switches in `carry` (a test build's remote debugging).
 */
function relaunchCommand({ exe, appPath = null, carry = [] }) {
  return [`"${exe}"`, ...(appPath ? [quoted(appPath)] : []), AFTER_RESTART, ...carry.map(quoted)].join(" ");
}

/** What was saved, checked; null when nothing was. */
function savedOf(raw) {
  if (!raw || typeof raw !== "object" || !Number.isFinite(raw.at)) return null;
  return { at: raw.at };
}

/**
 * At start, what to do with what is armed: `keep` while its restart is still
 * ahead (armed after this start, at `bootAt` ms), `clear` once it is behind,
 * null when nothing is armed.
 */
const relaunchAtStart = (saved, bootAt) => (!saved ? null : saved.at > bootAt ? "keep" : "clear");

/**
 * The relaunch: Windows' entry, set and cleared with `run(file, args)` (reg.exe,
 * no administrator rights: the key is this user's own), and when it was set,
 * in `dir` (the app's user data).
 */
function relaunchStore(dir, run, files = fs) {
  const file = path.join(dir, "relaunch.json");
  return {
    read() {
      try {
        return savedOf(JSON.parse(files.readFileSync(file, "utf8")));
      } catch {
        return null;
      }
    },
    /** Open the app with `command` at the next sign-in; `at` is now. Rejects when Windows would not take it. */
    async arm(command, at) {
      await run("reg.exe", ["add", RUN_ONCE, "/v", VALUE, "/t", "REG_SZ", "/d", command, "/f"]);
      files.mkdirSync(dir, { recursive: true });
      files.writeFileSync(file, `${JSON.stringify({ at })}\n`);
    },
    /** Take the entry off again, and its note: an entry already gone (Windows ran it) is fine. */
    async clear() {
      files.rmSync(file, { force: true });
      try {
        await run("reg.exe", ["delete", RUN_ONCE, "/v", VALUE, "/f"]);
      } catch {
        // Not there: Windows ran it at sign-in, or it was never set.
      }
    },
  };
}

module.exports = { AFTER_RESTART, RUN_ONCE, VALUE, relaunchAtStart, relaunchCommand, relaunchStore, savedOf };
