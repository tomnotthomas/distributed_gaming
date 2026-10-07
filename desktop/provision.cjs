// What this app hands Lanterel OS so its agent (swiff-hostd) can offer the PC:
// the platform's address, the machine id and the machine key. The installer's
// elevated worker writes it as one record, raw, at the start of Lanterel OS's
// keep partition, when it installs Lanterel OS and each time it restarts the PC
// into it (the plans' `provision` op). Lanterel OS reads it at its next start,
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

const crypto = require("node:crypto");

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
 * The record for `provisioning` ({ serverUrl, machineId, machineKey }), as
 * Lanterel OS reads it: RECORD_BYTES bytes. Throws when a field is not one
 * Lanterel OS would take, never quoting the machine key.
 */
function provisionRecord({ serverUrl, machineId, machineKey }) {
  const problem = machineProblem({ serverUrl, machineId });
  if (problem) throw new Error(problem);
  if (typeof machineKey !== "string" || !MACHINE_KEY.test(machineKey))
    throw new Error("This PC has no machine key Lanterel OS can use: paste it in Settings again.");
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

module.exports = { RECORD_BYTES, RECORD_MAGIC, RECORD_VERSION, machineProblem, provisionRecord };
