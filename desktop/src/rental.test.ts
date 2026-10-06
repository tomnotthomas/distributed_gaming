// Rental mode: reading what Swiff OS needs from a PC (rental.cjs), where it
// goes, the exact install and switch steps, and how the screen words it all
// (rental.ts). The facts fixture is what the read-only script returned on a
// real host PC: a Ryzen laptop with a 1 TB NVMe disk, C: and a recovery
// partition after it.

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { emptyGpt, withPartitions } from "../gpt.cjs";
import {
  bitlockerState,
  factsOf,
  freeSpans,
  gamesDriveOf,
  gpuDevice,
  gpuVendor,
  imageLayout,
  installPlan,
  libraryDrives,
  MOK_CERT,
  mokCode,
  mokPlan,
  mokRequest,
  mokSteps,
  readRental,
  rentalOf,
  SWIFF_OS,
  SWIFF_OS_BYTES,
  switchPlan,
  tpmMaker,
  TYPE,
  type RentalRead,
} from "../rental.cjs";
import type { NvidiaDriver } from "../nvidia.cjs";
import { NVIDIA_FIRST_SUPPORTED, supportedCard } from "../nvidia.cjs";
import {
  codeGroups,
  firmwareChecks,
  isReady,
  nvidiaStage,
  nvidiaSupported,
  nvidiaVersion,
  pcChecks,
  rentalStatus,
} from "./rental";
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
      gpus: [{ name: "AMD Radeon(TM) Graphics", vendor: "amd", device: 0x1681, driver: null }],
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

  it("reads a card's PCI device number, which tells its generation", () => {
    expect(gpuDevice("PCI\\VEN_10DE&DEV_2704&SUBSYS_51111458&REV_A1")).toBe(0x2704);
    expect(gpuDevice("ROOT\\BasicDisplay")).toBeNull();
  });

  it("says an NVIDIA driver's version as NVIDIA numbers it, not as Windows does", () => {
    expect(nvidiaVersion("32.0.15.6094")).toBe("560.94");
    expect(nvidiaVersion("31.0.15.3623")).toBe("536.23");
    expect(nvidiaVersion("")).toBeNull();
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

  it("finds the games drive from where Steam says it is installed, outside Program Files", async () => {
    const files = {
      readFileSync: (file: string) => {
        if (!file.toLowerCase().startsWith("d:\\steam")) throw new Error("ENOENT");
        return '"libraryfolders" { "0" { "path" "D:\\\\Steam" } }';
      },
      readdirSync: (dir: string) => (dir.startsWith("d:\\steam") ? ["appmanifest_730.acf"] : []),
    };
    const read = await readRental({
      platform: "win32",
      run: async () => JSON.stringify(FACTS),
      steamPath: async () => "d:\\steam",
      env: { "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramFiles: "C:\\Program Files" },
      files,
    });
    expect(read?.games).toMatchObject({ letter: "D", games: 1 });
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

  it("offers no free space on any disk when no partitions could be read at all", () => {
    const games = { number: 1, style: "GPT", size: 500 * GiB, sector: 512, bus: "SATA", system: false };
    const { targets } = pc((raw) => ({ ...raw, disks: [...raw.disks, games], partitions: [] }));
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

  it("counts Steam's own folder once when the registry and the library list spell it differently", () => {
    const files = {
      readFileSync: () =>
        '"libraryfolders" { "0" { "path" "C:\\\\Program Files (x86)\\\\Steam" } "1" { "path" "D:\\\\SteamLibrary" } }',
      readdirSync: (dir: string) =>
        dir.startsWith("D:") ? ["appmanifest_730.acf", "appmanifest_570.acf"] : ["appmanifest_10.acf"],
    };
    const steamPath = "c:\\program files (x86)\\steam";
    expect(libraryDrives({ platform: "win32", steamPath, env: {}, files })).toEqual([
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
      "mok",
      "mok-restart",
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
      "mok",
      "mok-restart",
    ]);
  });

  it("takes SWIFFGAMES off an old games drive before naming the new one, so only one volume has it", () => {
    const d = {
      letter: "D",
      fs: "NTFS",
      label: "SWIFFGAMES",
      size: 500 * GiB,
      free: 100 * GiB,
      fixed: true,
      bitlocker: 2,
    };
    const e = { ...d, letter: "E", label: "Games" };
    const plan = installPlan(
      pc((raw) => ({ ...raw, volumes: [...raw.volumes, d, e] }), [{ letter: "E", games: 9 }]),
    );
    expect(plan.steps.map((s) => s.id).slice(-4, -2)).toEqual(["games-clear", "games"]);
    const clear = plan.steps.find((s) => s.id === "games-clear")!;
    expect(clear.ops).toEqual([{ op: "label", letter: "D", label: "" }]);
    expect(clear.commands).toEqual(["Set-Volume -DriveLetter D -NewFileSystemLabel ''"]);
    expect(plan.steps.find((s) => s.id === "games")!.ops).toEqual([
      { op: "label", letter: "E", label: "SWIFFGAMES" },
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

describe("Swiff's key, enrolled once as a MOK", () => {
  it("queues the key with a one-time code, then restarts once into Swiff OS for the owner to confirm it", () => {
    const plan = installPlan(pc(), { code: "48217730" });
    expect(plan.mok).toEqual({ code: "48217730" });
    const [mok, restart] = plan.steps.slice(-2);
    expect(mok!.ops).toEqual([{ op: "mok-import", cert: MOK_CERT, code: "48217730" }]);
    expect(mok!.commands.join("\n")).toMatch(/mokutil --import swiffos-key\.cer --simple-hash/);
    expect(mok!.commands.join("\n")).toMatch(/MokNew-605dab50-e046-4300-abb6-3dd810dd8b23/);
    expect(mok!.commands.join("\n")).toMatch(/MokAuth-605dab50-.*the one-time code/);
    expect(plan.steps.flatMap((s) => s.commands).join("\n")).not.toContain("48217730");
    expect(restart!.ops).toEqual([{ op: "boot-next", entry: "swiff" }, { op: "restart" }]);
    expect(restart!.commands).toContain("bcdedit /set '{fwbootmgr}' bootsequence $entry");
  });

  it("confirms the key again after a missed screen: the same request with a new code, and one restart", () => {
    const plan = mokPlan("11112222");
    expect(plan).toMatchObject({ kind: "mok", dryRun: true, mok: { code: "11112222" } });
    expect(plan.steps).toEqual(mokSteps("11112222"));
    expect(plan.steps.flatMap((s) => s.ops)).toEqual([
      { op: "mok-import", cert: MOK_CERT, code: "11112222" },
      { op: "boot-next", entry: "swiff" },
      { op: "restart" },
    ]);
    expect(mokPlan().mok!.code).toMatch(/^\d{8}$/);
  });

  it("makes a new 8-digit code for each plan", () => {
    expect(installPlan(pc()).mok!.code).toMatch(/^\d{8}$/);
    let n = 0;
    expect(mokCode(() => n++ % 10)).toBe("01234567");
  });

  it("writes MokNew as one X.509 signature list owned by shim, and MokAuth as mokutil --simple-hash does", () => {
    const cert = Buffer.from("308201", "hex");
    const { guid, attributes, MokNew, MokAuth } = mokRequest(cert, "1234");
    expect(guid).toBe("605dab50-e046-4300-abb6-3dd810dd8b23");
    // Non-volatile, boot service and runtime access.
    expect(attributes).toBe(7);
    expect(MokNew.toString("hex")).toBe(
      [
        "a159c0a5e494a74a87b5ab155c2bf072", // EFI_CERT_X509_GUID
        "2f000000", // SignatureListSize: 28 + 16 + 3
        "00000000", // SignatureHeaderSize
        "13000000", // SignatureSize: 16 + 3
        "50ab5d6046e00043abb63dd810dd8b23", // SignatureOwner: SHIM_LOCK_GUID
        "308201",
      ].join(""),
    );
    // MokManager's compute_pw_hash: SHA-256 over MokNew, then the code as CHAR16s.
    const want = createHash("sha256").update(MokNew).update(Buffer.from("3100320033003400", "hex")).digest();
    expect(MokAuth.equals(want)).toBe(true);
  });

  it("shows the code in two halves of four", () => {
    expect(codeGroups("48217730")).toBe("4821 7730");
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

  it("holds a BitLocker games drive, an NVIDIA card too old for Swiff OS and a full disk against the PC, in Windows", () => {
    const read = pc((raw) => ({
      ...raw,
      gpus: [{ name: "NVIDIA GeForce GTX 1080", pnp: "PCI\\VEN_10DE&DEV_1B80" }],
      volumes: raw.volumes.map((v) => ({ ...v, bitlocker: 1, free: 20 * GiB })),
    }));
    const s = status(read);
    expect(s.title).toBe("3 things to change first");
    expect(s.fixes).toHaveLength(3);
    expect(s.canInstall).toBe(false);
  });

  describe("the graphics card", () => {
    type Card = { name: string; pnp: string; driver?: string };
    /** NVIDIA's driver on the games drive, as the owner installed it on 6 Oct 2026. */
    const INSTALLED: NvidiaDriver = {
      version: "595.91.07",
      bytes: 355_018_600,
      folder: "C:\\SwiffOS\\nvidia\\595.91.07",
      installed: true,
      accepted: { at: "2026-10-06T08:00:00.000Z" },
    };
    const MISSING: NvidiaDriver = { ...INSTALLED, installed: false, accepted: null };
    /** This PC with NVIDIA in rental mode switched on (the app's --nvidia-rental), and `driver` on its games drive. */
    const on = (gpus: Card[], driver: NvidiaDriver = INSTALLED): RentalRead => ({
      ...pc((raw) => ({ ...raw, gpus })),
      nvidiaRental: true,
      nvidiaDriver: driver,
    });
    /** The Graphics row, with NVIDIA on and its driver installed. */
    const gpu = (...gpus: Card[]) => pcChecks(on(gpus), null).find((c) => c.id === "gpu");
    const RTX_4080 = {
      name: "NVIDIA GeForce RTX 4080",
      pnp: "PCI\\VEN_10DE&DEV_2704",
      driver: "32.0.15.6094",
    };

    it("keeps NVIDIA off while it is in testing, and says so for a card Swiff OS will run", () => {
      const read = pc((raw) => ({
        ...raw,
        gpus: [{ name: "NVIDIA GeForce RTX 4080", pnp: "PCI\\VEN_10DE&DEV_2704", driver: "32.0.15.6094" }],
      }));
      expect(read.nvidiaRental).toBe(false);
      expect(pcChecks(read, null).find((c) => c.id === "gpu")).toEqual({
        id: "gpu",
        label: "Graphics",
        value: "RTX 4080: in testing",
        state: "blocked",
        detail:
          "NVIDIA support is in testing: Swiff OS will run it on NVIDIA's 595 driver, Windows on 560.94.",
      });
      expect(status(read)).toMatchObject({
        fixes: [
          "NVIDIA support is in testing: rental mode takes the RTX 4080 once it passes. Sharing from Windows works as before.",
        ],
        canInstall: false,
      });
    });

    it("with NVIDIA on and its driver installed, takes a card from the GTX 16 and RTX 20 series on, and names the driver on each side", () => {
      expect(gpu(RTX_4080)).toEqual({
        id: "gpu",
        label: "Graphics",
        value: "RTX 4080",
        state: "ok",
        detail: "Swiff OS runs it on NVIDIA's 595.91.07 driver, installed 6 Oct 2026, Windows on 560.94.",
      });
      expect(gpu({ name: "NVIDIA GeForce RTX 2060", pnp: "PCI\\VEN_10DE&DEV_1F08" })?.state).toBe("ok");
      expect(gpu({ name: "NVIDIA GeForce GTX 1660 Ti", pnp: "PCI\\VEN_10DE&DEV_2182" })?.state).toBe("ok");
      expect(gpu({ name: "NVIDIA GeForce RTX 5090", pnp: "PCI\\VEN_10DE&DEV_2B85" })?.state).toBe("ok");
    });

    it("with NVIDIA on, asks the owner to install NVIDIA's driver, which Swiff does not ship", () => {
      const read = on([RTX_4080], MISSING);
      expect(pcChecks(read, null).find((c) => c.id === "gpu")).toMatchObject({
        value: "RTX 4080: needs NVIDIA's driver",
        state: "blocked",
        detail: "Swiff OS runs it on NVIDIA's 595 driver, which you install below, Windows on 560.94.",
      });
      expect(status(read)).toMatchObject({
        title: "One thing to change first",
        fixes: [
          "Install NVIDIA's driver for the RTX 4080 below: you accept NVIDIA's licence, and it comes from Ubuntu onto C:.",
        ],
        canInstall: false,
      });
    });

    it("asks the owner to accept again when the driver is there but not their acceptance of this licence and the current terms", () => {
      const read = on([RTX_4080], { ...INSTALLED, accepted: null });
      expect(nvidiaStage(read, null)).toBe("driver");
      expect(pcChecks(read, null).find((c) => c.id === "gpu")).toMatchObject({
        value: "RTX 4080: accept NVIDIA's licence again",
        state: "blocked",
        detail:
          "Swiff OS runs it on NVIDIA's 595.91.07 driver, once you accept its licence and Swiff's terms below, Windows on 560.94.",
      });
      expect(status(read)).toMatchObject({
        fixes: [
          "Accept NVIDIA's licence and Swiff's terms for the RTX 4080 again below: the driver already on C: stays.",
        ],
        canInstall: false,
      });
    });

    it("says so when Swiff has paused NVIDIA cards, driver or not, and holds nothing back when it could not ask", () => {
      const paused = rentalStatus(on([RTX_4080]), null, false);
      expect(paused.fixes).toEqual([
        "Swiff has paused rental mode on NVIDIA cards for now: the RTX 4080 cannot host in Swiff OS until it is back. Sharing from Windows works as before.",
      ]);
      expect(pcChecks(on([RTX_4080], MISSING), null, false).find((c) => c.id === "gpu")).toMatchObject({
        value: "RTX 4080: paused",
        state: "blocked",
      });
      // The server refuses an NVIDIA machine itself while it is off: an unread switch is not a pause.
      expect(rentalStatus(on([RTX_4080]), null, null).canInstall).toBe(true);
      expect(rentalStatus(on([RTX_4080]), null, true).canInstall).toBe(true);
    });

    it("draws the line for NVIDIA cards where the driver's own check does", () => {
      expect(NVIDIA_FIRST_SUPPORTED).toBe(0x1e00);
      for (const device of [0x1b80, 0x1dff, 0x1e00, 0x1e02, 0x2182, 0x2704]) {
        const card = { name: "card", vendor: "nvidia" as const, device, driver: null };
        expect(supportedCard([card])).toBe(nvidiaSupported(card));
      }
    });

    it("reads NVIDIA's driver on the games drive only while NVIDIA rental is on", () => {
      const seen: (string | null)[] = [];
      const driver = (letter: string | null) => (seen.push(letter), INSTALLED);
      expect(rentalOf(FACTS, [{ letter: "C", games: 3 }], { nvidiaDriver: driver }).nvidiaDriver).toBeNull();
      expect(seen).toEqual([]);
      expect(
        rentalOf(FACTS, [{ letter: "C", games: 3 }], { nvidiaRental: true, nvidiaDriver: driver })
          .nvidiaDriver,
      ).toBe(INSTALLED);
      expect(seen).toEqual(["C"]);
    });

    it("holds an older NVIDIA card against the PC, and says what the owner can do", () => {
      const read = pc((raw) => ({
        ...raw,
        gpus: [{ name: "NVIDIA GeForce GTX 1080", pnp: "PCI\\VEN_10DE&DEV_1B80" }],
      }));
      expect(pcChecks(read, null).find((c) => c.id === "gpu")).toMatchObject({
        value: "GTX 1080: too old",
        state: "blocked",
        detail: "Swiff OS's NVIDIA 595 driver runs GeForce GTX 16 and RTX 20 series cards and newer.",
      });
      expect(status(read).fixes).toEqual([
        "Fit a GeForce GTX 16 or RTX 20 series card or newer to use rental mode: Swiff OS's NVIDIA driver does not run the GTX 1080. Sharing from Windows works as before.",
      ]);
    });

    it("judges the NVIDIA card Swiff OS can run, not an older one beside it", () => {
      expect(
        gpu(
          { name: "NVIDIA GeForce GTX 1080", pnp: "PCI\\VEN_10DE&DEV_1B80" },
          { name: "NVIDIA GeForce RTX 3080", pnp: "PCI\\VEN_10DE&DEV_2206" },
        ),
      ).toMatchObject({ value: "RTX 3080", state: "ok" });
    });

    it("does not hold an NVIDIA card against the PC when its model was not read", () => {
      expect(gpu({ name: "NVIDIA GeForce RTX 4080", pnp: "PCI\\VEN_10DE" })).toMatchObject({
        value: "RTX 4080: model not read",
        state: "unread",
      });
    });

    it("runs AMD and Intel graphics on Mesa", () => {
      expect(
        gpu({ name: "AMD Radeon RX 7800 XT", pnp: "PCI\\VEN_1002&DEV_747E", driver: "32.0.11037.4004" }),
      ).toMatchObject({
        value: "Radeon RX 7800 XT",
        state: "ok",
        detail: "Swiff OS runs it on the open Mesa driver, Windows on 32.0.11037.4004.",
      });
    });
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

  it("never swaps in another drive when the chosen one is gone: the owner chooses again", () => {
    const read = pc();
    expect(pcChecks(read, "shrink:D").find((c) => c.id === "space")).toMatchObject({
      value: "The drive you chose is no longer available: choose again",
      state: "blocked",
    });
    expect(status(read, "shrink:D")).toMatchObject({
      fixes: ["The drive you chose for Swiff OS is no longer available: choose again where it goes."],
      canInstall: false,
    });
    expect(status(read, "shrink:C").canInstall).toBe(true);
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
