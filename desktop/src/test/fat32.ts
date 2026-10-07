// A FAT32 as mkfs.fat lays one out on Lanterel OS's 1 GiB ESP (512-byte
// sectors, 8 per cluster, 32 reserved, two FATs, FSInfo in sector 1), with an
// EFI folder in its root; and a reader that follows the FAT specification on
// its own, to check what esp-file.cjs wrote.

const SECTOR = 512;
const PER_CLUSTER = 8;
const RESERVED = 32;
const FATS = 2;
const EOC = 0x0fffffff;

type Read = (offset: number, length: number) => Buffer;
type Write = { offset: number; bytes: Buffer };

/** Directory entry `name` (11 bytes, space-padded) with `attrs`, starting at `cluster`. */
function entry(name: string, attrs: number, cluster: number, size = 0) {
  const e = Buffer.alloc(32);
  e.write(name, 0, "ascii");
  e[11] = attrs;
  e.writeUInt16LE(cluster >>> 16, 20);
  e.writeUInt16LE(cluster & 0xffff, 26);
  e.writeUInt32LE(size, 28);
  return e;
}

/** The writes that make a `bytes` FAT32 at `base`: the rest of it reads as zeros. */
export function fat32Volume(base: number, bytes = 1024 * 1024 * 1024): Write[] {
  const total = bytes / SECTOR;
  const fatSectors = Math.ceil(((total / PER_CLUSTER + 2) * 4) / SECTOR);
  const dataStart = RESERVED + FATS * fatSectors;
  const clusters = Math.floor((total - dataStart) / PER_CLUSTER);
  const boot = Buffer.alloc(SECTOR);
  boot.set([0xeb, 0x58, 0x90], 0);
  boot.write("mkfs.fat", 3, "ascii");
  boot.writeUInt16LE(SECTOR, 11);
  boot[13] = PER_CLUSTER;
  boot.writeUInt16LE(RESERVED, 14);
  boot[16] = FATS;
  boot[21] = 0xf8;
  boot.writeUInt32LE(total, 32);
  boot.writeUInt32LE(fatSectors, 36);
  boot.writeUInt32LE(2, 44);
  boot.writeUInt16LE(1, 48);
  boot.writeUInt16LE(6, 50);
  boot.write("FAT32   ", 82, "ascii");
  boot.writeUInt16LE(0xaa55, 510);
  const info = Buffer.alloc(SECTOR);
  info.writeUInt32LE(0x41615252, 0);
  info.writeUInt32LE(0x61417272, 484);
  info.writeUInt32LE(clusters - 2, 488);
  info.writeUInt32LE(4, 492);
  info.writeUInt16LE(0xaa55, 510);
  // Cluster 2 the root folder, 3 the EFI folder.
  const fat = Buffer.alloc(SECTOR);
  [0x0ffffff8, EOC, EOC, EOC].forEach((v, i) => fat.writeUInt32LE(v, i * 4));
  const root = Buffer.concat([
    entry("ESP        ", 0x08, 0),
    entry("EFI        ", 0x10, 3),
    Buffer.alloc(SECTOR - 64),
  ]);
  const at = (sector: number) => base + sector * SECTOR;
  return [
    { offset: at(0), bytes: boot },
    { offset: at(1), bytes: info },
    { offset: at(6), bytes: boot },
    ...Array.from({ length: FATS }, (_, i) => ({ offset: at(RESERVED + i * fatSectors), bytes: fat })),
    { offset: at(dataStart), bytes: root },
  ];
}

/** What the root folder of the FAT32 at `base` says of `name` (8.3, upper case), read by the specification. */
export function readRootFile(read: Read, base: number, name: string) {
  const boot = read(base, SECTOR);
  const perCluster = boot[13]!;
  const reserved = boot.readUInt16LE(14);
  const fats = boot[16]!;
  const fatSectors = boot.readUInt32LE(36);
  const dataStart = reserved + fats * fatSectors;
  const cluster = (c: number) => base + (dataStart + (c - 2) * perCluster) * SECTOR;
  const fatEntries = (c: number) =>
    Array.from({ length: fats }, (_, i) =>
      read(base + (reserved + i * fatSectors) * SECTOR + c * 4 - ((c * 4) % SECTOR), SECTOR).readUInt32LE(
        (c * 4) % SECTOR,
      ),
    );
  const [base8, ext = ""] = name.split(".");
  const want = base8!.padEnd(8) + ext.padEnd(3);
  const root = read(cluster(boot.readUInt32LE(44)), perCluster * SECTOR);
  const names: string[] = [];
  let found: { cluster: number; size: number; attrs: number } | null = null;
  for (let at = 0; at < root.length && root[at] !== 0; at += 32) {
    if (root[at] === 0xe5) continue;
    const short = root.toString("ascii", at, at + 11);
    names.push(short);
    if (short === want)
      found = {
        cluster: (root.readUInt16LE(at + 20) << 16) | root.readUInt16LE(at + 26),
        size: root.readUInt32LE(at + 28),
        attrs: root[at + 11]!,
      };
  }
  const free = read(base + boot.readUInt16LE(48) * SECTOR, SECTOR).readUInt32LE(488);
  if (!found) return { names, free, file: null };
  return {
    names,
    free,
    file: {
      ...found,
      content: read(cluster(found.cluster), SECTOR * perCluster).subarray(0, found.size),
      fat: fatEntries(found.cluster).map((v) => v & EOC),
    },
  };
}
