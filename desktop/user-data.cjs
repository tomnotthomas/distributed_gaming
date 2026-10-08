// Lanterel Host's own user data: %APPDATA%\Lanterel Host. Swiff Host, and
// Lanterel Host 0.1.0, kept theirs in %APPDATA%\@swiff\desktop (named after the
// package), and Electron's single-instance lock goes with the user data: an old
// Swiff Host still running took the new app's launch. The first start copies
// over what the app keeps there, once, and leaves the old folder as it is, for
// an old Swiff Host that may still use it.

const fs = require("node:fs");
const path = require("node:path");

/**
 * What the app keeps in its user data: the machine key, and Chromium's Local
 * State with the OS key that sealed it (and the stores' codes); the window's
 * settings (Local Storage); the rental stores and notes; and the image set.
 */
const KEPT = [
  "Local State",
  "Local Storage",
  "machine-key.bin",
  "error-reports.json",
  "rental-key.json",
  "rental-removal.json",
  "rental-provision.json",
  "bitlocker-recovery.json",
  "rental-reports",
  "swiff-os",
];
/** Written once the copy ran, so a key or note the new app wiped never comes back from the old folder. */
const MOVED = "moved-from-swiff-host";

/** The app's user data under `appData` (Electron's appData path), and the old one. */
const userDataOf = (appData) => ({
  dir: path.join(appData, "Lanterel Host"),
  old: path.join(appData, "@swiff", "desktop"),
});

/**
 * Copy `src` to `dest`, keeping what `dest` has. The image set's files are
 * linked, not copied: they are gigabytes, and the download only ever renames a
 * finished file into place. Its unfinished parts, which it appends to, and
 * Local Storage's LOCK, which a running Swiff Host holds, stay behind.
 */
function copyInto(src, dest, link, files) {
  const name = path.basename(src);
  if (name === ".download" || name === "LOCK") return;
  if (files.statSync(src).isDirectory()) {
    files.mkdirSync(dest, { recursive: true });
    for (const n of files.readdirSync(src)) copyInto(path.join(src, n), path.join(dest, n), link, files);
  } else if (!files.existsSync(dest)) {
    try {
      if (!link) throw new Error("copy");
      files.linkSync(src, dest);
    } catch {
      files.copyFileSync(src, dest);
    }
  }
}

/** Copy what the app keeps from `old` into `dir`, once: false when it had already run. Anything unreadable stays behind. */
function moveUserData({ dir, old }, files = fs) {
  if (files.existsSync(path.join(dir, MOVED))) return false;
  files.mkdirSync(dir, { recursive: true });
  for (const name of KEPT) {
    try {
      const src = path.join(old, name);
      if (files.existsSync(src)) copyInto(src, path.join(dir, name), name === "swiff-os", files);
    } catch {
      // That one starts afresh.
    }
  }
  files.writeFileSync(path.join(dir, MOVED), `${new Date().toISOString()}\n`);
  return true;
}

module.exports = { KEPT, userDataOf, moveUserData };
