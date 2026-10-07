// One small file put into the root folder of Lanterel OS's ESP, as bytes: how
// the install leaves Lanterel OS something it reads at boot (LANTEREL.ENV, where
// its error reports go: swiff-os/README.md, "Error reports"). The ESP is written
// from the image set and read back against its SHA-256 first. Windows does not
// mount it then (it is typed Linux data until the boot entry step), so the
// worker (rental-worker.cjs) writes the file into the FAT itself.
//
// Only a FAT32 with 512-byte sectors, as the image set's ESP is, and only a
// file that fits in one cluster, under an 8.3 name in the root folder. A file
// of that name already there is pointed at a new cluster: the one it had is
// never written, since nothing proves no other file shares it, and stays
// allocated (one cluster, which chkdsk may report as lost).
//
// A disk is `read(offset, length)` and `write([{ offset, bytes }])`, sector-aligned.

const SECTOR = 512;
const ENTRY = 32;
const CLUSTER = 0x0fffffff;
const END_OF_CHAIN = 0x0ffffff8;
const LONG_NAME = 0x0f;
const VOLUME_ID = 0x08;
const DIRECTORY = 0x10;
const ARCHIVE = 0x20;

/** A FAT32 that the boot sector does not describe as this module expects, as one sentence. */
const notFat32 = () => new Error("Lanterel OS's boot partition is not a FAT32 with 512-byte sectors.");

/** "LANTEREL.ENV" as a directory entry's 11 bytes, "LANTERELENV". */
function shortName(name) {
  const m = /^([A-Z0-9_-]{1,8})(?:\.([A-Z0-9_-]{1,3}))?$/.exec(name);
  if (!m) throw new Error(`${name} is not an upper-case 8.3 name.`);
  return Buffer.from(m[1].padEnd(8) + (m[2] ?? "").padEnd(3), "ascii");
}

/** A date and time as a FAT directory entry stores them. */
const fatDate = (d) => ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
const fatTime = (d) => (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);

/** The FAT32 at `base` on `disk`, as its boot sector describes it. */
function fat32(disk, base) {
  const boot = disk.read(base, SECTOR);
  const perCluster = boot.readUInt8(13);
  const reserved = boot.readUInt16LE(14);
  const fats = boot.readUInt8(16);
  const fatSectors = boot.readUInt32LE(36);
  const total = boot.readUInt16LE(19) || boot.readUInt32LE(32);
  const flags = boot.readUInt16LE(40);
  if (
    boot.readUInt16LE(510) !== 0xaa55 ||
    boot.readUInt16LE(11) !== SECTOR ||
    boot.readUInt16LE(17) !== 0 ||
    boot.readUInt16LE(22) !== 0 ||
    !perCluster ||
    perCluster & (perCluster - 1) ||
    !reserved ||
    !fats ||
    !fatSectors
  )
    throw notFat32();
  const dataStart = reserved + fats * fatSectors;
  const clusters = Math.floor((total - dataStart) / perCluster);
  if (clusters < 1 || (clusters + 2) * 4 > fatSectors * SECTOR) throw notFat32();
  // With mirroring off (bit 7), only the active FAT (bits 0-3) is in use.
  const active = flags & 0x80 ? [flags & 0x0f] : Array.from({ length: fats }, (_, i) => i);
  if (active[0] >= fats) throw notFat32();
  const sector = (n) => base + n * SECTOR;
  return {
    clusterBytes: perCluster * SECTOR,
    rootCluster: boot.readUInt32LE(44),
    fsInfo: boot.readUInt16LE(48),
    reserved,
    clusters,
    sector,
    /** Where cluster `c`'s data starts on the disk. */
    clusterAt: (c) => sector(dataStart + (c - 2) * perCluster),
    /** Where cluster `c`'s FAT entry is, in each FAT in use: its sector, and where in it. */
    fatAt: (c) =>
      active.map((i) => ({
        offset: sector(reserved + i * fatSectors + Math.floor((c * 4) / SECTOR)),
        at: (c * 4) % SECTOR,
      })),
  };
}

/**
 * Put `content` into the FAT32 at `base` on `disk` as the root folder's
 * `name`, in a newly allocated cluster even when it is there already. Throws, writing
 * nothing, unless the FAT32 is one this module knows, the content fits in a
 * cluster and the root folder has room.
 */
function writeRootFile(disk, base, name, content, now = new Date()) {
  const fat = fat32(disk, base);
  const want = shortName(name);
  if (content.length > fat.clusterBytes) throw new Error(`${name} is larger than one cluster.`);
  const entryOf = (c) => {
    const [{ offset, at }] = fat.fatAt(c);
    return disk.read(offset, SECTOR).readUInt32LE(at) & CLUSTER;
  };
  const valid = (c) => c >= 2 && c < fat.clusters + 2;

  // The root folder, cluster by cluster: the file's entry, or the first free one.
  let found = null;
  let free = null;
  let cluster = fat.rootCluster;
  walk: for (let seen = 0; ; seen++) {
    if (!valid(cluster) || seen > fat.clusters) throw new Error("The ESP's root folder is broken.");
    for (
      let offset = fat.clusterAt(cluster);
      offset < fat.clusterAt(cluster) + fat.clusterBytes;
      offset += SECTOR
    ) {
      const sector = disk.read(offset, SECTOR);
      for (let at = 0; at < SECTOR; at += ENTRY) {
        const first = sector[at];
        const attrs = sector[at + 11];
        if (first === 0x00) {
          free ??= { offset, at };
          break walk;
        }
        if (first === 0xe5) free ??= { offset, at };
        else if (attrs !== LONG_NAME && !(attrs & VOLUME_ID) && sector.subarray(at, at + 11).equals(want)) {
          if (attrs & DIRECTORY) throw new Error(`${name} on the ESP is a folder.`);
          found = { offset, at };
          break walk;
        }
      }
    }
    const next = entryOf(cluster);
    if (next >= END_OF_CHAIN) break;
    cluster = next;
  }
  const slot = found ?? free;
  if (!slot) throw new Error("The ESP's root folder has no room for another file.");

  // Its cluster: always the first free one. A cluster the entry names already
  // may be free in the FAT or shared with another file, so it is never reused.
  let data = null;
  for (let c = 2; data === null && c < fat.clusters + 2;) {
    const [{ offset, at }] = fat.fatAt(c);
    const sector = disk.read(offset, SECTOR);
    for (let i = at; i < SECTOR && c < fat.clusters + 2; i += 4, c++)
      if ((sector.readUInt32LE(i) & CLUSTER) === 0) {
        data = c;
        break;
      }
  }
  if (data === null) throw new Error("The ESP has no free cluster.");

  // The content, then the FAT, then the entry: an entry never names a cluster that is not ready.
  const writes = [
    {
      offset: fat.clusterAt(data),
      bytes: Buffer.concat([content, Buffer.alloc(fat.clusterBytes - content.length)]),
    },
  ];
  for (const { offset, at } of fat.fatAt(data)) {
    const sector = disk.read(offset, SECTOR);
    sector.writeUInt32LE(((sector.readUInt32LE(at) & ~CLUSTER) | CLUSTER) >>> 0, at);
    writes.push({ offset, bytes: sector });
  }
  // The free cluster count it keeps, when it keeps one, is one less.
  const info = fat.fsInfo > 0 && fat.fsInfo < fat.reserved ? disk.read(fat.sector(fat.fsInfo), SECTOR) : null;
  const count = info?.readUInt32LE(488);
  if (
    info &&
    info.readUInt32LE(0) === 0x41615252 &&
    info.readUInt32LE(484) === 0x61417272 &&
    count > 0 &&
    count <= fat.clusters
  ) {
    info.writeUInt32LE(count - 1, 488);
    writes.push({ offset: fat.sector(fat.fsInfo), bytes: info });
  }
  const dir = disk.read(slot.offset, SECTOR);
  const entry = Buffer.alloc(ENTRY);
  want.copy(entry, 0);
  entry[11] = ARCHIVE;
  entry.writeUInt16LE(fatTime(now), 14);
  entry.writeUInt16LE(fatDate(now), 16);
  entry.writeUInt16LE(fatDate(now), 18);
  entry.writeUInt16LE(data >>> 16, 20);
  entry.writeUInt16LE(fatTime(now), 22);
  entry.writeUInt16LE(fatDate(now), 24);
  entry.writeUInt16LE(data & 0xffff, 26);
  entry.writeUInt32LE(content.length, 28);
  entry.copy(dir, slot.at);
  writes.push({ offset: slot.offset, bytes: dir });
  disk.write(writes);
}

module.exports = { writeRootFile };
