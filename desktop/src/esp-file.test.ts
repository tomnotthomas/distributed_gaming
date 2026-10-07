// @vitest-environment node
// The ESP file writer (esp-file.cjs): a file it puts into a FAT32's root folder
// reads back by the FAT specification, and it writes nothing into a partition
// it does not understand.

import { describe, expect, it } from "vitest";
import { writeRootFile } from "../esp-file.cjs";
import { fat32Volume, readRootFile } from "./test/fat32.ts";

const BASE = 300 * 1024 * 1024;

/** A disk in memory that only stores what is written to it, and counts the writes. */
function memoryDisk() {
  const chunks = new Map<number, Buffer>();
  let writes = 0;
  return {
    read(offset: number, length: number): Buffer {
      const out = Buffer.alloc(length);
      for (const [at, chunk] of chunks) {
        const from = Math.max(at, offset);
        const to = Math.min(at + chunk.length, offset + length);
        if (from < to) chunk.copy(out, from - offset, from - at, to - at);
      }
      return out;
    },
    write(list: { offset: number; bytes: Buffer }[]) {
      for (const w of list) {
        if (w.offset % 512 || w.bytes.length % 512) throw new Error("not sector-aligned");
        chunks.set(w.offset, Buffer.from(w.bytes));
      }
      writes += list.length;
    },
    writes: () => writes,
  };
}

/** A disk with a fresh 1 GiB FAT32 at BASE. */
function withVolume() {
  const disk = memoryDisk();
  disk.write(fat32Volume(BASE));
  return disk;
}

type Disk = ReturnType<typeof memoryDisk>;

/** Where cluster `c` of the FAT32 at BASE starts, from its boot sector. */
function clusterOffset(disk: Disk, c: number): number {
  const boot = disk.read(BASE, 512);
  const dataStart = boot.readUInt16LE(14) + boot[16]! * boot.readUInt32LE(36);
  return BASE + (dataStart + (c - 2) * boot[13]!) * 512;
}

/** Point the root folder's LANTEREL.ENV entry at cluster `c`, leaving the FAT as it is. */
function setEntryCluster(disk: Disk, c: number) {
  const root = clusterOffset(disk, disk.read(BASE, 512).readUInt32LE(44));
  const sector = disk.read(root, 512);
  for (let at = 0; at < 512; at += 32) {
    if (sector.toString("ascii", at, at + 11) !== "LANTERELENV") continue;
    sector.writeUInt16LE(c >>> 16, at + 20);
    sector.writeUInt16LE(c & 0xffff, at + 26);
    disk.write([{ offset: root, bytes: sector }]);
    return;
  }
  throw new Error("no LANTEREL.ENV entry");
}

const ENV = Buffer.from("LANTEREL_POSTHOG_KEY=phc_x\nLANTEREL_POSTHOG_HOST=https://eu.i.posthog.com\n");

describe("writeRootFile", () => {
  it("puts the file into the root folder, beside what is there, its cluster taken in both FATs", () => {
    const disk = withVolume();
    const before = readRootFile(disk.read, BASE, "LANTEREL.ENV");
    writeRootFile(disk, BASE, "LANTEREL.ENV", ENV);
    const after = readRootFile(disk.read, BASE, "LANTEREL.ENV");
    expect(after.names).toEqual(["ESP        ", "EFI        ", "LANTERELENV"]);
    expect(after.file).toMatchObject({ attrs: 0x20, size: ENV.length, fat: [0x0fffffff, 0x0fffffff] });
    expect(after.file!.cluster).toBeGreaterThan(3);
    expect(after.file!.content.equals(ENV)).toBe(true);
    expect(after.free).toBe(before.free - 1);
  });

  it("writes a file it wrote before into a new cluster, keeping its one entry and never touching the old cluster", () => {
    const disk = withVolume();
    const old = Buffer.from("a much longer first version of the file\n");
    writeRootFile(disk, BASE, "LANTEREL.ENV", old);
    const first = readRootFile(disk.read, BASE, "LANTEREL.ENV");
    const oldCluster = disk.read(clusterOffset(disk, first.file!.cluster), 4096);
    writeRootFile(disk, BASE, "LANTEREL.ENV", ENV);
    const second = readRootFile(disk.read, BASE, "LANTEREL.ENV");
    expect(second.names.filter((n) => n === "LANTERELENV")).toHaveLength(1);
    expect(second.file!.cluster).not.toBe(first.file!.cluster);
    expect(second.file!.content.equals(ENV)).toBe(true);
    expect(disk.read(clusterOffset(disk, first.file!.cluster), 4096).equals(oldCluster)).toBe(true);
    expect(second.free).toBe(first.free - 1);
  });

  it("never writes into the cluster an existing entry names when the FAT says that cluster is free", () => {
    const disk = withVolume();
    writeRootFile(disk, BASE, "LANTEREL.ENV", ENV);
    const first = readRootFile(disk.read, BASE, "LANTEREL.ENV");
    // Point the entry at a far cluster the FAT has as free, as a damaged or foreign ESP might.
    const far = first.file!.cluster + 1000;
    setEntryCluster(disk, far);
    const farBefore = disk.read(clusterOffset(disk, far), 4096);
    writeRootFile(disk, BASE, "LANTEREL.ENV", ENV);
    const second = readRootFile(disk.read, BASE, "LANTEREL.ENV");
    expect(second.file!.cluster).not.toBe(far);
    expect(second.file!.fat).toEqual([0x0fffffff, 0x0fffffff]);
    expect(disk.read(clusterOffset(disk, far), 4096).equals(farBefore)).toBe(true);
  });

  it("writes nothing into a partition that is not a FAT32, or a file larger than a cluster", () => {
    const blank = memoryDisk();
    expect(() => writeRootFile(blank, BASE, "LANTEREL.ENV", ENV)).toThrow(/not a FAT32/);
    expect(blank.writes()).toBe(0);
    const disk = withVolume();
    const written = disk.writes();
    expect(() => writeRootFile(disk, BASE, "LANTEREL.ENV", Buffer.alloc(4097))).toThrow(
      /larger than one cluster/,
    );
    expect(() => writeRootFile(disk, BASE, "lanterel.env", ENV)).toThrow(/8\.3 name/);
    expect(disk.writes()).toBe(written);
  });
});
