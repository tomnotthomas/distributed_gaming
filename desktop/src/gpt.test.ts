// The GPT writer (gpt.cjs): what it writes reads back exactly, and it refuses
// tables it does not fully understand.

import { describe, expect, it } from "vitest";
import {
  crc32,
  emptyGpt,
  GptError,
  gptWrites,
  guidBytes,
  guidText,
  readGpt,
  withPartitions,
  withResized,
  type Gpt,
} from "../gpt.cjs";

const MiB = 1024 * 1024;
const ESP = "c12a7328-f81f-11d2-ba4b-00a0c93ec93b";
const DATA = "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7";
const ROOT = "4f68bce3-e8cd-4db1-96e7-fbcaf984b709";

/** A disk in memory that only stores what is written to it. */
function memoryDisk(bytes: number) {
  const chunks = new Map<number, Buffer>();
  return {
    bytes,
    write(writes: { offset: number; bytes: Buffer }[]) {
      for (const w of writes) chunks.set(w.offset, Buffer.from(w.bytes));
    },
    read(offset: number, length: number): Buffer {
      const out = Buffer.alloc(length);
      for (const [at, chunk] of chunks) {
        const from = Math.max(at, offset);
        const to = Math.min(at + chunk.length, offset + length);
        if (from < to) chunk.copy(out, from - offset, from - at, to - at);
      }
      return out;
    },
  };
}

const DISK = 64 * MiB;
const sectors = (bytes: number) => bytes / 512;

/** A Windows-like table: an ESP and C:. */
function windowsLike(): Gpt {
  return withPartitions(emptyGpt({ diskBytes: DISK, diskId: "8c5e9a4e-2d1b-4c3f-9e7a-1b2c3d4e5f60" }), [
    {
      type: ESP,
      id: "11111111-2222-4333-8444-555555555555",
      name: "EFI system partition",
      first: 2048,
      last: sectors(9 * MiB) - 1,
    },
    {
      type: DATA,
      id: "66666666-7777-4888-9999-aaaaaaaaaaaa",
      name: "Basic data partition",
      first: sectors(9 * MiB),
      last: sectors(60 * MiB) - 1,
    },
  ]);
}

describe("the GPT writer", () => {
  it("checksums as the UEFI spec does", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("stores GUIDs with their first three fields little-endian", () => {
    const bytes = guidBytes(ESP);
    expect(bytes.subarray(0, 4).toString("hex")).toBe("28732ac1");
    expect(guidText(bytes)).toBe(ESP);
    expect(guidText(guidBytes(`{${ESP.toUpperCase()}}`))).toBe(ESP);
    expect(() => guidBytes("not-a-guid")).toThrow(GptError);
  });

  it("reads back a table it wrote, primary and backup", () => {
    const disk = memoryDisk(DISK);
    const gpt = windowsLike();
    disk.write(gptWrites(gpt, { mbr: true }));
    const read = readGpt(disk.read, { diskBytes: DISK });
    expect(read.entries.map((e) => [e.index, e.type, e.id, e.first, e.last, e.name])).toEqual(
      gpt.entries.map((e) => [e.index, e.type, e.id, e.first, e.last, e.name]),
    );
    expect(read.diskId).toBe(gpt.diskId);
    // The backup header sits on the last sector and points back at the primary.
    const backup = disk.read(DISK - 512, 512);
    expect(backup.subarray(0, 8).toString("latin1")).toBe("EFI PART");
    expect(Number(backup.readBigUInt64LE(32))).toBe(1);
    // The protective MBR covers the disk with one 0xEE partition.
    const mbr = disk.read(0, 512);
    expect(mbr.readUInt8(446 + 4)).toBe(0xee);
    expect(mbr.readUInt16LE(510)).toBe(0xaa55);
  });

  it("shrinks one partition and adds new ones in the free slots, keeping their ids and names", () => {
    const disk = memoryDisk(DISK);
    disk.write(gptWrites(windowsLike(), { mbr: true }));
    const before = readGpt(disk.read, { diskBytes: DISK });
    const shrunk = withResized(before, 1, sectors(40 * MiB) - 1);
    const grown = withPartitions(shrunk, [
      {
        type: ESP,
        id: "aaaaaaaa-0000-4000-8000-000000000001",
        name: "esp",
        first: sectors(40 * MiB),
        last: sectors(41 * MiB) - 1,
      },
      {
        type: ROOT,
        id: "aaaaaaaa-0000-4000-8000-000000000002",
        name: "swiffos_0.1.0",
        first: sectors(41 * MiB),
        last: sectors(50 * MiB) - 1,
      },
    ]);
    disk.write(gptWrites(grown));
    const after = readGpt(disk.read, { diskBytes: DISK });
    expect(after.entries.map((e) => [e.index, e.name, e.first])).toEqual([
      [0, "EFI system partition", 2048],
      [1, "Basic data partition", sectors(9 * MiB)],
      [2, "esp", sectors(40 * MiB)],
      [3, "swiffos_0.1.0", sectors(41 * MiB)],
    ]);
    expect(after.entries[1]!.last).toBe(sectors(40 * MiB) - 1);
    expect(after.entries[3]!.id).toBe("aaaaaaaa-0000-4000-8000-000000000002");
  });

  it("refuses partitions that overlap, or leave the usable area", () => {
    const gpt = windowsLike();
    const add = (first: number, last: number) =>
      withPartitions(gpt, [
        { type: ROOT, id: "aaaaaaaa-0000-4000-8000-000000000003", name: "x", first, last },
      ]);
    expect(() => add(sectors(59 * MiB), sectors(61 * MiB))).toThrow(/overlap/);
    expect(() => add(sectors(61 * MiB), sectors(DISK))).toThrow(/usable area/);
    expect(() => add(sectors(61 * MiB), sectors(62 * MiB))).not.toThrow();
  });

  it("refuses a table whose checksum is wrong, or that is not there", () => {
    const disk = memoryDisk(DISK);
    expect(() => readGpt(disk.read, { diskBytes: DISK })).toThrow(/no GPT/);
    const writes = gptWrites(windowsLike(), { mbr: true });
    const entries = writes.find((w) => w.offset === 1024)!;
    entries.bytes[100] ^= 0xff;
    disk.write(writes);
    expect(() => readGpt(disk.read, { diskBytes: DISK })).toThrow(/entries fail their checksum/);
  });

  it("refuses a table whose checksums hold but whose partitions overlap", () => {
    const disk = memoryDisk(DISK);
    const writes = gptWrites(windowsLike(), { mbr: true });
    // Move C: (slot 1) to start inside the ESP, then make every checksum match again.
    const table = writes.find((w) => w.offset === 1024)!.bytes;
    table.writeBigUInt64LE(BigInt(4096), 128 + 32);
    for (const w of writes.filter((w) => w.bytes.subarray(0, 8).toString("latin1") === "EFI PART")) {
      w.bytes.writeUInt32LE(crc32(table.subarray(0, 128 * 128)), 88);
      w.bytes.writeUInt32LE(0, 16);
      w.bytes.writeUInt32LE(crc32(w.bytes.subarray(0, 92)), 16);
    }
    disk.write(writes);
    expect(() => readGpt(disk.read, { diskBytes: DISK })).toThrow(/overlap/);
  });

  it("refuses a table whose backup is not at the end of the disk, as on a disk that has since grown", () => {
    const disk = memoryDisk(DISK);
    disk.write(gptWrites(windowsLike(), { mbr: true }));
    expect(() => readGpt(disk.read, { diskBytes: DISK * 2 })).toThrow(/backup/);
  });
});
