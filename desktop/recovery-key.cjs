// The BitLocker recovery key, before anything changes what the PC starts.
//
// A drive BitLocker protects asks for its recovery key when a start looks
// different to the TPM than the one it was sealed to. Rental mode changes the
// boot (an entry, BootNext, MokManager's blue screen), and suspends BitLocker
// on C: for those restarts, but a firmware that falls through into Windows, or
// an owner who chooses Continue boot, can still meet that screen. So before
// the first boot change the owner saves the key somewhere they can reach from
// another device (their Microsoft account, a file, or paper) and says so.
//
// Swiff never reads, sends or keeps the key. What is kept, in the app's own
// user data, is only that the owner said they saved it, for which drives, and
// when: a drive BitLocker protects later asks again.

const fs = require("node:fs");
const path = require("node:path");

/** Where Microsoft keeps the recovery keys a Microsoft account backed up: opened on another device. */
const ACCOUNT_URL = "https://aka.ms/myrecoverykey";

/** What was saved, checked; null when nothing was. */
function savedOf(raw) {
  if (!raw || typeof raw !== "object" || !Number.isFinite(raw.at) || !Array.isArray(raw.drives)) return null;
  return { at: raw.at, drives: raw.drives.filter((l) => typeof l === "string" && /^[A-Z]$/.test(l)) };
}

/**
 * Whether the owner still has to save a recovery key: `drives` are the drives
 * BitLocker protects now (rental.cjs bitlockerDrives). Saved means every one
 * of them was in the owner's word.
 */
function recoveryOf(saved, drives) {
  const missing = drives.filter((l) => !saved?.drives.includes(l));
  return { drives: [...drives], saved: missing.length === 0, at: saved?.at ?? null };
}

/** The confirmation's file in `dir` (the app's user data). Never a key: only which drives, and when. */
function recoveryStore(dir, files = fs) {
  const file = path.join(dir, "bitlocker-recovery.json");
  return {
    read() {
      try {
        return savedOf(JSON.parse(files.readFileSync(file, "utf8")));
      } catch {
        return null;
      }
    },
    /** The owner said they saved the recovery key of each of `drives`, at `at`. */
    saved(drives, at) {
      const before = this.read()?.drives ?? [];
      const all = [...new Set([...before, ...drives])].filter((l) => /^[A-Z]$/.test(l)).sort();
      files.mkdirSync(dir, { recursive: true });
      files.writeFileSync(file, `${JSON.stringify({ at, drives: all })}\n`);
    },
  };
}

/**
 * Windows' own place to back the key up: Control Panel's BitLocker page,
 * where Back up your recovery key offers the Microsoft account, a file and
 * printing. Windows Home has no such page: Device encryption backs the key up
 * to the Microsoft account by itself, so the app sends the owner there instead.
 */
const BITLOCKER_PANEL = { file: "control.exe", args: ["/name", "Microsoft.BitLockerDriveEncryption"] };

module.exports = { ACCOUNT_URL, BITLOCKER_PANEL, savedOf, recoveryOf, recoveryStore };
