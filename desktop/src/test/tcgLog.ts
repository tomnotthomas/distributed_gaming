// A TCG event log as Windows keeps one per start (C:\Windows\Logs\MeasuredBoot),
// built from a few events for the tests of measured-boot.cjs and rental-key.cjs:
// the crypto-agile format, SHA-1 and SHA-256 digests (zeros: nothing here checks them).

import { GLOBAL, guidBytes, loadOption } from "../../efi.cjs";

const EV_NO_ACTION = 0x03;
export const EV_VARIABLE_DRIVER_CONFIG = 0x80000001;
export const EV_VARIABLE_BOOT = 0x80000002;
export const EV_BOOT_SERVICES_APPLICATION = 0x80000003;

export type LogEvent = { pcr: number; type: number; data: Buffer };

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

/** The Spec ID event: two banks, SHA-1 (20 bytes) and SHA-256 (32). */
function specId(): Buffer {
  return Buffer.concat([
    Buffer.from("Spec ID Event03\0", "latin1"),
    u32(0), // platform class
    Buffer.from([0, 2, 0, 2]), // spec version minor, major, errata, uintn size
    u32(2),
    Buffer.from([0x04, 0x00, 20, 0x00, 0x0b, 0x00, 32, 0x00]),
    Buffer.from([0]), // vendor info size
  ]);
}

/** A whole log: the Spec ID event, then `events` in the crypto-agile format. */
export function tcgLog(events: LogEvent[]): Buffer {
  const spec = specId();
  const head = Buffer.concat([u32(0), u32(EV_NO_ACTION), Buffer.alloc(20), u32(spec.length), spec]);
  return Buffer.concat([
    head,
    ...events.map((e) =>
      Buffer.concat([
        u32(e.pcr),
        u32(e.type),
        u32(2),
        Buffer.from([0x04, 0x00]),
        Buffer.alloc(20),
        Buffer.from([0x0b, 0x00]),
        Buffer.alloc(32),
        u32(e.data.length),
        e.data,
      ]),
    ),
  ]);
}

/** A UEFI_VARIABLE_DATA event of `name` holding `data`. */
export function variable(type: number, pcr: number, name: string, data: Buffer, guid = GLOBAL): LogEvent {
  const n = Buffer.from(name, "utf16le");
  return {
    pcr,
    type,
    data: Buffer.concat([guidBytes(guid), u64(name.length), u64(data.length), n, data]),
  };
}

const ESP = { number: 1, first: 2048, sectors: 2048, id: "3d7b64d1-2e0c-493b-958e-7f825aec1f7c" };

/** A device path, HD()/File(path), as a load option carries one. */
function devicePath(path: string): Buffer {
  const option = loadOption({ title: "x", partition: ESP, path });
  return option.subarray(6 + 4); // past attributes, length and the two-character title "x\0"
}

/** The firmware starting the EFI program at `path` (a UEFI_IMAGE_LOAD_EVENT). */
export function started(path: string): LogEvent {
  const dp = devicePath(path);
  return {
    pcr: 4,
    type: EV_BOOT_SERVICES_APPLICATION,
    data: Buffer.concat([u64(0x1000), u64(0x2000), u64(0), u64(dp.length), dp]),
  };
}

/** The firmware measuring a Boot#### variable (PCR 1): its load option names the file it starts. */
export function bootVariable(number: number, title: string, path: string): LogEvent {
  const name = `Boot${number.toString(16).toUpperCase().padStart(4, "0")}`;
  return variable(EV_VARIABLE_BOOT, 1, name, loadOption({ title, partition: ESP, path }));
}

/** The Secure Boot db as the firmware measures it: here just certificate subjects, which is all the reader looks at. */
export function db(...names: string[]): LogEvent {
  return variable(
    EV_VARIABLE_DRIVER_CONFIG,
    7,
    "db",
    Buffer.concat(names.map((n) => Buffer.from(`\x30\x82${n}\x30`, "latin1"))),
    "d719b2cb-3d3a-4596-a3bc-dad00e67656f",
  );
}

export const WINDOWS = "\\EFI\\Microsoft\\Boot\\bootmgfw.efi";
export const SHIM = "\\EFI\\swiff\\shimx64.efi";
export const MOK_MANAGER = "\\EFI\\swiff\\mmx64.efi";
export const LOADER = "\\EFI\\swiff\\grubx64.efi";
