// A synthetic boot, measured as UEFI firmware and systemd-stub would: the
// events of one boot, its TCG event log, and what a release's boot policy lists
// for it. Shared by the fixture recorder (tpm-fixtures.mjs) and the attestation
// client's tests against the real verifier (swiff-os/hostd/src/attest.test.ts),
// so both measure the same boot.

import { createHash } from "node:crypto";

export const sha256 = (...parts) => {
  const h = createHash("sha256");
  for (const part of parts) h.update(part);
  return h.digest();
};
const sha1 = (data) => createHash("sha1").update(data).digest();
const u8 = (n) => Buffer.from([n]);
const ALG = { SHA1: 0x0004, SHA256: 0x000b };

// --- The synthetic firmware event log (little-endian) -----------------------

const le32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const le16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const le64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const EV = {
  POST_CODE: 0x1,
  SEPARATOR: 0x4,
  S_CRTM_VERSION: 0x8,
  IPL: 0xd,
  VARIABLE_DRIVER_CONFIG: 0x80000001,
  VARIABLE_BOOT: 0x80000002,
  BOOT_SERVICES_APPLICATION: 0x80000003,
  BOOT_SERVICES_DRIVER: 0x80000004,
  ACTION: 0x80000007,
  PLATFORM_FIRMWARE_BLOB: 0x80000008,
  VARIABLE_AUTHORITY: 0x800000e0,
};
const GLOBAL = Buffer.from("61dfe48bca93d211aa0d00e098032b8c", "hex");
const IMAGE_SECURITY = Buffer.from("cbb219d73a3d9645a3bcdad00e67656f", "hex");
const SHIM_LOCK = Buffer.from("50ab5d6046e00043abb63dd810dd8b23", "hex");

function variable(guid, name, value) {
  const unicode = Buffer.from(name, "utf16le");
  return Buffer.concat([guid, le64(name.length), le64(value.length), unicode, value]);
}

/** The Spec ID header, naming the SHA-1 and SHA-256 banks. */
function specId() {
  const data = Buffer.concat([
    Buffer.from("Spec ID Event03\0", "latin1"),
    le32(0),
    u8(0),
    u8(2),
    u8(0),
    u8(2),
    le32(2),
    le16(ALG.SHA1),
    le16(20),
    le16(ALG.SHA256),
    le16(32),
    u8(0),
  ]);
  return Buffer.concat([le32(0), le32(0x3), Buffer.alloc(20), le32(data.length), data]);
}

/** One TCG_PCR_EVENT2: digests of `measured` (the data itself unless the event hashes something else). */
function event2(pcr, type, data, measured = data) {
  return Buffer.concat([
    le32(pcr),
    le32(type),
    le32(2),
    le16(ALG.SHA1),
    sha1(measured),
    le16(ALG.SHA256),
    sha256(measured),
    le32(data.length),
    data,
  ]);
}

/**
 * The events of one boot. `boot` changes the firmware, Secure Boot, the boot
 * applications, the UKI, DMA protection, what systemd-stub takes from the
 * ESP, setup mode, and an owner's db key. Returns the log entries, each with the SHA-256 digest to extend, and the
 * PCR 11 boot phases (extended, not logged).
 */
export function bootEvents({
  firmware = "firmware-v1",
  secureBoot = 1,
  extraApp = null,
  apps = true,
  uki = "swiff-os-1",
  dmaOff = false,
  credential = false,
  sysext = false,
  setupMode = false,
  ownerDbKey = false,
}) {
  const events = [];
  const add = (pcr, type, data, measured = data) => events.push({ pcr, type, data, measured });
  add(0, EV.S_CRTM_VERSION, Buffer.from("1.0\0", "utf16le"));
  add(
    0,
    EV.PLATFORM_FIRMWARE_BLOB,
    Buffer.concat([le64(0xff000000), le64(0x1000000)]),
    Buffer.from(firmware),
  );
  add(1, EV.VARIABLE_BOOT, variable(GLOBAL, "BootOrder", Buffer.from([1, 0, 0, 0])));
  add(2, EV.POST_CODE, Buffer.from("Option ROM"), Buffer.from("gpu-option-rom"));
  const db = ownerDbKey ? "microsoft-uefi-ca-2023,owner-db-key" : "microsoft-uefi-ca-2023";
  add(
    7,
    EV.VARIABLE_DRIVER_CONFIG,
    variable(GLOBAL, "SecureBoot", Buffer.from([setupMode ? 0 : secureBoot])),
  );
  add(7, EV.VARIABLE_DRIVER_CONFIG, variable(GLOBAL, "PK", Buffer.from(setupMode ? "" : "platform-key")));
  add(7, EV.VARIABLE_DRIVER_CONFIG, variable(GLOBAL, "KEK", Buffer.from("key-exchange-keys")));
  add(7, EV.VARIABLE_DRIVER_CONFIG, variable(IMAGE_SECURITY, "db", Buffer.from(db)));
  add(7, EV.VARIABLE_DRIVER_CONFIG, variable(IMAGE_SECURITY, "dbx", Buffer.from("revocations-2026")));
  if (dmaOff) add(7, EV.ACTION, Buffer.from("DMA Protection Disabled", "latin1"));
  if (ownerDbKey) {
    // A Driver#### load option: the driver is measured into PCR 2, the key that verified it into PCR 7.
    add(2, EV.BOOT_SERVICES_DRIVER, Buffer.from("\\EFI\\owner\\patch.efi"), Buffer.from("owner-dxe-patch"));
    add(7, EV.VARIABLE_AUTHORITY, variable(IMAGE_SECURITY, "db", Buffer.from("owner-db-key")));
  }
  for (let pcr = 0; pcr <= 7; pcr++) add(pcr, EV.SEPARATOR, Buffer.alloc(4));
  add(4, EV.ACTION, Buffer.from("Calling EFI Application from Boot Option", "latin1"));
  if (extraApp) add(4, EV.BOOT_SERVICES_APPLICATION, Buffer.from("\\EFI\\loader.efi"), Buffer.from(extraApp));
  if (apps)
    add(4, EV.BOOT_SERVICES_APPLICATION, Buffer.from("\\EFI\\BOOT\\BOOTX64.EFI"), Buffer.from("shim-15.8"));
  add(7, EV.VARIABLE_AUTHORITY, variable(IMAGE_SECURITY, "db", Buffer.from("microsoft-uefi-ca-2023")));
  // shim: the vendor certificate it verified the UKI with.
  add(7, EV.VARIABLE_AUTHORITY, variable(SHIM_LOCK, "Shim", Buffer.from("swiff-vendor-cert")));
  if (apps)
    add(4, EV.BOOT_SERVICES_APPLICATION, Buffer.from("\\EFI\\Linux\\swiff.efi"), Buffer.from(`uki:${uki}`));
  // systemd-stub: every UKI section's name, then its contents, into PCR 11.
  for (const section of [".linux", ".osrel", ".cmdline", ".initrd", ".uname"]) {
    const name = Buffer.from(`${section}\0`, "latin1");
    add(11, EV.IPL, name);
    add(11, EV.IPL, Buffer.from(section, "latin1"), Buffer.from(`${uki}${section}`));
  }
  // systemd-stub: what it takes from outside the UKI, from the ESP.
  if (credential)
    add(
      12,
      EV.IPL,
      Buffer.from("ssh.authorized_keys.root.cred\0", "latin1"),
      Buffer.from("ssh-ed25519 AAAA owner"),
    );
  if (sysext) add(13, EV.IPL, Buffer.from("owner-tools.sysext.raw\0", "latin1"), Buffer.from("owner-tools"));
  return { events, phases: ["enter-initrd", "leave-initrd", "sysinit", "ready"] };
}

/** Whether `e` is a separator, or one of `actions`, with the data that was extended. */
const accounted = (e, actions) =>
  e.data.equals(e.measured) &&
  ((e.type === EV.SEPARATOR && e.data.equals(Buffer.alloc(4))) ||
    (e.type === EV.ACTION && actions.includes(e.data.toString("latin1"))));

/** A release's policy lists every PCR 7 extend but the separator, the known action and the first Secure Boot variables before it. */
export function secureBootAuthorities(boot) {
  const variables = new Set(["SecureBoot", "PK", "KEK", "db", "dbx"]);
  let separated = false;
  const out = [];
  for (const e of bootEvents(boot).events.filter((e) => e.pcr === 7)) {
    if (accounted(e, ["DMA Protection Disabled"])) {
      if (e.type === EV.SEPARATOR) separated = true;
      continue;
    }
    const name = (data) => data.subarray(32, 32 + Number(data.readBigUInt64LE(16)) * 2).toString("utf16le");
    if (e.type === EV.VARIABLE_DRIVER_CONFIG && !separated && variables.delete(name(e.data))) continue;
    out.push(sha256(e.measured).toString("hex"));
  }
  return out;
}

/** A release's policy lists every PCR 4 extend but separators and the known actions. */
export const bootApplications = (boot) =>
  bootEvents(boot)
    .events.filter(
      (e) =>
        e.pcr === 4 &&
        !accounted(e, [
          "Calling EFI Application from Boot Option",
          "Returning from EFI Application from Boot Option",
        ]),
    )
    .map((e) => sha256(e.measured).toString("hex"));

/** The TCG event log of `boot`: the Spec ID header, then every event. */
export const eventLog = (boot) =>
  Buffer.concat([specId(), ...bootEvents(boot).events.map((e) => event2(e.pcr, e.type, e.data, e.measured))]);
