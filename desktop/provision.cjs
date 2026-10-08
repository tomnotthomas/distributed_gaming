// What this app hands Lanterel OS so its agent (swiff-hostd) can offer the PC:
// the platform's address, the machine id and the machine key. The installer's
// elevated worker writes it as one record, raw, at the start of Lanterel OS's
// keep partition, each time it restarts the PC into Lanterel OS (Go live and
// Start once, the plans' `provision` op). Lanterel OS reads it at its next start,
// seals it to this PC's TPM so only a signed Lanterel OS boot of this PC can
// open it, and zeroes the record (swiff-os/hostd/src/provision.ts, which reads
// the same format):
//
//   offset  bytes
//        0      8  "SWIFFPRV"
//        8      4  version, 1 (big-endian)
//       12      4  length of the payload (big-endian)
//       16     32  SHA-256 of the payload
//       48      …  the payload: JSON { "serverUrl", "machineId", "machineKey" }
//                  then zeros, to 4096 bytes
//
// The record carries data only: what Lanterel OS runs comes from its signed
// image. The machine key is never shown in a plan, logged or kept anywhere else.
//
// Until that boot the record is the machine key in the clear on the disk: the
// owner's accepted exception to the review rule against writing secrets to a
// plain-text file, for that window only and with this wipe. So it is zeroed
// (the plans' `unprovision` op) whenever it is left behind: a run that wrote
// it and then failed, an uninstall, and, at this app's next start, a record no
// Lanterel OS boot took in (fateOf). The app notes when it wrote one
// (provisionStore), never what, to know that without administrator rights.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const RECORD_MAGIC = Buffer.from("SWIFFPRV", "ascii");
const RECORD_VERSION = 1;
/** One 4 KiB block: whole sectors on any disk. */
const RECORD_BYTES = 4096;
const HEADER_BYTES = 48;

/** Hosts an unencrypted address may name: the PC itself, where nothing crosses the network. */
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;
/** A machine id the server can name (`npm run machine-key`: no commas, colons or spaces). */
const MACHINE_ID = /^[^\s,:/\\]{1,128}$/;
/** A machine key: printable ASCII, no spaces. */
const MACHINE_KEY = /^[\x21-\x7e]{16,512}$/;

/**
 * Why `serverUrl` and `machineId` cannot be provisioned, or null when they
 * can: a wss:// server (ws:// only on this PC), and a machine id the server can name.
 */
function machineProblem({ serverUrl, machineId }) {
  let url;
  try {
    url = new URL(serverUrl);
  } catch {
    return "The server address is not a ws:// or wss:// address.";
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:")
    return "The server address is not a ws:// or wss:// address.";
  if (url.protocol === "ws:" && !LOOPBACK.test(url.hostname))
    return "The server address must be encrypted (wss://): the machine key travels on it.";
  if (typeof machineId !== "string" || !MACHINE_ID.test(machineId))
    return "The machine id is not one the server knows.";
  return null;
}

/**
 * Why `machineKey` cannot be provisioned, or null when it can: printable
 * ASCII without spaces, 16 to 512 characters. Never quotes the key.
 */
function machineKeyProblem(machineKey) {
  if (typeof machineKey === "string" && MACHINE_KEY.test(machineKey)) return null;
  return "This PC has no machine key Lanterel OS can use: paste it in Settings again.";
}

/**
 * The record for `provisioning` ({ serverUrl, machineId, machineKey }), as
 * Lanterel OS reads it: RECORD_BYTES bytes. Throws when a field is not one
 * Lanterel OS would take, never quoting the machine key.
 */
function provisionRecord({ serverUrl, machineId, machineKey }) {
  const problem = machineProblem({ serverUrl, machineId });
  if (problem) throw new Error(problem);
  const keyProblem = machineKeyProblem(machineKey);
  if (keyProblem) throw new Error(keyProblem);
  const payload = Buffer.from(JSON.stringify({ serverUrl, machineId, machineKey }), "utf8");
  if (payload.length > RECORD_BYTES - HEADER_BYTES) throw new Error("The provisioning is too long.");
  const record = Buffer.alloc(RECORD_BYTES);
  RECORD_MAGIC.copy(record, 0);
  record.writeUInt32BE(RECORD_VERSION, 8);
  record.writeUInt32BE(payload.length, 12);
  crypto.createHash("sha256").update(payload).digest().copy(record, 16);
  payload.copy(record, HEADER_BYTES);
  payload.fill(0);
  return record;
}

/**
 * Whether `block`, the start of the keep, still holds a record: none once
 * Lanterel OS took it in. One whose magic alone is damaged still holds the key.
 */
function holdsRecord(block) {
  if (block.length < HEADER_BYTES) return false;
  if (block.subarray(0, RECORD_MAGIC.length).equals(RECORD_MAGIC)) return true;
  const length = block.readUInt32BE(12);
  if (HEADER_BYTES + length > Math.min(RECORD_BYTES, block.length)) return false;
  const payload = block.subarray(HEADER_BYTES, HEADER_BYTES + length);
  return crypto.createHash("sha256").update(payload).digest().equals(block.subarray(16, HEADER_BYTES));
}

/**
 * The app's note, in `dir` (its user data), of the last record it wrote that
 * may still be on the disk: when, and whether that run finished up to its
 * restart. Never the record, nor the key.
 */
function provisionStore(dir, files = fs) {
  const file = path.join(dir, "rental-provision.json");
  const write = (note) => {
    files.mkdirSync(dir, { recursive: true });
    files.writeFileSync(file, `${JSON.stringify(note)}\n`);
  };
  /** The note, or null when none is left. */
  const read = () => {
    try {
      const { at, done } = JSON.parse(files.readFileSync(file, "utf8"));
      return Number.isFinite(at) ? { at, done: done === true } : null;
    } catch {
      return null;
    }
  };
  return {
    read,
    written: (at) => write({ at, done: false }),
    /** The run that wrote it finished up to its restart. */
    finished: () => {
      const note = read();
      if (note) write({ ...note, done: true });
    },
    forget: () => files.rmSync(file, { force: true }),
  };
}

/**
 * What a run's step event tells the note (provisionStore `store`): a record is
 * written as the provision step starts, and gone once an unprovision step is done.
 */
function provisionEvent(store, event, at) {
  if (event.type !== "step") return;
  if (event.id === "provision" && event.state === "running") store.written(at);
  else if (event.id === "unprovision" && event.state === "done") store.forget();
}

/** Whether a run's outcome (rental-exec.cjs runPlan) left a record behind: it ended short, at or after its provision step. */
const leftRecord = (outcome) =>
  outcome.status !== "done" && (outcome.done.includes("provision") || outcome.failed?.step === "provision");

/**
 * What becomes of a record an earlier run of this app noted (provisionStore),
 * at this app's start, from when this PC last started (`bootAt`, ms) and this
 * start's boot trail (rental-key.cjs bootTrail):
 *
 *   wipe  left behind: a run that did not finish, or a restart since that
 *         went to shim and back to Windows without Lanterel OS's boot loader
 *   wait  Start once or Go live finished, and no restart since is known to
 *         have started Lanterel OS's boot loader (none yet, or a trail that
 *         does not show it): the note stays, for Lanterel OS to take the
 *         record in, or a cancel, the uninstall or the next Go live to cover it
 *   gone  this power-on started Lanterel OS's boot loader and then Windows,
 *         so Lanterel OS cannot have taken the record in: the app wipes it
 *         (wipesAtStart)
 *
 * The trail is this power-on's measured-boot log only: a PC that lost power
 * after Lanterel OS's boot loader started and before swiff-provision ran
 * gives `wait` at the next Windows start, and the record stays until a
 * cancel, the uninstall or the next Go live wipes it.
 */
function fateOf(note, bootAt, trail = null) {
  if (!note.done) return "wipe";
  if (note.at > bootAt || !trail || trail.at < note.at) return "wait";
  if (trail.loader) return "gone";
  return trail.shim && trail.windowsAfterShim ? "wipe" : "wait";
}

/**
 * Whether the app's start runs the elevated wipe for a note's `fate`: every
 * fate but `wait`. On `gone` Windows followed Lanterel OS's boot loader in
 * the same power-on, so swiff-provision cannot have taken the record in; the
 * worker's `unprovision` zeroes only a record still there.
 */
const wipesAtStart = (fate) => fate !== "wait";

/** Zero a record left behind through the elevated worker's `apply`, then forget it; false when that failed. */
async function wipeRecord(apply, store) {
  try {
    await apply({ op: "unprovision" }, () => {});
  } catch {
    return false;
  }
  store.forget();
  return true;
}

module.exports = {
  RECORD_BYTES,
  RECORD_MAGIC,
  RECORD_VERSION,
  fateOf,
  holdsRecord,
  leftRecord,
  machineKeyProblem,
  machineProblem,
  provisionEvent,
  provisionRecord,
  provisionStore,
  wipeRecord,
  wipesAtStart,
};
