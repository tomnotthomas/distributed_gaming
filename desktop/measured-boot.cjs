// What the firmware did before this Windows start, from Windows' own copy of
// the TPM's event log (TCG, one file per start in C:\Windows\Logs\MeasuredBoot,
// readable without administrator rights). Rental mode reads two things there:
//
//   the Secure Boot db   the firmware measures the whole db into PCR 7 on every
//                        start, so whether it trusts the CA that signs Swiff OS's
//                        shim is read here, without a trip to the BIOS
//   the boot trail       which EFI programs the firmware started, in order. A
//                        start that went through Swiff's shim (and MokManager)
//                        and then into Windows, in the same power-on, is the one
//                        that changes PCR 7: Windows Hello's PIN and BitLocker
//                        are sealed to it. A clean restart into Windows never has
//                        shim in it.
//
// Only events of the right type count: the firmware also measures every
// Boot#### variable (PCR 1), and Swiff OS's names shim's path, so a plain
// search of the file would find shim in every start.
//
// Pure, apart from lastLog, which reads the folder.

const fs = require("node:fs");
const path = require("node:path");
const { parseDevicePath } = require("./efi.cjs");

const EV = {
  NO_ACTION: 0x03,
  IPL: 0x0d,
  VARIABLE_DRIVER_CONFIG: 0x80000001,
  BOOT_SERVICES_APPLICATION: 0x80000003,
  VARIABLE_AUTHORITY: 0x800000e0,
};

/** The digest sizes the log's Spec ID event lists, by algorithm id; null for a SHA-1-only log. */
function specOf(data) {
  if (data.length < 32 || data.subarray(0, 15).toString("latin1") !== "Spec ID Event03") return null;
  const count = data.readUInt32LE(24);
  const sizes = new Map();
  for (let i = 0; i < count; i++) sizes.set(data.readUInt16LE(28 + 4 * i), data.readUInt16LE(30 + 4 * i));
  return sizes;
}

/**
 * A TCG event log's events, `{ pcr, type, data }`, in order: the crypto-agile
 * format Windows writes, or the old SHA-1 one. Stops at the first event that
 * does not parse.
 */
function parseLog(bytes) {
  const b = Buffer.from(bytes);
  const events = [];
  if (b.length < 32) return events;
  // The first event is always in the SHA-1 format.
  const firstSize = b.readUInt32LE(28);
  const first = b.subarray(32, 32 + firstSize);
  const sizes = specOf(first);
  events.push({ pcr: b.readUInt32LE(0), type: b.readUInt32LE(4), data: first });
  let at = 32 + firstSize;
  while (at + 12 <= b.length) {
    const pcr = b.readUInt32LE(at);
    const type = b.readUInt32LE(at + 4);
    let p = at + 8;
    if (sizes) {
      const count = b.readUInt32LE(p);
      p += 4;
      let ok = true;
      for (let i = 0; i < count && ok; i++) {
        const size = p + 2 <= b.length ? sizes.get(b.readUInt16LE(p)) : undefined;
        if (size === undefined) ok = false;
        else p += 2 + size;
      }
      if (!ok) break;
    } else p += 20;
    if (p + 4 > b.length) break;
    const size = b.readUInt32LE(p);
    if (p + 4 + size > b.length) break;
    events.push({ pcr, type, data: b.subarray(p + 4, p + 4 + size) });
    at = p + 4 + size;
  }
  return events;
}

/** A UEFI_VARIABLE_DATA event's variable: its name and bytes. */
function variableOf(data) {
  if (data.length < 32) return null;
  const nameLength = Number(data.readBigUInt64LE(16));
  const dataLength = Number(data.readBigUInt64LE(24));
  const end = 32 + nameLength * 2;
  if (end + dataLength > data.length) return null;
  return { name: data.subarray(32, end).toString("utf16le"), data: data.subarray(end, end + dataLength) };
}

/** The file a UEFI_IMAGE_LOAD_EVENT started, as its device path names it; null when it names none. */
function imageOf(data) {
  if (data.length < 32) return null;
  const length = Number(data.readBigUInt64LE(24));
  return parseDevicePath(data.subarray(32, 32 + length)).file;
}

/** Whether `name` (a CA's common name) is among the certificates of the db this start measured; null when it was not measured. */
function dbTrusts(events, name) {
  const db = events
    .filter((e) => e.type === EV.VARIABLE_DRIVER_CONFIG && e.pcr === 7)
    .map((e) => variableOf(e.data))
    .find((v) => v?.name === "db");
  if (!db) return null;
  // A certificate's subject holds its common name as plain ASCII (PrintableString or UTF8String).
  return db.data.includes(Buffer.from(name, "latin1"));
}

const ends = (file, tail) => file.toLowerCase().replace(/\//g, "\\").endsWith(tail);

/**
 * The EFI programs the firmware started this power-on, in order, and what that
 * says about Swiff's shim: whether it ran, how often MokManager did, whether
 * shim started Swiff's own boot loader (it can only once Swiff's key is
 * enrolled), and whether Windows Boot Manager came after shim.
 */
function trailOf(events) {
  const apps = events
    .filter((e) => e.type === EV.BOOT_SERVICES_APPLICATION)
    .map((e) => imageOf(e.data))
    .filter(Boolean);
  const shimAt = apps.findIndex((f) => ends(f, "\\efi\\swiff\\shimx64.efi"));
  const after = shimAt < 0 ? [] : apps.slice(shimAt + 1);
  return {
    apps,
    shim: shimAt >= 0,
    mokManager: after.filter((f) => ends(f, "\\mmx64.efi")).length,
    loader: after.some((f) => ends(f, "\\efi\\swiff\\grubx64.efi")),
    windowsAfterShim: after.some((f) => ends(f, "\\bootmgfw.efi")),
  };
}

/** Where Windows keeps one TCG log per start. */
const MEASURED_BOOT = String.raw`C:\Windows\Logs\MeasuredBoot`;

/** This start's log, the newest in `dir`, and when it was written; null when there is none to read. */
function lastLog(dir = MEASURED_BOOT, files = fs) {
  try {
    const logs = files
      .readdirSync(dir)
      .filter((n) => /\.log$/i.test(n))
      .map((n) => ({ file: path.join(dir, n), at: files.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    if (!logs.length) return null;
    return { at: logs[0].at, events: parseLog(files.readFileSync(logs[0].file)) };
  } catch {
    return null;
  }
}

module.exports = { EV, parseLog, variableOf, imageOf, dbTrusts, trailOf, lastLog, MEASURED_BOOT };
