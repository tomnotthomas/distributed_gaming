// Rental mode: reading what Swiff OS needs from a PC (rental.cjs), where it
// goes, the exact install and switch steps, and how the screen words it all
// (rental.ts). The facts fixture is what the read-only script returned on a
// real host PC: a Ryzen laptop with a 1 TB NVMe disk, C: and a recovery
// partition after it.

import { describe, expect, it, vi } from "vitest";
import { emptyGpt, withPartitions } from "../gpt.cjs";
import {
  bitlockerState,
  factsOf,
  freeSpans,
  gamesDriveOf,
  gpuVendor,
  imageLayout,
  installPlan,
  libraryDrives,
  readRental,
  rentalOf,
  SWIFF_OS,
  SWIFF_OS_BYTES,
  switchPlan,
  tpmMaker,
  TYPE,
  type RentalRead,
} from "../rental.cjs";
import { firmwareChecks, isReady, pcChecks, rentalStatus } from "./rental";
import FACTS from "./test/rental-facts.json";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** The fixture PC, with `change` applied to its raw facts. */
const pc = (change: (raw: typeof FACTS) => object = (raw) => raw, libraries = [{ letter: "C", games: 3 }]) =>
  rentalOf(change(structuredClone(FACTS)), libraries);

describe("reading the PC", () => {
  it("reads the fixture PC as ready but for Fast Startup", () => {
    const { facts } = pc();
    expect(facts).toMatchObject({
      uefi: true,
      secureBoot: true,
      tpm: { present: true, maker: "AMD", firmware: true },
      iommu: true,
      fastStartup: true,
      gpus: [{ name: "AMD Radeon(TM) Graphics", vendor: "amd" }],
      bootEntry: null,
    });
    expect(facts.partitions.map((p) => p.letter)).toEqual([null, null, "C", null]);
    expect(facts.volumes).toEqual([
      {
        letter: "C",
        fs: "NTFS",
        label: "Windows",
        size: 1022803046400,
        free: 694908047360,
        fixed: true,
        bitlocker: "off",
      },
    ]);
  });

  it("knows graphics cards by their PCI vendor, whatever Windows calls them", () => {
    expect(gpuVendor("PCI\\VEN_10DE&DEV_2704")).toBe("nvidia");
    expect(gpuVendor("PCI\\VEN_1002&DEV_744C")).toBe("amd");
    expect(gpuVendor("PCI\\VEN_8086&DEV_A780")).toBe("intel");
    expect(gpuVendor("ROOT\\BasicDisplay")).toBe("other");
  });

  it("reads BitLocker from the shell's protection state", () => {
    expect([1, 2, 3, 5, 6, 0, null].map(bitlockerState)).toEqual(["on", "off", "on", "on", "on", null, null]);
  });

  it("tells a TPM in the processor from one on its own chip", () => {
    expect(tpmMaker("-TPM Manufacturer ID: INTC")).toEqual({ maker: "INTC", firmware: true });
    expect(tpmMaker("-TPM Manufacturer ID: IFX")).toEqual({ maker: "IFX", firmware: false });
    expect(tpmMaker("")).toEqual({ maker: null, firmware: null });
  });

  it("leaves what it could not read as null, never as a pass", () => {
    expect(factsOf({})).toMatchObject({
      uefi: null,
      secureBoot: null,
      tpm: { present: null },
      iommu: null,
      fastStartup: null,
      gpus: [],
      volumes: [],
    });
    expect(factsOf("garbage").secureBoot).toBeNull();
  });

  it("leaves the IOMMU unread when the Device Guard read failed and came back as [null]", () => {
    expect(factsOf({ securityProperties: [null] }).iommu).toBeNull();
    expect(factsOf({ securityProperties: [1, 2] }).iommu).toBe(false);
    expect(factsOf({ securityProperties: [1, 2, 3] }).iommu).toBe(true);
  });

  it("is installed only with its boot entry recorded and its root partition on a disk", () => {
    expect(pc().installed).toBe(false);
    const entry = "{6a1f3c2e-0d4b-4e8a-9f7c-2b1d3e4f5a60}";
    expect(pc((raw) => ({ ...raw, bootEntry: entry })).installed).toBe(false);
    const root = {
      disk: 0,
      number: 6,
      letter: "",
      type: `{${TYPE.root}}`,
      offset: 998842040320,
      size: 8 * GiB,
    };
    expect(pc((raw) => ({ ...raw, bootEntry: entry, partitions: [...raw.partitions, root] })).installed).toBe(
      true,
    );
  });

  it("reads nothing off Windows, and nothing when the script fails", async () => {
    expect(await readRental({ platform: "linux" })).toBeNull();
    const run = vi.fn(async () => "not json");
    expect(await readRental({ platform: "win32", run, libraries: [] })).toBeNull();
    const ok = await readRental({ platform: "win32", run: async () => JSON.stringify(FACTS), libraries: [] });
    expect(ok?.facts.secureBoot).toBe(true);
  });
});

describe("where Swiff OS goes", () => {
  it("takes a fixed 24,192 MiB, the image's layout", () => {
    expect(SWIFF_OS_BYTES).toBe(24192 * MiB);
    expect(SWIFF_OS.partitions.map((p) => p.role)).toEqual([
      "esp",
      "root-a",
      "verity-a",
      "root-b",
      "verity-b",
      "scratch",
    ]);
  });

  it("shrinks C: from its end by exactly Swiff OS's size, up to the recovery partition", () => {
    const [target] = pc().targets;
    const c = FACTS.partitions[2]!;
    expect(target).toMatchObject({ id: "shrink:C", kind: "shrink", letter: "C", disk: 0, partition: 3 });
    if (target?.kind !== "shrink") throw new Error("not a shrink");
    expect(target.start % MiB).toBe(0);
    expect(target.start).toBe(c.offset + target.size);
    expect(target.start + SWIFF_OS_BYTES).toBeLessThanOrEqual(c.offset + c.size);
    expect(c.offset + c.size - (target.start + SWIFF_OS_BYTES)).toBeLessThan(MiB);
  });

  it("prefers free space on a disk to shrinking a drive", () => {
    const second = { number: 1, style: "GPT", size: 500 * GiB, sector: 512, bus: "SATA", system: false };
    const { targets } = pc((raw) => ({ ...raw, disks: [...raw.disks, second] }));
    expect(targets.map((t) => t.id)).toEqual([`free:1:${MiB}`, "shrink:C"]);
  });

  it("never offers the system disk as free space when its partitions could not be read", () => {
    const { targets } = pc((raw) => ({ ...raw, partitions: [] }));
    expect(targets.some((t) => t.kind === "free")).toBe(false);
  });

  it("finds the gaps between partitions, MiB-aligned, leaving the end for the backup table", () => {
    const disk = { number: 0, gpt: true, size: 100 * GiB, sector: 512, usb: false, system: true };
    const parts = [
      { disk: 0, number: 1, letter: null, type: TYPE.esp, offset: MiB, size: 100 * MiB },
      { disk: 0, number: 2, letter: "C", type: TYPE.windowsData, offset: 200 * MiB, size: 50 * GiB },
    ];
    expect(freeSpans(disk, parts)).toEqual([
      { offset: 101 * MiB, bytes: 99 * MiB },
      { offset: 200 * MiB + 50 * GiB, bytes: 100 * GiB - MiB - (200 * MiB + 50 * GiB) },
    ]);
  });

  it("never shrinks a drive that would be left with too little, a USB disk, or an MBR disk", () => {
    const full = pc((raw) => ({ ...raw, volumes: raw.volumes.map((v) => ({ ...v, free: 30 * GiB })) }));
    expect(full.targets).toEqual([]);
    const usb = pc((raw) => ({ ...raw, disks: raw.disks.map((d) => ({ ...d, bus: "USB" })) }));
    expect(usb.targets).toEqual([]);
    const mbr = pc((raw) => ({ ...raw, disks: raw.disks.map((d) => ({ ...d, style: "MBR" })) }));
    expect(mbr.targets).toEqual([]);
  });

  it("shares games from the drive whose Steam libraries hold the most", () => {
    const facts = pc().facts;
    expect(
      gamesDriveOf(facts, [
        { letter: "D", games: 2 },
        { letter: "C", games: 5 },
      ])?.letter,
    ).toBe("C");
    expect(gamesDriveOf(facts, [])).toBeNull();
  });

  it("counts each library's games by drive", () => {
    const files = {
      readFileSync: () =>
        '"libraryfolders" { "0" { "path" "C:\\\\Steam" } "1" { "path" "D:\\\\SteamLibrary" } }',
      readdirSync: (dir: string) =>
        dir.startsWith("D:")
          ? ["appmanifest_730.acf", "appmanifest_570.acf", "other.txt"]
          : ["appmanifest_10.acf"],
    };
    expect(libraryDrives({ platform: "win32", steamPath: "C:\\Steam", env: {}, files })).toEqual([
      { letter: "C", games: 1 },
      { letter: "D", games: 2 },
    ]);
  });
});

describe("the install plan", () => {
  it("lists the steps in order, each with its operations and commands, as a dry run", () => {
    const plan = installPlan(pc());
    expect(plan.dryRun).toBe(true);
    expect(plan.steps.map((s) => s.id)).toEqual([
      "check",
      "fast-startup",
      "room",
      "partitions",
      "write",
      "boot-entry",
      "games",
    ]);
    for (const step of plan.steps) {
      expect(step.ops.length).toBeGreaterThan(0);
      expect(step.commands.length).toBeGreaterThan(0);
    }
  });

  it("shrinks C: and lays Swiff OS's six partitions end to end in the room it made", () => {
    const rental = pc();
    const target = rental.targets[0]!;
    const plan = installPlan(rental);
    const room = plan.steps.find((s) => s.id === "room")!;
    expect(room.ops).toEqual([
      { op: "shrink", disk: 0, partition: 3, size: (target as { size: number }).size },
    ]);
    expect(room.commands).toEqual([
      `Resize-Partition -DiskNumber 0 -PartitionNumber 3 -Size ${(target as { size: number }).size}`,
    ]);
    const add = plan.steps.find((s) => s.id === "partitions")!.ops[0]!;
    if (add.op !== "gpt-add") throw new Error("not gpt-add");
    let at = target.start;
    for (const [i, part] of add.partitions.entries()) {
      expect(part.offset).toBe(at);
      expect(part.type).toBe(SWIFF_OS.partitions[i]!.type);
      at += part.bytes;
    }
    expect(at - target.start).toBe(SWIFF_OS_BYTES);
  });

  it("writes only the boot partition and slot A, and points the boot entry at Swiff OS's own ESP", () => {
    const plan = installPlan(pc());
    const writes = plan.steps.find((s) => s.id === "write")!.ops;
    expect(writes.map((o) => (o.op === "write" ? o.source : null))).toEqual([
      "esp",
      "root-x86-64",
      "root-x86-64-verity",
    ]);
    const entry = plan.steps.find((s) => s.id === "boot-entry")!;
    const esp = writes[0]!;
    expect(entry.ops).toEqual([
      {
        op: "boot-entry",
        disk: 0,
        offset: esp.op === "write" ? esp.offset : -1,
        path: "\\EFI\\BOOT\\BOOTX64.EFI",
        title: "Swiff OS",
      },
    ]);
    expect(entry.commands).toContain("bcdedit /set '{fwbootmgr}' displayorder $entry /addlast");
  });

  it("checks Secure Boot's db, the TPM's certificate and the shrink limit as administrator first", () => {
    const check = installPlan(pc()).steps[0]!;
    expect(check.commands.join("\n")).toMatch(/Microsoft UEFI CA 2023/);
    expect(check.commands.join("\n")).toMatch(/Get-TpmEndorsementKeyInfo/);
    expect(check.commands.join("\n")).toMatch(/Get-PartitionSupportedSize -DiskNumber 0 -PartitionNumber 3/);
  });

  it("leaves out what is already done: Fast Startup off, the games drive already named", () => {
    const done = pc((raw) => ({
      ...raw,
      fastStartup: 0,
      volumes: raw.volumes.map((v) => ({ ...v, label: "SWIFFGAMES" })),
    }));
    expect(installPlan(done).steps.map((s) => s.id)).toEqual([
      "check",
      "room",
      "partitions",
      "write",
      "boot-entry",
    ]);
  });

  it("uses free space as it is, with no shrink", () => {
    const second = { number: 1, style: "GPT", size: 500 * GiB, sector: 512, bus: "SATA", system: false };
    const rental = pc((raw) => ({ ...raw, disks: [...raw.disks, second] }));
    const plan = installPlan(rental, { target: `free:1:${MiB}` });
    expect(plan.steps.map((s) => s.id)).not.toContain("room");
    expect(plan.target?.disk).toBe(1);
  });

  it("refuses a chosen drive that is no longer there, rather than picking another", () => {
    expect(() => installPlan(pc(), { target: "shrink:D" })).toThrow(/no longer available/);
    expect(installPlan(pc(), { target: null }).target?.id).toBe("shrink:C");
  });

  it("refuses a PC with nowhere to put Swiff OS", () => {
    const full = pc((raw) => ({ ...raw, volumes: [] }));
    expect(() => installPlan(full)).toThrow(/24 GB/);
  });

  it("copies ids and names from the image it installs", () => {
    let gpt = emptyGpt({ diskBytes: 25 * GiB, diskId: "0f0e0d0c-0b0a-4908-8706-050403020100" });
    let first = 2048;
    gpt = withPartitions(
      gpt,
      SWIFF_OS.partitions.map((p, i) => {
        const add = {
          type: p.type,
          id: `00000000-0000-4000-8000-00000000000${i}`,
          name: ["esp", "swiffos_0.1.0", "swiffos_0.1.0", "_empty", "_empty", "swiff-scratch"][i]!,
          first,
          last: first + p.bytes / 512 - 1,
        };
        first += p.bytes / 512;
        return add;
      }),
    );
    const layout = imageLayout(gpt);
    expect(layout.map((p) => [p.role, p.name])).toEqual([
      ["esp", "esp"],
      ["root-a", "swiffos_0.1.0"],
      ["verity-a", "swiffos_0.1.0"],
      ["root-b", "_empty"],
      ["verity-b", "_empty"],
      ["scratch", "swiff-scratch"],
    ]);
    const add = installPlan(pc(), { layout }).steps.find((s) => s.id === "partitions")!.ops[0]!;
    expect(add.op === "gpt-add" && add.partitions[1]!.id).toBe("00000000-0000-4000-8000-000000000001");
    expect(() => imageLayout({ ...gpt, entries: gpt.entries.slice(1) })).toThrow(/unexpected/);
  });
});

describe("the switch", () => {
  it("starts sharing with Swiff OS first in the boot order and BootNext, then restarts", () => {
    const plan = switchPlan("start");
    expect(plan.steps.flatMap((s) => s.ops)).toEqual([
      { op: "boot-first", entry: "swiff" },
      { op: "boot-next", entry: "swiff" },
      { op: "restart" },
    ]);
    expect(plan.steps.flatMap((s) => s.commands)).toEqual([
      "$entry = (Get-Content $env:ProgramData\\Swiff\\boot-entry.txt -TotalCount 1).Trim()",
      "bcdedit /set '{fwbootmgr}' displayorder $entry /addfirst",
      "bcdedit /set '{fwbootmgr}' bootsequence $entry",
      "shutdown /r /t 0",
    ]);
  });

  it("stops sharing by putting Windows first again", () => {
    expect(switchPlan("stop").steps.flatMap((s) => s.ops)).toEqual([{ op: "boot-first", entry: "windows" }]);
  });
});

describe("what the screen says", () => {
  const status = (read: RentalRead, target: string | null = null) => rentalStatus(read, target);

  it("says the fixture PC is ready, with Fast Startup left to Swiff", () => {
    const read = pc();
    expect(status(read)).toMatchObject({
      title: "Ready for rental mode",
      bios: [],
      fixes: [],
      canInstall: true,
    });
    expect(pcChecks(read, null).find((c) => c.id === "fast-startup")).toMatchObject({ state: "swiff" });
    expect(pcChecks(read, null).find((c) => c.id === "space")).toMatchObject({
      value: "24 GB from C:",
      state: "ok",
    });
  });

  it("lists each BIOS change, and offers no install until they are made", () => {
    const read = pc((raw) => ({ ...raw, secureBoot: 0, securityProperties: [1, 2] }));
    expect(status(read)).toMatchObject({
      title: "2 changes in the BIOS",
      bios: ["Turn on Secure Boot.", "Turn on the IOMMU (AMD-Vi or Intel VT-d) and Kernel DMA Protection."],
      canInstall: false,
    });
  });

  it("holds a BitLocker games drive, an NVIDIA card and a full disk against the PC, in Windows", () => {
    const read = pc((raw) => ({
      ...raw,
      gpus: [{ name: "NVIDIA GeForce RTX 4080", pnp: "PCI\\VEN_10DE&DEV_2704" }],
      volumes: raw.volumes.map((v) => ({ ...v, bitlocker: 1, free: 20 * GiB })),
    }));
    const s = status(read);
    expect(s.title).toBe("3 things to change first");
    expect(s.fixes).toHaveLength(3);
    expect(s.canInstall).toBe(false);
  });

  it("never counts the Secure Boot db or the TPM certificate as ready: they are not checked yet", () => {
    const keys = firmwareChecks(pc()).filter((c) => c.id === "db" || c.id === "ek");
    expect(keys).toEqual([
      expect.objectContaining({ value: "Not checked yet", state: "unchecked" }),
      expect.objectContaining({ value: "Not checked yet", state: "unchecked" }),
    ]);
    expect(keys.some((c) => isReady(c.state))).toBe(false);
    expect(status(pc())).toMatchObject({ ready: 8, of: 10, canInstall: true });
  });

  it("says BitLocker was not read when it was not, rather than off", () => {
    const read = pc((raw) => ({ ...raw, volumes: raw.volumes.map((v) => ({ ...v, bitlocker: null })) }));
    expect(pcChecks(read, null).find((c) => c.id === "games")).toMatchObject({
      value: "C:, BitLocker not read",
      state: "unread",
    });
  });

  it("rates a TPM on its own chip lower, but lets it through (D3, still open)", () => {
    const read = pc((raw) => ({ ...raw, tpmInfo: "-TPM Manufacturer ID: IFX" }));
    expect(firmwareChecks(read).find((c) => c.id === "tpm")).toMatchObject({
      value: "2.0, separate chip: lower tier",
      state: "ok",
    });
  });
});
