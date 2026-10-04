// GUID partition tables, read and written as bytes: what the rental-mode
// installer (rental.cjs) needs to add Swiff OS's partitions next to Windows
// with the exact type, unique id and name each one has in the Swiff OS image.
// Windows' own tools cannot set a partition's unique id or name, and Swiff OS
// finds its root by an id derived from its dm-verity root hash and its scratch
// by name, so the installer writes the table itself.
//
// Pure: a disk is a `read(offset, length)` function, and a change comes back
// as the byte ranges to write. Nothing here opens a disk.

/** A disk or table this module will not touch, as one sentence. */
class GptError extends Error {}

const SIGNATURE = "EFI PART";
const HEADER_SIZE = 92;
const ENTRY_SIZE = 128;
const ENTRY_COUNT = 128;
const NAME_CHARS = 36;

// --- CRC32, as the UEFI spec uses it (IEEE 802.3) -------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- GUIDs: the first three fields little-endian, the rest as written ---------

const GUID = /^\{?([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}?$/i;

/** `c12a7328-f81f-11d2-ba4b-00a0c93ec93b` as the 16 bytes a GPT stores. */
function guidBytes(text) {
  const m = GUID.exec(String(text));
  if (!m) throw new GptError(`Not a GUID: ${text}`);
  const le = (hex) => Buffer.from(hex, "hex").reverse();
  return Buffer.concat([le(m[1]), le(m[2]), le(m[3]), Buffer.from(m[4] + m[5], "hex")]);
}

/** 16 GPT bytes as a lower-case GUID, without braces. */
function guidText(bytes) {
  const hex = (start, end, reverse) => {
    const part = Buffer.from(bytes.subarray(start, end));
    return (reverse ? part.reverse() : part).toString("hex");
  };
  return [hex(0, 4, true), hex(4, 6, true), hex(6, 8, true), hex(8, 10), hex(10, 16)].join("-");
}

const ZERO_GUID = "00000000-0000-0000-0000-000000000000";

// --- reading --------------------------------------------------------------------

/** One 128-byte entry, or null for an empty slot. */
function parseEntry(bytes, index) {
  const type = guidText(bytes.subarray(0, 16));
  if (type === ZERO_GUID) return null;
  const nameBytes = bytes.subarray(56, 56 + NAME_CHARS * 2);
  let end = 0;
  while (end < nameBytes.length && nameBytes.readUInt16LE(end) !== 0) end += 2;
  return {
    index,
    type,
    id: guidText(bytes.subarray(16, 32)),
    first: Number(bytes.readBigUInt64LE(32)),
    last: Number(bytes.readBigUInt64LE(40)),
    attrs: bytes.readBigUInt64LE(48),
    name: nameBytes.subarray(0, end).toString("utf16le"),
  };
}

/**
 * The primary GPT of a disk of `diskBytes` bytes, read through `read(offset,
 * length)`. Refuses a table whose header or entries fail their CRC, or whose
 * backup is not at the disk's last sector: a table this module writes back
 * must be one it fully understood.
 */
function readGpt(read, { diskBytes, sectorSize = 512 }) {
  const header = read(sectorSize, sectorSize);
  if (header.subarray(0, 8).toString("latin1") !== SIGNATURE) throw new GptError("The disk has no GPT.");
  const size = header.readUInt32LE(12);
  if (size < HEADER_SIZE || size > sectorSize) throw new GptError("The GPT header has an odd size.");
  const check = Buffer.from(header.subarray(0, size));
  check.writeUInt32LE(0, 16);
  if (crc32(check) !== header.readUInt32LE(16)) throw new GptError("The GPT header fails its checksum.");
  const lastLba = diskBytes / sectorSize - 1;
  const backupLba = Number(header.readBigUInt64LE(32));
  if (Number(header.readBigUInt64LE(24)) !== 1 || backupLba !== lastLba)
    throw new GptError("The GPT's backup is not at the end of the disk.");
  const entriesLba = Number(header.readBigUInt64LE(72));
  const count = header.readUInt32LE(80);
  const entrySize = header.readUInt32LE(84);
  if (entrySize !== ENTRY_SIZE || count < 1 || count > 1024) throw new GptError("The GPT has odd entries.");
  const table = read(entriesLba * sectorSize, count * entrySize);
  if (crc32(table) !== header.readUInt32LE(88)) throw new GptError("The GPT entries fail their checksum.");
  const entries = [];
  for (let i = 0; i < count; i++) {
    const entry = parseEntry(table.subarray(i * entrySize, (i + 1) * entrySize), i);
    if (entry) entries.push(entry);
  }
  return {
    sectorSize,
    diskBytes,
    diskId: guidText(header.subarray(56, 72)),
    firstUsable: Number(header.readBigUInt64LE(40)),
    lastUsable: Number(header.readBigUInt64LE(48)),
    entriesLba,
    count,
    entries,
  };
}

// --- changing -------------------------------------------------------------------

/** Sectors the entry array takes. */
const entrySectors = (gpt) => Math.ceil((gpt.count * ENTRY_SIZE) / gpt.sectorSize);

/** A new, empty GPT for a blank disk: what a disk tool would write. */
function emptyGpt({ diskBytes, sectorSize = 512, diskId }) {
  if (diskBytes % sectorSize) throw new GptError("The disk size is not whole sectors.");
  const lastLba = diskBytes / sectorSize - 1;
  const sectors = Math.ceil((ENTRY_COUNT * ENTRY_SIZE) / sectorSize);
  return {
    sectorSize,
    diskBytes,
    diskId,
    firstUsable: 2 + sectors,
    lastUsable: lastLba - 1 - sectors,
    entriesLba: 2,
    count: ENTRY_COUNT,
    entries: [],
  };
}

/** Throws unless every entry lies in the usable area and none overlap. */
function checkEntries(gpt) {
  const sorted = [...gpt.entries].sort((a, b) => a.first - b.first);
  sorted.forEach((entry, i) => {
    if (entry.first < gpt.firstUsable || entry.last > gpt.lastUsable || entry.last < entry.first)
      throw new GptError(`Partition ${entry.index + 1} lies outside the disk's usable area.`);
    const next = sorted[i + 1];
    if (next && next.first <= entry.last)
      throw new GptError(`Partitions ${entry.index + 1} and ${next.index + 1} overlap.`);
  });
  if (new Set(gpt.entries.map((e) => e.index)).size !== gpt.entries.length)
    throw new GptError("Two partitions share a slot.");
  return gpt;
}

/**
 * The table with `adds` placed in its first empty slots, in order. Each add
 * is `{ type, id, name, first, last, attrs? }`, in sectors. Throws when they
 * do not fit or overlap anything.
 */
function withPartitions(gpt, adds) {
  const used = new Set(gpt.entries.map((e) => e.index));
  const entries = [...gpt.entries];
  let slot = 0;
  for (const add of adds) {
    while (used.has(slot)) slot++;
    if (slot >= gpt.count) throw new GptError("The GPT has no free slots.");
    if (String(add.name).length > NAME_CHARS) throw new GptError(`The name ${add.name} is too long.`);
    guidBytes(add.type);
    guidBytes(add.id);
    entries.push({ attrs: 0n, ...add, index: slot });
    used.add(slot);
  }
  return checkEntries({ ...gpt, entries });
}

/** The table with partition slot `index` ending at sector `last` instead. */
function withResized(gpt, index, last) {
  if (!gpt.entries.some((e) => e.index === index)) throw new GptError(`No partition in slot ${index + 1}.`);
  return checkEntries({ ...gpt, entries: gpt.entries.map((e) => (e.index === index ? { ...e, last } : e)) });
}

// --- writing --------------------------------------------------------------------

function entryArray(gpt) {
  const table = Buffer.alloc(entrySectors(gpt) * gpt.sectorSize);
  for (const e of gpt.entries) {
    const at = e.index * ENTRY_SIZE;
    guidBytes(e.type).copy(table, at);
    guidBytes(e.id).copy(table, at + 16);
    table.writeBigUInt64LE(BigInt(e.first), at + 32);
    table.writeBigUInt64LE(BigInt(e.last), at + 40);
    table.writeBigUInt64LE(BigInt(e.attrs ?? 0n), at + 48);
    table.write(e.name, at + 56, NAME_CHARS * 2, "utf16le");
  }
  return table;
}

function headerBytes(gpt, { self, other, entriesLba, entriesCrc }) {
  const header = Buffer.alloc(gpt.sectorSize);
  header.write(SIGNATURE, 0, "latin1");
  header.writeUInt32LE(0x00010000, 8);
  header.writeUInt32LE(HEADER_SIZE, 12);
  header.writeBigUInt64LE(BigInt(self), 24);
  header.writeBigUInt64LE(BigInt(other), 32);
  header.writeBigUInt64LE(BigInt(gpt.firstUsable), 40);
  header.writeBigUInt64LE(BigInt(gpt.lastUsable), 48);
  guidBytes(gpt.diskId).copy(header, 56);
  header.writeBigUInt64LE(BigInt(entriesLba), 72);
  header.writeUInt32LE(gpt.count, 80);
  header.writeUInt32LE(ENTRY_SIZE, 84);
  header.writeUInt32LE(entriesCrc, 88);
  header.writeUInt32LE(crc32(header.subarray(0, HEADER_SIZE)), 16);
  return header;
}

/**
 * The byte ranges that put `gpt` on its disk, as `{ offset, bytes }`: the
 * primary entries and header, then the backup entries and header at the end.
 * The protective MBR is left as it is, unless `mbr` asks for a fresh one (a
 * blank disk).
 */
function gptWrites(gpt, { mbr = false } = {}) {
  checkEntries(gpt);
  const ss = gpt.sectorSize;
  const lastLba = gpt.diskBytes / ss - 1;
  const table = entryArray(gpt);
  const entriesCrc = crc32(table.subarray(0, gpt.count * ENTRY_SIZE));
  const backupEntries = lastLba - entrySectors(gpt);
  const writes = [
    { offset: gpt.entriesLba * ss, bytes: table },
    {
      offset: ss,
      bytes: headerBytes(gpt, { self: 1, other: lastLba, entriesLba: gpt.entriesLba, entriesCrc }),
    },
    { offset: backupEntries * ss, bytes: table },
    {
      offset: lastLba * ss,
      bytes: headerBytes(gpt, { self: lastLba, other: 1, entriesLba: backupEntries, entriesCrc }),
    },
  ];
  if (mbr) {
    const sector = Buffer.alloc(ss);
    // One partition of type 0xEE covering the disk, as the UEFI spec asks.
    sector.writeUInt8(0x02, 446 + 2);
    sector.writeUInt8(0xee, 446 + 4);
    sector.fill(0xff, 446 + 5, 446 + 8);
    sector.writeUInt32LE(1, 446 + 8);
    sector.writeUInt32LE(Math.min(lastLba, 0xffffffff), 446 + 12);
    sector.writeUInt16LE(0xaa55, 510);
    writes.unshift({ offset: 0, bytes: sector });
  }
  return writes;
}

module.exports = {
  GptError,
  crc32,
  guidBytes,
  guidText,
  readGpt,
  emptyGpt,
  withPartitions,
  withResized,
  gptWrites,
};
