// UEFI boot entries and shim's MOK variables, as bytes: what the rental-mode
// installer (rental-worker.cjs) writes to the firmware from Windows to add
// Swiff OS to the boot menu, start it once (BootNext) and queue Swiff's key
// for the owner to confirm. bcdedit cannot name a partition without giving it
// a drive letter, which Windows refuses for a second EFI system partition, so
// the installer writes Boot#### itself, as efibootmgr does on Linux.
//
// Pure: nothing here touches the firmware.

const crypto = require("node:crypto");

/** EFI_GLOBAL_VARIABLE: Boot####, BootOrder, BootNext, BootCurrent. */
const GLOBAL = "8be4df61-93ca-11d2-aa0d-00e098032b8c";

/** shim's variables' GUID (SHIM_LOCK_GUID): MokNew, MokAuth, MokDel, MokDelAuth, MokList. */
const SHIM_LOCK = "605dab50-e046-4300-abb6-3dd810dd8b23";

/** EFI_CERT_X509_GUID: a signature list entry that holds an X.509 certificate. */
const CERT_X509 = "a5c059a1-94e4-4aa7-87b5-ab155c2bf072";

/** Non-volatile, boot service and runtime access: what Boot####, mokutil's requests and efibootmgr use. */
const NV_BS_RT = 7;

/** LOAD_OPTION_ACTIVE: the firmware may start the entry. */
const ACTIVE = 1;

/** A GUID's 16 bytes as UEFI stores them: the first three fields little-endian. */
function guidBytes(guid) {
  const hex = String(guid).replace(/[{}-]/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`Not a GUID: ${guid}`);
  const b = Buffer.from(hex, "hex");
  return Buffer.concat([
    b.subarray(0, 4).reverse(),
    b.subarray(4, 6).reverse(),
    b.subarray(6, 8).reverse(),
    b.subarray(8),
  ]);
}

/** 16 UEFI bytes as a lower-case GUID. */
function guidText(bytes) {
  const b = Buffer.from(bytes);
  const hex = (s, e, rev) =>
    (rev ? Buffer.from(b.subarray(s, e)).reverse() : b.subarray(s, e)).toString("hex");
  return [hex(0, 4, true), hex(4, 6, true), hex(6, 8, true), hex(8, 10), hex(10, 16)].join("-");
}

const ucs2z = (text) => Buffer.from(`${text}\0`, "utf16le");

/** "Boot0003" ↔ 3. */
const bootName = (index) => `Boot${index.toString(16).toUpperCase().padStart(4, "0")}`;
const bootIndex = (name) => (/^Boot[0-9A-F]{4}$/i.test(name) ? parseInt(name.slice(4), 16) : null);

/**
 * An EFI_LOAD_OPTION for a file on a GPT partition: HD(number, GPT, id,
 * first, sectors)/File(path), as efibootmgr writes one. `partition` is in
 * sectors, as the GPT has it.
 */
function loadOption({ title, partition, path }) {
  if (!/^\\[\\\w.-]+$/.test(path)) throw new Error(`Not a firmware path: ${path}`);
  const hd = Buffer.alloc(42);
  hd.writeUInt8(0x04, 0); // MEDIA_DEVICE_PATH
  hd.writeUInt8(0x01, 1); // MEDIA_HARDDRIVE_DP
  hd.writeUInt16LE(42, 2);
  hd.writeUInt32LE(partition.number, 4);
  hd.writeBigUInt64LE(BigInt(partition.first), 8);
  hd.writeBigUInt64LE(BigInt(partition.sectors), 16);
  guidBytes(partition.id).copy(hd, 24);
  hd.writeUInt8(0x02, 40); // MBRType: GPT
  hd.writeUInt8(0x02, 41); // SignatureType: GUID
  const name = ucs2z(path);
  const file = Buffer.alloc(4);
  file.writeUInt8(0x04, 0); // MEDIA_DEVICE_PATH
  file.writeUInt8(0x04, 1); // MEDIA_FILEPATH_DP
  file.writeUInt16LE(4 + name.length, 2);
  const end = Buffer.from([0x7f, 0xff, 0x04, 0x00]);
  const paths = Buffer.concat([hd, file, name, end]);
  const head = Buffer.alloc(6);
  head.writeUInt32LE(ACTIVE, 0);
  head.writeUInt16LE(paths.length, 4);
  return Buffer.concat([head, ucs2z(title), paths]);
}

/**
 * What an EFI_LOAD_OPTION says: its title, and the partition id and file it
 * starts when its device path is HD()/File(). Null when it is not a load option.
 */
function parseLoadOption(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 8) return null;
  const pathsLength = b.readUInt16LE(4);
  let at = 6;
  while (at + 1 < b.length && b.readUInt16LE(at) !== 0) at += 2;
  if (at + 1 >= b.length) return null;
  const title = b.subarray(6, at).toString("utf16le");
  const paths = b.subarray(at + 2, at + 2 + pathsLength);
  let partition = null;
  let file = null;
  for (let p = 0; p + 4 <= paths.length;) {
    const [type, sub, len] = [paths[p], paths[p + 1], paths.readUInt16LE(p + 2)];
    if (len < 4 || type === 0x7f) break;
    if (type === 0x04 && sub === 0x01 && len === 42) partition = guidText(paths.subarray(p + 24, p + 40));
    if (type === 0x04 && sub === 0x04)
      file = paths
        .subarray(p + 4, p + len)
        .toString("utf16le")
        .replace(/\0+$/, "");
    p += len;
  }
  return { active: (b.readUInt32LE(0) & ACTIVE) === ACTIVE, title, partition, file };
}

/** BootOrder's bytes ↔ entry numbers. */
const orderBytes = (indexes) => {
  const b = Buffer.alloc(indexes.length * 2);
  indexes.forEach((n, i) => b.writeUInt16LE(n, i * 2));
  return b;
};
const orderOf = (bytes) => {
  const b = Buffer.from(bytes ?? []);
  return Array.from({ length: Math.floor(b.length / 2) }, (_, i) => b.readUInt16LE(i * 2));
};

/** `order` with `index` first, or last, and nowhere else. */
const placeIn = (order, index, where) => {
  const rest = order.filter((n) => n !== index);
  return where === "first" ? [index, ...rest] : [...rest, index];
};

// --- Swiff's key, as a MOK request -------------------------------------------------------
//
// shim boots only what Microsoft's db or its MOK list trusts. Windows queues a
// request as `mokutil --import --simple-hash` (or `--delete`) would on Linux:
// the certificate in MokNew (MokDel), and in MokAuth (MokDelAuth) the SHA-256
// of that variable followed by a one-time code in UTF-16. On the next start
// shim opens MokManager, where the owner confirms with the code; MokManager
// clears the request whether or not they did.

/** The EFI_SIGNATURE_LIST of one X.509 certificate (DER), owned by shim. */
function certList(cert) {
  const head = Buffer.alloc(12);
  head.writeUInt32LE(28 + 16 + cert.length, 0); // SignatureListSize
  head.writeUInt32LE(0, 4); // SignatureHeaderSize
  head.writeUInt32LE(16 + cert.length, 8); // SignatureSize: the owner, then the certificate
  return Buffer.concat([guidBytes(CERT_X509), head, guidBytes(SHIM_LOCK), Buffer.from(cert)]);
}

/**
 * The two variables that ask MokManager to enrol (`delete: false`) or remove
 * (`delete: true`) `cert` with `code`, by name.
 */
function mokVariables(cert, code, { remove = false } = {}) {
  const list = certList(cert);
  const auth = crypto.createHash("sha256").update(list).update(Buffer.from(code, "utf16le")).digest();
  return remove ? { MokDel: list, MokDelAuth: auth } : { MokNew: list, MokAuth: auth };
}

/** Whether a MokList (EFI_SIGNATURE_LIST entries) holds `cert`. */
function mokListHas(list, cert) {
  const b = Buffer.from(list ?? []);
  const want = Buffer.from(cert);
  for (let at = 0; at + 28 <= b.length;) {
    const size = b.readUInt32LE(at + 16);
    if (size < 28 || at + size > b.length) return false;
    const header = b.readUInt32LE(at + 20);
    const sigSize = b.readUInt32LE(at + 24);
    if (guidText(b.subarray(at, at + 16)) === CERT_X509 && sigSize > 16) {
      for (let s = at + 28 + header; s + sigSize <= at + size; s += sigSize)
        if (b.subarray(s + 16, s + sigSize).equals(want)) return true;
    }
    at += size;
  }
  return false;
}

module.exports = {
  GLOBAL,
  SHIM_LOCK,
  CERT_X509,
  NV_BS_RT,
  guidBytes,
  guidText,
  bootName,
  bootIndex,
  loadOption,
  parseLoadOption,
  orderBytes,
  orderOf,
  placeIn,
  certList,
  mokVariables,
  mokListHas,
};
