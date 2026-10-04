// The UEFI firmware's measured-boot event log (Linux:
// /sys/kernel/security/tpm0/binary_bios_measurements), in the crypto-agile
// format of the TCG PC Client Platform Firmware Profile: little-endian, one
// SHA-1-format header event naming the banks, then one event per extend with a
// digest per bank.
//
// The log says what each extend was; only the quote proves the PCRs. So the
// verifier replays the log's SHA-256 digests and compares the result with the
// quoted PCRs, and only then believes what the log says. Even then an event's
// data is believed only where the digest is the hash of that data: firmware is
// free to log any data beside a digest, and only the digest went into the PCR.

import { createHash } from "node:crypto";

export class EventLogError extends Error {
  override name = "EventLogError";
}

const TPM_ALG_SHA256 = 0x000b;

export const EV = {
  NO_ACTION: 0x00000003,
  SEPARATOR: 0x00000004,
  EFI_VARIABLE_DRIVER_CONFIG: 0x80000001,
  EFI_BOOT_SERVICES_APPLICATION: 0x80000003,
  EFI_ACTION: 0x80000007,
} as const;

/** One extend: which PCR, what kind of event, its SHA-256 digest, and the data the firmware logged. */
export type Event = { pcr: number; type: number; sha256: Buffer; data: Buffer };

/** The SHA-256 bank of a parsed log: every extend, and where PCR 0 started. */
export type EventLog = { events: Event[]; startupLocality: number };

/** EFI_GLOBAL_VARIABLE, as it is laid out in memory (the first three fields little-endian). */
const EFI_GLOBAL_VARIABLE = Buffer.from("61dfe48bca93d211aa0d00e098032b8c", "hex");
const SPEC_ID = Buffer.from("Spec ID Event03\0", "latin1");
const STARTUP_LOCALITY = Buffer.from("StartupLocality\0", "latin1");

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest();

/** Parse a crypto-agile event log. A SHA-1-only log, or one with no SHA-256 bank, is an EventLogError. */
export function parseEventLog(log: Buffer): EventLog {
  let offset = 0;
  const take = (n: number) => {
    if (n < 0 || offset + n > log.length) throw new EventLogError("truncated");
    const out = log.subarray(offset, offset + n);
    offset += n;
    return out;
  };
  const u16 = () => take(2).readUInt16LE(0);
  const u32 = () => take(4).readUInt32LE(0);

  // The header: a TCG_PCR_EVENT whose data is the Spec ID event.
  u32(); // pcr
  if (u32() !== EV.NO_ACTION) throw new EventLogError("no Spec ID event");
  take(20);
  const spec = take(u32());
  if (spec.length < 29 || !spec.subarray(0, 16).equals(SPEC_ID)) throw new EventLogError("not crypto-agile");
  const banks = new Map<number, number>();
  const count = spec.readUInt32LE(24);
  if (count > 16 || spec.length < 28 + count * 4) throw new EventLogError("bad Spec ID event");
  for (let i = 0; i < count; i++) banks.set(spec.readUInt16LE(28 + i * 4), spec.readUInt16LE(30 + i * 4));
  if (banks.get(TPM_ALG_SHA256) !== 32) throw new EventLogError("no SHA-256 bank");

  const events: Event[] = [];
  let startupLocality = 0;
  while (offset < log.length) {
    const pcr = u32();
    const type = u32();
    const digests = u32();
    if (digests > 16) throw new EventLogError("too many digests");
    let digest: Buffer | null = null;
    for (let i = 0; i < digests; i++) {
      const alg = u16();
      const size = banks.get(alg);
      if (size === undefined) throw new EventLogError("digest of a bank the header does not name");
      const value = Buffer.from(take(size));
      if (alg === TPM_ALG_SHA256) digest = value;
    }
    const data = Buffer.from(take(u32()));
    if (type === EV.NO_ACTION) {
      // Never extended. One kind matters: the locality PCR 0 started at.
      if (pcr === 0 && data.length >= 17 && data.subarray(0, 16).equals(STARTUP_LOCALITY)) {
        startupLocality = data.readUInt8(16);
      }
      continue;
    }
    if (pcr > 23) throw new EventLogError("no such PCR");
    if (!digest) throw new EventLogError("an event without a SHA-256 digest");
    events.push({ pcr, type, sha256: digest, data });
  }
  return { events, startupLocality };
}

/** The SHA-256 PCRs the log's extends add up to, for every PCR in `pcrs`. */
export function replay(log: EventLog, pcrs: readonly number[]): Map<number, Buffer> {
  const values = new Map<number, Buffer>();
  for (const pcr of pcrs) {
    const start = Buffer.alloc(32);
    if (pcr === 0) start[31] = log.startupLocality;
    values.set(pcr, start);
  }
  for (const event of log.events) {
    const value = values.get(event.pcr);
    if (value) values.set(event.pcr, sha256(Buffer.concat([value, event.sha256])));
  }
  return values;
}

/** What a replayed log says about the boot, from events whose data matches their digest. */
export type BootFacts = {
  /** The firmware logged UEFI events: booted by UEFI, not a legacy BIOS. */
  uefi: boolean;
  /** The SecureBoot variable, as measured into PCR 7, was 1. */
  secureBoot: boolean;
  /** The firmware logged that it booted with pre-boot DMA protection off. */
  dmaProtectionDisabled: boolean;
  /** The Authenticode digests of every boot application measured into PCR 4, in order. */
  bootApplications: Buffer[];
};

export function bootFacts(log: EventLog): BootFacts {
  let secureBoot = false;
  let dmaProtectionDisabled = false;
  const bootApplications: Buffer[] = [];
  for (const event of log.events) {
    if (event.pcr === 4 && event.type === EV.EFI_BOOT_SERVICES_APPLICATION) {
      bootApplications.push(event.sha256);
    }
    if (event.pcr !== 7) continue;
    if (event.type === EV.EFI_VARIABLE_DRIVER_CONFIG) {
      const variable = readVariable(event.data);
      // The profile hashes the whole UEFI_VARIABLE_DATA; some firmware hashes
      // only the value. Either binds the data to what was extended.
      if (
        variable &&
        variable.guid.equals(EFI_GLOBAL_VARIABLE) &&
        variable.name === "SecureBoot" &&
        (event.sha256.equals(sha256(event.data)) || event.sha256.equals(sha256(variable.value)))
      ) {
        secureBoot = variable.value.length === 1 && variable.value[0] === 1;
      }
    }
    if (
      event.type === EV.EFI_ACTION &&
      event.sha256.equals(sha256(event.data)) &&
      event.data.toString("latin1") === "DMA Protection Disabled"
    ) {
      dmaProtectionDisabled = true;
    }
  }
  return {
    uefi: log.events.some((event) => event.type >= 0x80000000),
    secureBoot,
    dmaProtectionDisabled,
    bootApplications,
  };
}

/** A UEFI_VARIABLE_DATA: vendor GUID, name and value, or null when it is not one. */
function readVariable(data: Buffer): { guid: Buffer; name: string; value: Buffer } | null {
  if (data.length < 32) return null;
  const nameLength = Number(data.readBigUInt64LE(16));
  const valueLength = Number(data.readBigUInt64LE(24));
  if (32 + nameLength * 2 + valueLength !== data.length) return null;
  return {
    guid: data.subarray(0, 16),
    name: data.subarray(32, 32 + nameLength * 2).toString("utf16le"),
    value: data.subarray(32 + nameLength * 2),
  };
}
