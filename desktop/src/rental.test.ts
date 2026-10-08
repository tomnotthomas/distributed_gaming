// Rental mode: reading what Lanterel OS needs from a PC (rental.cjs), where it
// goes, the exact install and switch steps, and how the screen words it all
// (rental.ts). The facts fixture is what the read-only script returned on a
// real host PC: a Ryzen laptop with a 1 TB NVMe disk, C: and a recovery
// partition after it.

import { createHash, X509Certificate } from "node:crypto";
import { projectOf } from "@swiff/error-tracking";
import { describe, expect, it, vi } from "vitest";
import { emptyGpt, withPartitions } from "../gpt.cjs";
import { drivesOff, recoveryOf, recoveryStore } from "../recovery-key.cjs";
import { keyOf, keyStep, keyStore } from "../rental-key.cjs";
import { checksOf, expectOf, removalOf, removalStep, removalStore } from "../rental-removal.cjs";
import {
  bitlockerDrives,
  bitlockerState,
  BOOT_CHANGES,
  ekOf,
  errorReportsFile,
  factsOf,
  freeSpans,
  gamesDriveOf,
  gpuVendor,
  imageLayout,
  installOf,
  installPlan,
  keyRemovalPlan,
  libraryDrives,
  MOK_CERT,
  mokCode,
  mokPlan,
  mokRequest,
  mokSteps,
  readRental,
  removePlan,
  rentalOf,
  SWIFF_OS,
  SWIFF_OS_BYTES,
  shellOf,
  switchPlan,
  tpmMaker,
  uninstallPlan,
  TYPE,
  type RentalRead,
} from "../rental.cjs";
import { IDLE_RUN, type RentalRun, type RentalSetup } from "./model";
import {
  biosTitle,
  biosTodos,
  changedSoFar,
  codeGroups,
  drivesLine,
  failureOf,
  firmwareChecks,
  isReady,
  pcChecks,
  biosPath,
  checkBios,
  firmwareGuide,
  rentalLine,
  rentalReady,
  rentalScreen,
  rentalStage,
  rentalStepAt,
  runningTitleOf,
  stepLocked,
  waitingFor,
  windowsTodos,
} from "./rental";
import PROJECT_CASES from "../../packages/error-tracking/src/project-cases.json";
import EK from "./test/ek-chain.json";
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
      install: null,
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

  it("is installed only once the install recorded that it finished", () => {
    expect(pc().installed).toBe(false);
    const record = { disk: 0, bootEntry: 3, partitions: [], complete: false };
    expect(pc((raw) => ({ ...raw, install: record })).installed).toBe(false);
    expect(pc((raw) => ({ ...raw, install: { ...record, complete: true } })).installed).toBe(true);
  });

  it("reads what the install recorded, and drops what is malformed", () => {
    const install = installOf({
      complete: true,
      disk: 0,
      bitlocker: "C",
      fastStartup: true,
      shrink: { letter: "C", partition: 3, from: 100 * GiB, to: 76 * GiB },
      partitions: [
        { role: "esp", id: "3D7B64D1-2E0C-493B-958E-7F825AEC1F7C", offset: 76 * GiB, bytes: GiB },
        { role: "root-a", id: "not a guid", offset: 77 * GiB, bytes: 8 * GiB },
      ],
      bootEntry: { partition: "3D7B64D1-2E0C-493B-958E-7F825AEC1F7C", path: "\\EFI\\swiff\\shimx64.efi" },
      windowsEntry: 70000,
      labels: [
        { letter: "C", from: "Windows" },
        { letter: "?", from: "x" },
      ],
      mok: true,
    });
    expect(install).toEqual({
      complete: true,
      disk: 0,
      bitlocker: "C",
      fastStartup: true,
      shrink: { letter: "C", partition: 3, from: 100 * GiB, to: 76 * GiB },
      partitions: [{ role: "esp", id: "3d7b64d1-2e0c-493b-958e-7f825aec1f7c", offset: 76 * GiB, bytes: GiB }],
      bootEntry: { partition: "3d7b64d1-2e0c-493b-958e-7f825aec1f7c", path: "\\EFI\\swiff\\shimx64.efi" },
      windowsEntry: null,
      labels: [{ letter: "C", from: "Windows" }],
      mok: true,
    });
    // A record from before kept numbers: still an entry, until the worker turns it into what it starts.
    expect(installOf({ bootEntry: 3, windowsEntry: 0 })).toMatchObject({
      bootEntry: { partition: null, path: null },
      windowsEntry: { partition: null, path: null },
    });
    expect(installOf("garbage")).toBeNull();
    expect(installOf({ shrink: { letter: "C" } })!.shrink).toBeNull();
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

describe("the TPM's EK certificate", () => {
  const lines = (...certs: string[]) => certs.map((c) => `ek-cert: ${c}`).join("\r\n");

  it("takes the one that is no CA's, with the intermediates Windows has beside it, never the root", () => {
    expect(ekOf(lines(EK.root, EK.intermediate, EK.ek))).toEqual({
      certificate: EK.ek,
      intermediates: [EK.intermediate],
    });
  });

  it("takes each certificate once, and skips lines that are not one", () => {
    const broken = EK.ek.slice(0, 200);
    expect(
      ekOf(
        `${lines(EK.ek, EK.intermediate, EK.intermediate)}\r\nek-cert: not-base64!\r\nwarning: x\r\n${lines(broken)}`,
      ),
    ).toEqual({
      certificate: EK.ek,
      intermediates: [EK.intermediate],
    });
  });

  it("takes the RSA 2048 EK's over an ECC P-256 EK's listed first, as swiff-attest uses that EK", () => {
    expect(ekOf(lines(EK.eccEk, EK.intermediate, EK.ek))).toEqual({
      certificate: EK.ek,
      intermediates: [EK.intermediate],
    });
    expect(ekOf(lines(EK.eccEk, EK.intermediate))).toEqual({
      certificate: EK.eccEk,
      intermediates: [EK.intermediate],
    });
  });

  it("takes an EK certificate whose key Node cannot read only after the RSA and ECC ones", () => {
    const publicKey = Object.getOwnPropertyDescriptor(X509Certificate.prototype, "publicKey")!.get!;
    const unreadable = vi.spyOn(X509Certificate.prototype, "publicKey", "get").mockImplementation(function (
      this: X509Certificate,
    ) {
      if (this.subject.includes("Test ECC EK")) throw new Error("unsupported key");
      return publicKey.call(this);
    });
    try {
      expect(ekOf(lines(EK.eccEk, EK.intermediate, EK.ek))).toEqual({
        certificate: EK.ek,
        intermediates: [EK.intermediate],
      });
      expect(ekOf(lines(EK.eccEk, EK.intermediate))).toEqual({
        certificate: EK.eccEk,
        intermediates: [EK.intermediate],
      });
    } finally {
      unreadable.mockRestore();
    }
  });

  it("takes the same EK whatever order Windows lists the certificates in, so the next Go live registers nothing", () => {
    const certs = [EK.eccEk, EK.ek, EK.intermediate, EK.root];
    const orders = (list: string[]): string[][] =>
      list.length <= 1
        ? [list]
        : list.flatMap((c, i) =>
            orders([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [c, ...rest]),
          );
    for (const order of orders(certs))
      expect(ekOf(lines(...order)), order.join(",")).toEqual({
        certificate: EK.ek,
        intermediates: [EK.intermediate],
      });
    // Intel PTT: the TPM's own ECC EK first, the RSA one only among Windows' downloads after it.
    expect(ekOf(lines(EK.eccEk, EK.root, EK.intermediate, EK.ek))).toEqual({
      certificate: EK.ek,
      intermediates: [EK.intermediate],
    });
  });

  it("is null when Windows read none, or only CAs", () => {
    expect(ekOf("")).toBeNull();
    expect(ekOf(lines(EK.root, EK.intermediate))).toBeNull();
  });

  it("is read as administrator, first in Go live and among the install's checks", () => {
    const [ek] = switchPlan("once").steps;
    expect(ek).toMatchObject({ id: "ek", ops: [{ op: "ek" }] });
    expect(ek!.commands.join("\n")).toMatch(/TpmReady\) \{ throw 'The TPM is not ready\.' \}/);
    expect(ek!.commands.join("\n")).toMatch(
      /ManufacturerCertificates\) \+ @\(\$info\.AdditionalCertificates\)/,
    );
    expect(switchPlan("start").steps[0]).toMatchObject({ id: "ek" });
    expect(switchPlan("stop").steps.some((s) => s.id === "ek")).toBe(false);
    expect(shellOf({ op: "check" })!.join("\n")).toMatch(/Get-TpmEndorsementKeyInfo/);
  });
});

describe("where Lanterel OS goes", () => {
  it("takes a fixed 24,192 MiB, the image's layout", () => {
    expect(SWIFF_OS_BYTES).toBe(24192 * MiB);
    expect(SWIFF_OS.partitions.map((p) => p.role)).toEqual([
      "esp",
      "root-a",
      "verity-a",
      "root-b",
      "verity-b",
      "scratch",
      "keep",
      "state",
    ]);
  });

  it("shrinks C: from its end by exactly Lanterel OS's size, up to the recovery partition", () => {
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
      { disk: 0, number: 1, letter: null, type: TYPE.esp, id: null, offset: MiB, size: 100 * MiB },
      {
        disk: 0,
        number: 2,
        letter: "C",
        type: TYPE.windowsData,
        id: null,
        offset: 200 * MiB,
        size: 50 * GiB,
      },
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
  it("lists the steps in order, each with its operations and commands", () => {
    const plan = installPlan(pc());
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

  it("says what each step that changes the disk or the firmware changes, and restarts only in its last step", () => {
    const plan = installPlan(
      pc((raw) => ({ ...raw, volumes: raw.volumes.map((v) => ({ ...v, bitlocker: 1 })) })),
    );
    expect(plan.steps.filter((s) => s.confirm).map((s) => s.id)).toEqual([
      "bitlocker",
      "room",
      "partitions",
      "write",
      "boot-entry",
      "mok-restart",
    ]);
    expect(plan.steps.find((s) => s.id === "bitlocker")!.confirm).toMatch(/recovery key/);
    expect(plan.steps.find((s) => s.id === "room")!.confirm).toMatch(/Back up/);
    // The one step the owner starts: Restart now, after the rest ran by itself.
    expect(plan.steps.filter((s) => s.ops.some((o) => o.op === "restart")).map((s) => s.id)).toEqual([
      "mok-restart",
    ]);
    expect(plan.steps.at(-1)!.ops).toEqual([{ op: "restart" }]);
  });

  it("names each step in the owner's words", () => {
    const plan = installPlan(
      pc((raw) => ({ ...raw, volumes: raw.volumes.map((v) => ({ ...v, label: "Games" })) })),
    );
    expect(plan.steps.map((s) => s.title)).toEqual([
      "Check the Secure Boot keys and the TPM (asks for administrator)",
      "Turn off Fast Startup so Lanterel OS can read your drives",
      "Shrink C: by 24 GB",
      "Create 8 partitions for Lanterel OS on disk 0",
      "Copy Lanterel OS onto them",
      "Add Lanterel OS to the boot menu, after Windows",
      "Label C: SWIFFGAMES so Lanterel OS finds your games",
      "Make a one-time code for Lanterel's key",
      "Restart once to confirm the key",
    ]);
  });

  it("puts the project Lanterel Host reports errors to onto Lanterel OS's ESP, once it is written and before it is typed ESP", () => {
    const project = { key: "phc_test", host: "https://eu.i.posthog.com" };
    const plan = installPlan(pc(), { errorReports: project });
    const add = plan.steps.find((s) => s.id === "partitions")!.ops[0]!;
    if (add.op !== "gpt-add") throw new Error("not gpt-add");
    const write = plan.steps.find((s) => s.id === "write")!;
    expect(write.ops.map((o) => o.op)).toEqual(["write", "write", "write", "esp-file"]);
    expect(write.ops.at(-1)).toEqual({
      op: "esp-file",
      disk: 0,
      offset: add.partitions[0]!.offset,
      ...project,
    });
    expect(write.commands).toContain("#   LANTEREL_POSTHOG_KEY=phc_test");
    expect(write.commands).toContain("#   LANTEREL_POSTHOG_HOST=https://eu.i.posthog.com");
    // A build without a project, a PC that says DO_NOT_TRACK (both null), or a project Lanterel OS would refuse: no file.
    for (const errorReports of [
      null,
      { key: "phx_personal", host: project.host },
      { key: project.key, host: "https://evil.example" },
    ])
      expect(
        installPlan(pc(), { errorReports })
          .steps.flatMap((s) => s.ops)
          .map((o) => o.op),
      ).not.toContain("esp-file");
  });

  it.each(PROJECT_CASES)(
    "takes the same projects for LANTEREL.ENV as @swiff/error-tracking's projectOf: $what",
    ({ key, host, origin }) => {
      const shared = projectOf({ key, host });
      expect(shared).toEqual(origin === null ? null : { key, host: origin });
      expect(errorReportsFile({ key, host })).toBe(
        shared && `LANTEREL_POSTHOG_KEY=${shared.key}\nLANTEREL_POSTHOG_HOST=${shared.host}\n`,
      );
    },
  );

  it("goes on in the partitions a stopped install already made: no shrink, no new partitions, the same offsets", () => {
    const first = installPlan(pc());
    const add = first.steps.find((s) => s.id === "partitions")!.ops[0]!;
    if (add.op !== "gpt-add") throw new Error("not gpt-add");
    const record = {
      complete: false,
      disk: 0,
      fastStartup: true,
      shrink: { letter: "C", partition: 3, from: 1000 * GiB, to: 976 * GiB },
      partitions: add.partitions.map((p, i) => ({
        role: p.role,
        id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
        offset: p.offset,
        bytes: p.bytes,
      })),
      bootEntry: null,
      labels: [],
      mok: false,
    };
    const again = installPlan(pc((raw) => ({ ...raw, fastStartup: 0, install: record })));
    expect(again.steps.map((s) => s.id)).toEqual([
      "check",
      "write",
      "boot-entry",
      "games",
      "mok",
      "mok-restart",
    ]);
    expect(again.target).toMatchObject({ kind: "free", disk: 0, start: record.partitions[0]!.offset });
    expect(again.steps.find((s) => s.id === "write")!.ops).toEqual(
      first.steps.find((s) => s.id === "write")!.ops,
    );
    // The drive chosen before no longer matters: the room is made.
    expect(
      installPlan(
        pc((raw) => ({ ...raw, install: record })),
        { target: "shrink:D" },
      ).target?.kind,
    ).toBe("free");
  });

  it("suspends BitLocker on C: for three restarts first, when it is on", () => {
    const plan = installPlan(
      pc((raw) => ({ ...raw, volumes: raw.volumes.map((v) => ({ ...v, bitlocker: 1 })) })),
    );
    const step = plan.steps[1]!;
    expect(step.id).toBe("bitlocker");
    expect(step.ops).toEqual([{ op: "bitlocker-suspend", letter: "C", restarts: 3 }]);
    expect(step.commands[0]).toMatch(
      /^manage-bde -protectors -disable C: -RebootCount 3; if \(\$LASTEXITCODE\)/,
    );
    expect(installPlan(pc()).steps.map((s) => s.id)).not.toContain("bitlocker");
  });

  it("shrinks C: and lays Lanterel OS's eight partitions end to end in the room it made", () => {
    const rental = pc();
    const target = rental.targets[0]!;
    const plan = installPlan(rental);
    const room = plan.steps.find((s) => s.id === "room")!;
    expect(room.ops).toEqual([
      { op: "shrink", disk: 0, partition: 3, size: (target as { size: number }).size, letter: "C" },
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

  it("writes only the boot partition and slot A, and points the boot entry at the shim on Lanterel OS's own ESP", () => {
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
        path: "\\EFI\\swiff\\shimx64.efi",
        title: "Lanterel OS",
      },
    ]);
    expect(entry.commands.join("\n")).toMatch(
      /Boot####.*HD\(the ESP at offset \d+, GPT, its id\)\/File\(\\EFI\\swiff\\shimx64\.efi\)/,
    );
  });

  it("checks Secure Boot's db for the CA that signs the shim, the TPM, the shrink limit and the image first", () => {
    const check = installPlan(pc()).steps[0]!;
    expect(check.ops.map((o) => o.op)).toEqual(["check", "image-check"]);
    expect(check.confirm).toBeNull();
    expect(check.commands.join("\n")).toMatch(/Microsoft Corporation UEFI CA 2011/);
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

  it("offers no disk with 4,096-byte sectors: Lanterel OS's ESP is a FAT with 512-byte ones", () => {
    const native = pc((raw) => ({ ...raw, disks: raw.disks.map((d) => ({ ...d, sector: 4096 })) }));
    expect(native.targets).toEqual([]);
  });

  it("refuses a chosen drive that is no longer there, rather than picking another", () => {
    expect(() => installPlan(pc(), { target: "shrink:D" })).toThrow(/no longer available/);
    expect(installPlan(pc(), { target: null }).target?.id).toBe("shrink:C");
  });

  it("refuses a PC with nowhere to put Lanterel OS", () => {
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
          name: [
            "esp",
            "swiffos_0.1.0",
            "swiffos_0.1.0",
            "_empty",
            "_empty",
            "swiff-scratch",
            "swiff-keep",
            "swiff-state",
          ][i]!,
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
      ["keep", "swiff-keep"],
      ["state", "swiff-state"],
    ]);
    const add = installPlan(pc(), { layout }).steps.find((s) => s.id === "partitions")!.ops[0]!;
    expect(add.op === "gpt-add" && add.partitions[1]!.id).toBe("00000000-0000-4000-8000-000000000001");
    expect(() => imageLayout({ ...gpt, entries: gpt.entries.slice(1) })).toThrow(/unexpected/);
  });
});

describe("Lanterel's key, enrolled once as a MOK", () => {
  it("queues the key with a one-time code and points the next start at Lanterel OS, then restarts once on the owner's word", () => {
    const plan = installPlan(pc(), { code: "48217730" });
    expect(plan.mok).toEqual({ code: "48217730" });
    const [mok, restart] = plan.steps.slice(-2);
    // Recorded as installed before BootNext: a restart from anywhere reaches the blue screen.
    expect(mok!.ops).toEqual([
      { op: "mok-import", cert: MOK_CERT, code: "48217730" },
      { op: "installed" },
      { op: "boot-next", entry: "swiff" },
    ]);
    expect(mok!.confirm).toBeNull();
    expect(mok!.commands.join("\n")).toMatch(/BootNext: Lanterel OS's Boot####/);
    expect(mok!.commands.join("\n")).toMatch(/mokutil --import swiffos-key\.cer --simple-hash/);
    expect(mok!.commands.join("\n")).toMatch(/MokNew-605dab50-e046-4300-abb6-3dd810dd8b23/);
    expect(mok!.commands.join("\n")).toMatch(/MokAuth-605dab50-.*the one-time code/);
    expect(plan.steps.flatMap((s) => s.commands).join("\n")).not.toContain("48217730");
    expect(restart!.ops).toEqual([{ op: "restart" }]);
    expect(restart!.confirm).toMatch(/restarts now/);
    expect(restart!.commands).toEqual([
      "shutdown /r /t 5; if ($LASTEXITCODE) { throw 'shutdown failed: exit code ' + $LASTEXITCODE }",
    ]);
  });

  it("confirms the key again after a missed screen: the same request with a new code, and one restart", () => {
    const plan = mokPlan("11112222");
    expect(plan).toMatchObject({ kind: "mok", mok: { code: "11112222" } });
    expect(plan.steps).toEqual(mokSteps("11112222"));
    expect(plan.steps.map((s) => s.ops)).toEqual([
      [
        { op: "mok-import", cert: MOK_CERT, code: "11112222" },
        { op: "boot-next", entry: "swiff" },
      ],
      [{ op: "restart" }],
    ]);
    expect(mokPlan().mok!.code).toMatch(/^\d{8}$/);
  });

  it("suspends BitLocker on C: for the key's restart and the one after, when it is on", () => {
    const locked = pc((raw) => ({ ...raw, volumes: raw.volumes.map((v) => ({ ...v, bitlocker: 1 })) }));
    for (const plan of [mokPlan("11112222", locked), keyRemovalPlan("11112222", locked)])
      expect(plan.steps[0]!.ops).toEqual([{ op: "bitlocker-suspend", letter: "C", restarts: 2 }]);
    expect(mokPlan("11112222", pc()).steps.map((s) => s.id)).toEqual(["mok", "mok-restart"]);
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
  it("starts sharing with Lanterel OS first in the boot order and BootNext, then restarts", () => {
    const plan = switchPlan("start");
    expect(plan.steps.flatMap((s) => s.ops)).toEqual([
      { op: "ek" },
      { op: "provision" },
      { op: "boot-first", entry: "swiff" },
      { op: "boot-next", entry: "swiff" },
      { op: "restart" },
    ]);
    expect(plan.steps.filter((s) => s.confirm).map((s) => s.id)).toEqual(["provision", "restart"]);
  });

  it("starts Lanterel OS once with BootNext alone, so the next restart is Windows again", () => {
    const plan = switchPlan("once");
    expect(plan.steps.map((s) => s.ops)).toEqual([
      [{ op: "ek" }],
      [{ op: "provision" }],
      [{ op: "boot-next", entry: "swiff" }],
      [{ op: "restart" }],
    ]);
    expect(plan.steps[2]!.confirm).toBeNull();
    expect(plan.steps[3]!.confirm).toMatch(/next restart after that starts Windows/);
  });

  it("hands Lanterel OS this PC's machine key before each restart into it, never naming the key in the plan", () => {
    for (const kind of ["once", "start"] as const) {
      const provision = switchPlan(kind).steps.find((s) => s.id === "provision");
      expect(provision).toMatchObject({ id: "provision", ops: [{ op: "provision" }] });
      expect(provision!.confirm).toMatch(/seals them to this PC's TPM/);
      expect(provision!.commands.join("\n")).toMatch(/keep partition/);
    }
    expect(switchPlan("stop").steps.map((s) => s.id)).not.toContain("provision");
  });

  it("stops sharing by putting Windows first again", () => {
    expect(switchPlan("stop").steps.flatMap((s) => s.ops)).toEqual([{ op: "boot-first", entry: "windows" }]);
  });
});

describe("the uninstall", () => {
  const record = {
    complete: true,
    disk: 0,
    bitlocker: "C",
    fastStartup: true,
    shrink: { letter: "C", partition: 3, from: 1000 * GiB, to: 976 * GiB },
    partitions: [
      { role: "esp", id: "11111111-2222-4333-8444-555555555555", offset: 976 * GiB, bytes: GiB },
      { role: "root-a", id: "66666666-7777-4888-9999-aaaaaaaaaaaa", offset: 977 * GiB, bytes: 8 * GiB },
    ],
    bootEntry: 3,
    windowsEntry: 0,
    labels: [{ letter: "C", from: "Windows" }],
    mok: true,
  };
  const installed = (change = {}) => pc((raw) => ({ ...raw, install: { ...record, ...change } }));

  it("takes back each thing the install did, boot entry first and C:'s space after the partitions", () => {
    const plan = uninstallPlan(installed());
    expect(plan.steps.map((s) => s.id)).toEqual([
      "boot-entry",
      "unprovision",
      "partitions",
      "room",
      "labels",
      "fast-startup",
      "bitlocker",
      "forget",
    ]);
    expect(plan.steps.flatMap((s) => s.ops)).toEqual([
      { op: "boot-entry-remove" },
      { op: "mok-cancel" },
      { op: "unprovision" },
      { op: "gpt-remove", disk: 0, partitions: record.partitions },
      { op: "grow", disk: 0, partition: 3, letter: "C", size: 1000 * GiB },
      { op: "label", letter: "C", label: "Windows" },
      { op: "fast-startup-on" },
      { op: "bitlocker-resume", letter: "C" },
      { op: "forget" },
    ]);
    expect(plan.steps.find((s) => s.id === "room")!.title).toBe("Give C: its 24 GB back");
    expect(plan.mok).toBeUndefined();
  });

  it("undoes an install that stopped half way: only what it got to", () => {
    const half = installed({
      complete: false,
      bootEntry: null,
      partitions: [],
      labels: [],
      bitlocker: null,
      fastStartup: false,
    });
    expect(uninstallPlan(half).steps.flatMap((s) => s.ops.map((o) => o.op))).toEqual([
      "mok-cancel",
      "grow",
      "forget",
    ]);
  });

  it("removes Lanterel's key on its own, before the uninstall, through MokManager on Lanterel OS's ESP", () => {
    const plan = keyRemovalPlan("55554444");
    expect(plan).toMatchObject({ kind: "unkey", mok: { code: "55554444" } });
    expect(plan.steps.map((s) => s.ops)).toEqual([
      [
        { op: "mok-delete", cert: MOK_CERT, code: "55554444" },
        { op: "boot-next", entry: "swiff" },
      ],
      [{ op: "restart" }],
    ]);
    expect(plan.steps.map((s) => Boolean(s.confirm))).toEqual([false, true]);
    expect(
      uninstallPlan(installed())
        .steps.flatMap((s) => s.ops)
        .some((o) => o.op === "mok-delete"),
    ).toBe(false);
    expect(plan.steps.flatMap((s) => s.commands).join("\n")).not.toContain("55554444");
  });

  it("refuses a PC where nothing was installed", () => {
    expect(() => uninstallPlan(pc())).toThrow(/not installed/);
  });
});

describe("what the screen says", () => {
  /** The rental setup the screen reads, with nothing planned or running. */
  const setupOf = (read: RentalRead | null, change: Partial<RentalSetup> = {}): RentalSetup => ({
    reading: false,
    read,
    target: null,
    preview: null,
    run: IDLE_RUN,
    ...change,
  });
  const nvidia = { name: "NVIDIA GeForce RTX 4080", pnp: "PCI\\VEN_10DE&DEV_2704" };

  it("says the fixture PC is ready to install, with Fast Startup left to Lanterel", () => {
    const read = pc();
    expect(rentalStage(setupOf(read))).toEqual({ kind: "ready" });
    expect(rentalLine(setupOf(read))).toBe("Ready to install");
    expect(rentalStepAt(setupOf(read))).toBe(1);
    expect(pcChecks(read, null).find((c) => c.id === "fast-startup")).toMatchObject({
      value: "On. The install turns it off",
      state: "swiff",
    });
    expect(pcChecks(read, null).find((c) => c.id === "space")).toMatchObject({
      value: "24 GB from C:",
      state: "ok",
    });
  });

  it("names the BIOS settings to change, all in one trip, and offers no install until they are made", () => {
    const read = pc((raw) => ({ ...raw, secureBoot: 0, securityProperties: [1, 2] }));
    expect(biosTodos(read)).toEqual(["secure-boot", "iommu"]);
    expect(rentalStage(setupOf(read))).toMatchObject({ kind: "bios", bios: ["secure-boot", "iommu"] });
    expect(biosTitle(["secure-boot", "iommu"])).toBe("Turn on Secure Boot and IOMMU");
    expect(biosTitle(["iommu"])).toBe("Turn on IOMMU");
    expect(biosTitle(["uefi", "secure-boot", "iommu"])).toBe("Change 3 BIOS settings");
    expect(rentalLine(setupOf(read))).toBe("2 BIOS settings");
    expect(rentalLine(setupOf(pc((raw) => ({ ...raw, securityProperties: [1, 2] }))))).toBe("1 BIOS setting");
  });

  it("puts a to-do in Windows before the BIOS trip: BitLocker first, the IOMMU after", () => {
    const read = pc((raw) => ({
      ...raw,
      securityProperties: [1, 2],
      volumes: raw.volumes.map((v) => ({ ...v, bitlocker: 1 })),
    }));
    expect(rentalStage(setupOf(read))).toMatchObject({
      kind: "windows",
      todos: [{ id: "games", title: "Turn off BitLocker on C:", setting: ["C: BitLocker", "Off"] }],
      bios: ["iommu"],
    });
    expect(rentalLine(setupOf(read))).toBe("Not ready");
  });

  it("asks for the IOMMU on an NVIDIA PC, with the graphics card only waiting beside it", () => {
    const read = pc((raw) => ({ ...raw, gpus: [nvidia], securityProperties: [1, 2] }));
    expect(rentalStage(setupOf(read))).toEqual({
      kind: "bios",
      bios: ["iommu"],
      waiting: [{ id: "gpu", setting: ["Graphics card", "Update coming"] }],
    });
  });

  it("is almost ready when only the graphics card is left, with nothing for the owner to do", () => {
    const read = pc((raw) => ({ ...raw, gpus: [nvidia] }));
    expect(windowsTodos(read, null)).toEqual([]);
    expect(waitingFor(read, null)).toEqual([{ id: "gpu", setting: ["Graphics card", "Update coming"] }]);
    expect(rentalStage(setupOf(read))).toEqual({ kind: "almost", waiting: waitingFor(read, null) });
    expect(rentalLine(setupOf(read))).toBe("Not on NVIDIA yet");
    // NVIDIA keeps today's words in the checks, unchanged.
    expect(pcChecks(read, null).find((c) => c.id === "gpu")).toMatchObject({ value: "RTX 4080: not yet" });
  });

  it("tells Lanterel OS's files Lanterel did not sign from files not there, and leads to checking again", () => {
    const missing = { ...pc(), image: null, imageRefused: false };
    expect(pcChecks(missing, null).find((c) => c.id === "image")).toMatchObject({
      value: "Its files are not on this PC",
      state: "blocked",
    });
    expect(rentalStage(setupOf(missing)).kind).toBe("almost");
    const refused = { ...pc(), image: null, imageRefused: true };
    expect(pcChecks(refused, null).find((c) => c.id === "image")).toMatchObject({
      value: "Not signed by Lanterel",
      state: "blocked",
    });
    expect(waitingFor(refused, null)).toEqual([]);
    expect(rentalStage(setupOf(refused))).toEqual({ kind: "unsigned" });
    expect(rentalLine(setupOf(refused))).toBe("Files didn't check out");
  });

  it("holds a full disk against the PC as a to-do in Windows, named by what to free", () => {
    const read = pc((raw) => ({ ...raw, volumes: raw.volumes.map((v) => ({ ...v, free: 20 * GiB })) }));
    expect(windowsTodos(read, null)).toEqual([
      {
        id: "space",
        title: "Free up 24 GB",
        line: "Lanterel OS needs 24 GB on one drive. Move or delete files, or add a drive.",
        setting: ["Free space on one drive", "24 GB"],
      },
    ]);
  });

  it("reads the Secure Boot db from the boot log, and sends the owner to the BIOS only when it lacks the CA", () => {
    const ca = (read: RentalRead) => firmwareChecks(read).find((c) => c.id === "ca");
    expect(ca(pc((raw) => ({ ...raw, db: true })))).toMatchObject({ value: "Trusted", state: "ok" });
    const missing = pc((raw) => ({ ...raw, db: false }));
    expect(ca(missing)).toMatchObject({ value: "Not trusted", state: "bios" });
    expect(rentalStage(setupOf(missing))).toMatchObject({ kind: "bios", bios: ["ca"] });
    // No log to read: the install's administrator step checks it, and nothing is held against the PC.
    expect(ca(pc())).toMatchObject({ value: "Read when you install", state: "unread" });
    expect(rentalStage(setupOf(pc())).kind).toBe("ready");
  });

  it("shows the TPM certificate as the install's check recorded it, and never as a to-do", () => {
    const ek = (checked: unknown) =>
      firmwareChecks(pc((raw) => ({ ...raw, check: checked }))).find((c) => c.id === "ek");
    expect(ek(null)).toMatchObject({ value: "Read when you install", state: "unread" });
    expect(ek({ ek: true })).toMatchObject({ value: "Present", state: "ok" });
    expect(ek({ ek: false })).toMatchObject({ value: "None yet: needed to go live", state: "ok" });
    expect(firmwareChecks(pc()).some((c) => !isReady(c.state) && c.state !== "bios")).toBe(false);
    // A check alone leaves no install record: the screen does not say an install stopped.
    expect(rentalStage(setupOf(pc((raw) => ({ ...raw, check: { ek: true } })))).kind).toBe("ready");
  });

  it("names the BIOS key and menu path for the PC's firmware: AMI on the GEEKOM, the maker's own on a Lenovo", () => {
    const geekom = pc((raw) => ({
      ...raw,
      bios: "American Megatrends International, LLC.",
      maker: "GEEKOM",
      model: "A6",
      cpu: "AuthenticAMD",
    }));
    expect(firmwareGuide(geekom)).toMatchObject({ name: "AMI Aptio", keys: ["Del", "F2"] });
    expect(biosPath(geekom, "iommu")).toBe("Advanced → AMD CBS → NBIO Common Options → IOMMU: Enabled");
    expect(biosPath(geekom, "secure-boot")).toBe("Security → Secure Boot → Secure Boot: Enabled");
    const lenovo = pc((raw) => ({ ...raw, bios: "LENOVO", maker: "LENOVO", cpu: "GenuineIntel" }));
    expect(biosPath(lenovo, "ca")).toBe("Security → Secure Boot → Allow Microsoft 3rd Party UEFI CA: On");
    // Firmware the table does not know keeps the general hints.
    const other = pc((raw) => ({ ...raw, bios: "Coreboot", maker: "Star Labs" }));
    expect(firmwareGuide(other)).toBeNull();
    expect(biosPath(other, "tpm")).toBeNull();
  });

  it("never holds what it could not read against the PC", () => {
    const read = pc((raw) => ({ ...raw, secureBoot: null, securityProperties: [null], fastStartup: null }));
    expect(
      firmwareChecks(read)
        .filter((c) => c.state === "unread")
        .map((c) => c.id),
    ).toEqual(["secure-boot", "iommu", "ca", "ek"]);
    expect(rentalStage(setupOf(read)).kind).toBe("ready");
  });

  it("never swaps in another drive when the chosen one is gone: the owner picks again", () => {
    const read = pc();
    expect(pcChecks(read, "shrink:D").find((c) => c.id === "space")).toMatchObject({
      value: "The drive you chose is no longer available: choose again",
      state: "blocked",
    });
    expect(windowsTodos(read, "shrink:D")[0]).toMatchObject({
      id: "space",
      line: "The drive you picked for Lanterel OS isn't there any more. Pick another, or free up space on one drive.",
    });
    expect(rentalStage(setupOf(read, { target: "shrink:C" })).kind).toBe("ready");
  });

  it("says BitLocker was not read when it was not, rather than off", () => {
    const read = pc((raw) => ({ ...raw, volumes: raw.volumes.map((v) => ({ ...v, bitlocker: null })) }));
    expect(pcChecks(read, null).find((c) => c.id === "games")).toMatchObject({
      value: "C: BitLocker not read",
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

  it("checks this PC first, and says when the check did not finish", () => {
    expect(rentalStage(setupOf(null, { reading: true }))).toEqual({ kind: "reading" });
    expect(rentalLine(setupOf(null, { reading: true }))).toBe("Checking this PC");
    expect(rentalStage(setupOf(null))).toEqual({ kind: "unread" });
    expect(rentalLine(setupOf(null))).toBe("Check didn't finish");
    expect(rentalStepAt(setupOf(null))).toBe(0);
  });

  it("offers to continue an install that stopped part way", () => {
    const record = { complete: false, disk: 0, bootEntry: null, partitions: [], shrink: null };
    const read = pc((raw) => ({ ...raw, install: record }));
    expect(rentalStage(setupOf(read)).kind).toBe("resume");
  });
});

describe("Lanterel's key, after the install", () => {
  const record = { complete: true, disk: 0, bootEntry: 3, partitions: [], mok: true };
  const installed = (key: RentalRead["key"], extra: Partial<RentalRead> = {}): RentalSetup => ({
    reading: false,
    read: { ...pc((raw) => ({ ...raw, install: record })), key, ...extra },
    target: null,
    preview: null,
    run: IDLE_RUN,
  });

  it("waits for the restart while the request is queued, with its code", () => {
    const s = installed({ state: "queued", code: "48217730" });
    expect(rentalStage(s)).toEqual({ kind: "restart", code: "48217730" });
    expect(rentalLine(s)).toBe("Ready to restart");
    expect(rentalStepAt(s)).toBe(2);
  });

  it("asks the owner after the restart, and when the app never kept track", () => {
    expect(rentalStage(installed({ state: "ask", code: null }))).toEqual({ kind: "ask" });
    expect(rentalStage(installed(null))).toEqual({ kind: "ask" });
    expect(rentalLine(installed(null))).toBe("Confirm the key");
    expect(rentalReady(installed(null))).toBe(false);
  });

  it("is ready to go live only once the owner confirmed the key", () => {
    const s = installed({ state: "confirmed", code: null });
    expect(rentalStage(s)).toEqual({ kind: "installed" });
    expect(rentalReady(s)).toBe(true);
    expect(rentalLine(s)).toBe("Ready");
    expect(rentalStepAt(s)).toBe(3);
  });

  it("tells a key the owner said was missed from one the boot log showed was not taken", () => {
    expect(rentalStage(installed({ state: "missed", code: null })).kind).toBe("key");
    expect(rentalStage(installed({ state: "nokey", code: null })).kind).toBe("nokey");
    expect(rentalLine(installed({ state: "nokey", code: null }))).toBe("Key not confirmed");
    for (const state of ["missed", "nokey"] as const) {
      expect(rentalReady(installed({ state, code: null }))).toBe(false);
      expect(rentalStepAt(installed({ state, code: null }))).toBe(2);
    }
  });

  it("keeps Go live and Get paid locked until the key is confirmed, unless the PC is live already", () => {
    const off = { kind: "off" };
    for (const state of ["ask", "missed", "nokey"] as const) {
      const rental = installed({ state, code: null });
      expect(stepLocked("live", { rental, live: off })).toBe(true);
      expect(stepLocked("paid", { rental, live: off })).toBe(true);
      expect(stepLocked("rental", { rental, live: off })).toBe(false);
    }
    const ready = installed({ state: "confirmed", code: null });
    expect(stepLocked("live", { rental: ready, live: off })).toBe(false);
    expect(stepLocked("live", { rental: installed(null), live: { kind: "waiting" } })).toBe(false);
    // Development builds that share this Windows desktop go live without rental mode.
    expect(stepLocked("live", { rental: installed(null), live: off }, true)).toBe(false);
  });

  it("goes back to the key step, Go live locked, once Lanterel's key is taken off", () => {
    const disk = new Map<string, string>();
    const files = {
      readFileSync: (file: string) => {
        if (!disk.has(file)) throw new Error("ENOENT");
        return disk.get(file)!;
      },
      writeFileSync: (file: string, data: string) => void disk.set(file, data),
      mkdirSync: () => undefined,
      rmSync: (file: string) => void disk.delete(file),
    } as unknown as typeof import("node:fs");
    const crypt = {
      seal: (text: string) => Buffer.from(text).reverse(),
      open: (sealed: Buffer) => Buffer.from(sealed).reverse().toString(),
    };
    const store = keyStore("/data", crypt, files);
    const at = (state: ReturnType<typeof keyOf>) => installed(state);
    const off = { kind: "off" };
    keyStep(store, mokPlan("48217730"), "mok", 1000);
    store.answer(true);
    expect(rentalStage(at(keyOf(store.read(), 2000)))).toEqual({ kind: "installed" });
    expect(stepLocked("live", { rental: at(keyOf(store.read(), 2000)), live: off })).toBe(false);
    const unkey = keyRemovalPlan("51234870");
    for (const s of unkey.steps) keyStep(store, unkey, s.id, 3000);
    const removed = at(keyOf(store.read(), 4000));
    expect(rentalStage(removed)).toEqual({ kind: "key" });
    expect(stepLocked("live", { rental: removed, live: off })).toBe(true);
  });

  it("sums up the last live run once, back in Windows, until the owner has seen it", () => {
    const lastLive = { from: 1, to: 2, sessions: 2, early: 0, earned: 3.1 };
    const s = installed({ state: "confirmed", code: null }, { lastLive });
    expect(rentalStage(s)).toEqual({ kind: "back", live: lastLive });
    expect(rentalReady(s)).toBe(true);
    expect(rentalStage({ ...s, liveSeen: 2 })).toEqual({ kind: "installed" });
  });
});

describe("the run on screen", () => {
  const read = pc();
  const plan = installPlan(read, { code: "48217730" });
  const runOf = (change: Partial<RentalRun>): RentalRun => ({ ...IDLE_RUN, ...change });
  const setupOf = (run: RentalRun, p = plan): RentalSetup => ({
    reading: false,
    read,
    target: null,
    preview: p,
    run,
  });
  const done = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, "done" as const]));

  it("previews the plan, waits for Windows, then shows the running step", () => {
    expect(rentalScreen(setupOf(IDLE_RUN)).kind).toBe("preview");
    expect(rentalScreen(setupOf(runOf({ status: "starting" })))).toMatchObject({ kind: "elevating" });
    const running = setupOf(
      runOf({ status: "running", steps: { ...done(["check", "fast-startup"]), room: "running" } }),
    );
    expect(rentalScreen(running)).toMatchObject({ kind: "running", index: 2, step: { id: "room" } });
    expect(rentalLine(running)).toBe("Installing");
    expect(rentalStepAt(running)).toBe(1);
  });

  it("says how far the write is in the rail", () => {
    const s = setupOf(
      runOf({
        status: "running",
        steps: { write: "running" },
        progress: {
          id: "write",
          done: 42,
          total: 100,
          pass: { doing: "checking", name: "Root", done: 3.0e9, total: 8.6e9 },
        },
      }),
    );
    expect(rentalLine(s)).toBe("Installing, 42%");
  });

  it("stops at the restart with the code, and restarts only on the owner's word", () => {
    const s = setupOf(runOf({ status: "done" }));
    expect(rentalScreen(s)).toMatchObject({ kind: "restart", code: "48217730" });
    expect(rentalLine(s)).toBe("Ready to restart");
    expect(rentalStepAt(s)).toBe(1);
    const restarting = setupOf(runOf({ status: "restarting" }));
    expect(rentalScreen(restarting)).toMatchObject({ kind: "restarting", code: "48217730" });
    expect(rentalLine(restarting)).toBe("Restarting");
  });

  it("puts a new code for the key on step 3", () => {
    const mok = mokPlan("11112222");
    expect(rentalStepAt(setupOf(IDLE_RUN, mok))).toBe(2);
    expect(rentalScreen(setupOf(runOf({ status: "done" }), mok))).toMatchObject({
      kind: "restart",
      code: "11112222",
    });
  });
});

describe("when a step stops", () => {
  const read = pc((raw) => ({
    ...raw,
    disks: [
      ...raw.disks,
      { number: 1, style: "GPT", size: 500 * GiB, sector: 512, bus: "SATA", system: false },
    ],
  }));
  const plan = installPlan(read, { code: "48217730", target: "shrink:C" });
  const failed = (step: string, error: string, change: Partial<RentalRun> = {}, p = plan, r = read) => {
    const setup: RentalSetup = {
      reading: false,
      read: r,
      target: null,
      preview: p,
      run: {
        ...IDLE_RUN,
        status: "failed",
        failed: { step, error },
        endedAt: new Date(2026, 9, 5, 21, 4).getTime(),
        ...change,
      },
    };
    const s = rentalScreen(setup);
    if (s.kind !== "failed") throw new Error(`not failed: ${s.kind}`);
    return { setup, f: failureOf(setup, s) };
  };
  const done = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, "done" as const]));

  describe("at Go live's TPM certificate", () => {
    const once = switchPlan("once");
    const geekom = pc((raw) => ({
      ...raw,
      bios: "American Megatrends International, LLC.",
      maker: "GEEKOM",
    }));

    it("names the BIOS menu that turns the TPM back on, when Windows can't reach it", () => {
      const { f } = failed("ek", "The TPM is not ready.", {}, once, geekom);
      expect(f).toMatchObject({
        kind: "bios",
        bios: "tpm",
        title: "Turn on the TPM",
        why: "Windows can't reach the TPM, so it's off: in the BIOS (Del or F2 as it starts), turn it on under Advanced → Trusted Computing → Security Device Support: Enable, then go live again.",
        changed: "Nothing on this PC has changed.",
        action: "check",
      });
      // A board the table does not know: the general names.
      expect(failed("ek", "The TPM is not ready.", {}, once).f.why).toBe(
        "Windows can't reach the TPM, so it's off: in the BIOS, turn it on under Security or Advanced, called AMD fTPM or Intel PTT, then go live again.",
      );
    });

    it("says what to do in one sentence for a TPM without a certificate, and for each refusal", () => {
      const said = (error: string, change: Partial<RentalRun> = {}) => failed("ek", error, change, once).f;
      expect(said("The TPM has no endorsement key certificate Windows can read.")).toMatchObject({
        kind: "ek",
        title: "This PC's TPM has no certificate",
        why: expect.stringMatching(/^[^.]+: leave the PC online for a few minutes, .+, then try again\.$/),
        changed: "Nothing on this PC has changed.",
        action: "again",
      });
      // A key or machine the server doesn't know, or none at all: pairing with Steam is the way on, never Settings.
      expect(said("bad-key")).toMatchObject({
        title: "The server didn't accept this PC's key",
        why: expect.stringMatching(/pair the PC with your Steam account again, then go live again\.$/),
        action: "pair",
        label: "Pair again",
      });
      // A missing server address is not blamed on the machine id and key.
      expect(said("no-server")).toMatchObject({
        title: "Add the server's address",
        why: expect.stringMatching(/^[^.:]+: add the signaling server in Settings, then go live again\.$/),
      });
      expect(said("no-machine")).toMatchObject({
        title: "Pair this PC first",
        why: expect.stringMatching(/pair it, then go live again\.$/),
        action: "pair",
        label: "Pair this PC",
      });
      expect(said("unknown-machine")).toMatchObject({ action: "pair", label: "Pair again" });
      for (const error of ["bad-key", "no-machine", "unknown-machine"])
        expect(said(error).why).not.toMatch(/Settings/);
      expect(said("failed").why).toMatch(/check the internet connection, then try again\.$/);
      // A local failure of the elevated read is the TPM's, not the network's; a server fault says try later.
      expect(said("something new")).toMatchObject({
        title: "Couldn't read the TPM",
        why: "Reading this PC's TPM failed: try Go live again, or restart the PC if it fails again.",
      });
      expect(said("unavailable")).toMatchObject({
        title: "The server couldn't check the TPM",
        why: "The Lanterel server couldn't check this PC's TPM right now: try again later.",
      });
      // The server doesn't know the TPM's maker: the details go to Lanterel first, then Try again.
      expect(said("untrusted")).toMatchObject({ action: "send", label: "Send details to Lanterel" });
      expect(said("untrusted", { reportedAt: 1 })).toMatchObject({ action: "again" });
      // The EK is registered before anything changes what the PC starts: a stop here changed nothing.
      expect(said("failed", { steps: { ek: "done" } }).changed).toBe("Nothing on this PC has changed.");
    });
  });

  it("asks Windows again when its prompt was declined, with nothing changed", () => {
    const { setup, f } = failed("elevate", "Windows did not give Lanterel Host administrator rights.");
    expect(f).toMatchObject({
      kind: "admin",
      title: "Windows didn't give permission",
      why: "The install needs administrator rights, and the Windows prompt was declined or closed.",
      changed: "Nothing on this PC has changed.",
      label: "Ask again",
      rail: "Needs permission",
    });
    expect(rentalLine(setup)).toBe("Needs permission");
    expect(rentalStepAt(setup)).toBe(1);
  });

  it("turns what the administrator check found off into its BIOS setting, with Check again, never an error code", () => {
    const { setup, f } = failed("check", "Secure Boot is off.");
    expect(f).toMatchObject({
      kind: "bios",
      bios: "secure-boot",
      title: "Turn on Secure Boot",
      changed: "Nothing on this PC has changed. Change the setting, then check again.",
      action: "check",
      label: "Check again",
      rail: "BIOS setting",
    });
    expect(rentalLine(setup)).toBe("BIOS setting");
    expect(rentalStepAt(setup)).toBe(0);
    expect(
      checkBios("The firmware does not trust the Microsoft Corporation UEFI CA 2011, which signs the shim."),
    ).toBe("ca");
    expect(checkBios("The TPM is not ready.")).toBe("tpm");
    expect(checkBios("Cmdlet not supported on this platform: 0xC0000002")).toBe("uefi");
    expect(checkBios("reg failed: exit code 1")).toBeNull();
  });

  it("says how far the write got, what already changed, and that trying again starts the write over", () => {
    const { f } = failed("write", "Write to disk 0 failed: an I/O device error. (0x8007045D)", {
      steps: { ...done(["check", "fast-startup", "room", "partitions"]), write: "failed" },
      progress: {
        id: "write",
        done: 4.1e9,
        total: 9.8e9,
        pass: { doing: "checking", name: "Root", done: 3.0e9, total: 8.6e9 },
      },
    });
    expect(f).toMatchObject({
      kind: "write",
      title: "Writing Lanterel OS stopped",
      why: "The drive reported an error while checking Root, after 3.0 of 8.6 GB.",
      changed:
        "Fast Startup is off. C: is already 24 GB smaller. Windows and your files are untouched. Trying again writes Lanterel OS from the start.",
      label: "Try again",
      rail: "Install stopped",
      what: "Writing Lanterel OS",
      at: "Stopped at 21:04",
      far: "Root, at 3.0 of 8.6 GB",
    });
  });

  it("offers another drive when the one chosen ran out of space, and a check when none has room", () => {
    const { setup, f } = failed("room", "C: cannot shrink by 24 GB.", {
      steps: done(["check", "fast-startup"]),
    });
    expect(f).toMatchObject({
      kind: "space",
      title: "Not enough space on C:",
      why: "Files were added since the check, so there isn't room for Lanterel OS on C:.",
      action: "use",
      label: "Use disk 1 instead",
      rail: "Not enough space",
    });
    expect(rentalStepAt(setup)).toBe(0);
    const alone = pc();
    const { f: none } = failed("check", "C: cannot shrink by 24 GB.", {}, installPlan(alone), alone);
    expect(none).toMatchObject({
      kind: "space",
      action: "check",
      label: "Check again",
      changed: "Nothing on this PC has changed.",
    });
  });

  it("says what a stopped removal left: Windows as normal, Lanterel OS off the boot menu, the space unused", () => {
    const record = {
      complete: true,
      disk: 0,
      shrink: { letter: "C", partition: 3, from: 1000 * GiB, to: 976 * GiB },
      partitions: [
        { role: "esp", id: "11111111-2222-4333-8444-555555555555", offset: 976 * GiB, bytes: GiB },
      ],
      bootEntry: 3,
      labels: [],
    };
    const installed = pc((raw) => ({ ...raw, install: record }));
    const { setup, f } = failed(
      "room",
      "Resize-Partition: Size Not Supported.",
      { steps: { ...done(["boot-entry", "unprovision", "partitions"]), room: "failed" } },
      uninstallPlan(installed),
      installed,
    );
    expect(f).toMatchObject({
      kind: "removal",
      title: "Removing rental mode stopped",
      why: "Lanterel OS's space couldn't be given back to C:.",
      changed:
        "Windows starts as normal. Lanterel OS is off the boot menu. Lanterel OS is off the disk. The 24 GB stays unused until this finishes.",
      label: "Try again",
      rail: "Removal stopped",
      far: "at step 4 of 5",
    });
    expect(rentalLine(setup)).toBe("Removal stopped");
  });

  it("tells an image the check found missing or not the one listed as Lanterel OS's files, not an unknown error", () => {
    for (const error of [
      "swiffos_0.1.0.root-x86-64.raw of the image set is not on this PC.",
      "swiffos_0.1.0.root-x86-64.raw is not the file its image set lists.",
    ]) {
      const { setup, f } = failed("check", error);
      expect(f).toMatchObject({
        kind: "image",
        title: "Lanterel OS's files didn't pass the check",
        changed: "Nothing on this PC has changed.",
        action: "send",
      });
      expect(rentalLine(setup)).toBe("Files didn't check out");
    }
  });

  it("asks to send the details of an error it does not know, then offers to try again", () => {
    const { f } = failed("fast-startup", "reg failed: exit code 1", {
      steps: { ...done(["check"]), "fast-startup": "failed" },
    });
    expect(f).toMatchObject({
      kind: "unknown",
      title: "The install stopped",
      why: "It stopped while turning off Fast Startup, and Lanterel doesn't know this error yet.",
      changed: "Nothing after that step ran. Windows and your files are untouched.",
      action: "send",
      label: "Send details to Lanterel",
      far: "at step 2 of 9",
    });
    const { f: sent } = failed("fast-startup", "reg failed: exit code 1", { reportedAt: 1 });
    expect(sent).toMatchObject({ action: "again", label: "Try again" });
  });

  it("says what the finished steps changed, step by step", () => {
    const run = {
      ...IDLE_RUN,
      steps: done(["check", "fast-startup", "room", "partitions", "write", "boot-entry", "mok"]),
    };
    expect(changedSoFar(plan, run)).toBe(
      "Fast Startup is off. C: is already 24 GB smaller. Lanterel OS is in the boot menu, after Windows. Lanterel's key is queued for the next restart. Windows and your files are untouched.",
    );
    expect(changedSoFar(plan, IDLE_RUN)).toBe("Nothing on this PC has changed.");
  });
});

/** A file system in memory, for the app's own little files. */
function memoryFiles() {
  const disk = new Map<string, string>();
  return {
    disk,
    files: {
      readFileSync: (file: string) => {
        if (!disk.has(file)) throw new Error("ENOENT");
        return disk.get(file)!;
      },
      writeFileSync: (file: string, data: string) => void disk.set(file, data),
      mkdirSync: () => undefined,
      rmSync: (file: string) => void disk.delete(file),
    } as unknown as typeof import("node:fs"),
  };
}
const CRYPT = {
  seal: (text: string) => Buffer.from(text).reverse(),
  open: (sealed: Buffer) => Buffer.from(sealed).reverse().toString(),
};

describe("Remove Lanterel OS", () => {
  const ESP = "11111111-2222-4333-8444-555555555555";
  const ROOT = "66666666-7777-4888-9999-aaaaaaaaaaaa";
  const record = {
    complete: true,
    disk: 0,
    bitlocker: null,
    fastStartup: true,
    shrink: { letter: "C", partition: 3, from: 1000 * GiB, to: 976 * GiB },
    partitions: [
      { role: "esp", id: ESP, offset: 976 * GiB, bytes: GiB },
      { role: "root-a", id: ROOT, offset: 977 * GiB, bytes: 8 * GiB },
    ],
    bootEntry: { partition: ESP, path: "\\EFI\\swiff\\shimx64.efi" },
    windowsEntry: null,
    labels: [],
    mok: true,
  };
  const installed = (change = {}, raw: (r: typeof FACTS) => object = (r) => r) =>
    pc((r) => ({ ...raw(r), install: { ...record, ...change } }));

  it("starts with Lanterel's key, through MokManager while it is still on the disk, and BitLocker paused for it", () => {
    const plan = removePlan(
      installed({}, (r) => ({ ...r, volumes: r.volumes.map((v) => ({ ...v, bitlocker: 1 })) })),
      {
        key: true,
        code: "55554444",
      },
    );
    expect(plan).toMatchObject({ kind: "remove", phase: "key", mok: { code: "55554444" } });
    expect(plan.steps.map((s) => s.id)).toEqual(["bitlocker", "mok-remove", "restart"]);
    expect(plan.steps.flatMap((s) => s.ops).map((o) => o.op)).toEqual([
      "bitlocker-suspend",
      "mok-delete",
      "boot-next",
      "restart",
    ]);
    expect(plan.steps.flatMap((s) => s.commands).join("\n")).not.toContain("55554444");
  });

  it("then takes Lanterel OS off, checks nothing is left, and restarts once to show Windows starts", () => {
    const plan = removePlan(installed(), { key: false });
    expect(plan).toMatchObject({ kind: "remove", phase: "disk" });
    expect(plan.mok).toBeUndefined();
    expect(plan.steps.map((s) => s.id)).toEqual([
      "boot-entry",
      "unprovision",
      "partitions",
      "room",
      "fast-startup",
      "verify",
      "forget",
      "restart",
    ]);
    expect(plan.steps.find((s) => s.id === "verify")!.ops).toEqual([
      { op: "removal-check", disk: 0, ids: [ESP, ROOT] },
    ]);
    // The boot entry by its partition's GPT id, and every request for shim, go first.
    expect(plan.steps[0]!.ops).toEqual([{ op: "boot-entry-remove" }, { op: "mok-cancel" }]);
    expect(plan.steps[0]!.commands.join("\n")).toMatch(/MokDel/);
    // Only the last step restarts, and only on the owner's word.
    expect(plan.steps.map((s) => s.ops.some((o) => o.op === "restart"))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(plan.steps.at(-1)!.confirm).toMatch(/restarts now, once, into Windows/);
  });

  it("calls the disk part's running steps what the removal does, not what the install did", () => {
    const plan = removePlan(installed(), { key: false });
    const step = (id: string) => plan.steps.find((s) => s.id === id)!;
    expect(
      ["boot-entry", "partitions", "room", "fast-startup"].map((id) => runningTitleOf(plan, step(id))),
    ).toEqual([
      "Taking Lanterel OS out of the boot menu",
      "Removing Lanterel OS's partitions",
      "Giving the space back to Windows",
      "Turning Fast Startup back on",
    ]);
    const read = installed();
    const setup: RentalSetup = {
      reading: false,
      read,
      target: null,
      preview: plan,
      run: { ...IDLE_RUN, status: "failed", failed: { step: "boot-entry", error: "bcdedit failed." } },
    };
    const s = rentalScreen(setup);
    if (s.kind !== "failed") throw new Error(`not failed: ${s.kind}`);
    expect(failureOf(setup, s).why).toBe("It stopped while taking lanterel os out of the boot menu.");
    // The install keeps its own wording for the same step.
    const install = installPlan(pc());
    expect(
      runningTitleOf(
        install,
        install.steps.find((s) => s.id === "boot-entry")!,
      ),
    ).toBe("Adding Lanterel OS to the boot menu");
  });

  it("goes straight to the disk when the key never went in, or after a partial install", () => {
    const partial = installed({ complete: false, bootEntry: null, mok: false });
    expect(removePlan(partial, { key: true }).phase).toBe("disk");
    expect(removePlan(installed({ bootEntry: null }), { key: true }).phase).toBe("disk");
  });

  it("refuses a PC where nothing was installed", () => {
    expect(() => removePlan(pc())).toThrow(/not installed/);
  });

  it("is a boot change, as every plan but stopping is", () => {
    for (const kind of ["install", "uninstall", "mok", "unkey", "remove", "once", "start"])
      expect(BOOT_CHANGES.has(kind)).toBe(true);
    expect(BOOT_CHANGES.has("stop")).toBe(false);
  });

  it("follows the removal across its restarts, with the key's code sealed until it is used", () => {
    const { files, disk } = memoryFiles();
    const store = removalStore("/data", CRYPT, files);
    const key = removePlan(installed(), { key: true, code: "55554444" });
    removalStep(store, key, "mok-remove", 1000);
    expect([...disk.values()].join()).not.toContain("55554444");
    expect(removalOf(store.read(), 500)).toEqual({ state: "queued", code: "55554444" });
    expect(removalOf(store.read(), 2000)).toEqual({ state: "finish" });
    const expect_ = expectOf(installed().facts.install!, ["C"]);
    const plan = removePlan(installed(), { key: false });
    removalStep(store, plan, "verify", 3000, expect_);
    expect(store.read()!.phase).toBe("key");
    removalStep(store, plan, "forget", 3000, expect_);
    expect(removalOf(store.read(), 2000)).toEqual({ state: "restart" });
    // Without the OS's encryption, the code is not kept: the screen shows none.
    const bare = removalStore("/bare", null, files);
    removalStep(bare, key, "mok-remove", 1000);
    expect(removalOf(bare.read(), 500)).toEqual({ state: "queued", code: null });
  });

  it("checks the next start against what the removal recorded: Windows, the disk, the space, BitLocker", () => {
    const install = installed().facts.install!;
    const expected = expectOf(install, ["C"]);
    expect(expected).toEqual({ ids: [ESP, ROOT], room: { letter: "C", size: 1000 * GiB }, bitlocker: ["C"] });
    const facts = (change: (r: typeof FACTS) => object) => pc(change).facts;
    const back = facts((r) => ({
      ...r,
      partitions: r.partitions.map((p) => (p.letter === "C" ? { ...p, size: 1000 * GiB } : p)),
      volumes: r.volumes.map((v) => ({ ...v, bitlocker: 1 })),
    }));
    const removed = { phase: "disk" as const, at: 1000, expect: expected };
    const good = removalOf(removed, 2000, back, { shim: false });
    expect(good).toMatchObject({ state: "checked", ok: true });
    if (good?.state !== "checked") throw new Error("not checked");
    expect(good.checks.map((c) => [c.id, c.value])).toEqual([
      ["windows", "Started as usual"],
      ["partitions", "Gone from the disk"],
      ["space", "Its 1000 GB again"],
      ["bitlocker-C", "On"],
      ["record", "Gone"],
    ]);
    // A partition left behind, C: still short, BitLocker off: each is named, and the whole is not ok.
    const bad = facts((r) => ({
      ...r,
      partitions: [
        ...r.partitions,
        { disk: 0, number: 5, letter: "", type: TYPE.esp, id: `{${ESP}}`, offset: 1, size: GiB },
      ],
      volumes: r.volumes.map((v) => ({ ...v, bitlocker: 2 })),
    }));
    const checks = checksOf(expected, bad, { shim: true });
    expect(checks.filter((c) => !c.ok).map((c) => c.id)).toEqual([
      "windows",
      "partitions",
      "space",
      "bitlocker-C",
    ]);
    expect(removalOf(removed, 2000, bad, null)).toMatchObject({ state: "checked", ok: false });
  });

  it("reads each partition's GPT id, which the removal's check looks for", () => {
    const facts = pc((r) => ({
      ...r,
      partitions: [
        { disk: 0, number: 1, letter: "", type: "{x}", id: `{${ESP.toUpperCase()}}`, offset: MiB, size: GiB },
      ],
    })).facts;
    expect(facts.partitions[0]!.id).toBe(ESP);
  });

  it("puts Remove Lanterel OS before anything else on the screen, across its restarts", () => {
    const at = (removal: RentalRead["removal"]): RentalSetup => ({
      reading: false,
      read: { ...installed(), key: { state: "confirmed", code: null }, removal },
      target: null,
      preview: null,
      run: IDLE_RUN,
    });
    expect(rentalStage(at({ state: "queued", code: "55554444" }))).toEqual({
      kind: "restart",
      code: "55554444",
      removing: "key",
    });
    expect(rentalStage(at({ state: "finish" }))).toEqual({ kind: "finish" });
    expect(rentalLine(at({ state: "finish" }))).toBe("Removing");
    expect(rentalStage(at({ state: "restart" }))).toEqual({ kind: "restart", code: "", removing: "check" });
    const checks = [{ id: "windows", label: "Windows", ok: true, value: "Started as usual" }];
    expect(rentalStage(at({ state: "checked", ok: true, checks, at: 1 }))).toEqual({
      kind: "removed",
      ok: true,
      checks,
    });
    expect(rentalLine(at({ state: "checked", ok: false, checks, at: 1 }))).toBe("Removed, check it");
    expect(rentalReady(at({ state: "finish" }))).toBe(false);
  });

  it("asks for a new drive's recovery key before the disk part, which is a boot change too", () => {
    // BitLocker turned on for the games drive between the key's restart and the disk part: main refuses
    // the run until its key is saved, so the screen asks for it instead of offering Try again for ever.
    const setup = (saved: boolean): RentalSetup => ({
      reading: false,
      read: {
        ...installed(),
        removal: { state: "finish" },
        recovery: { drives: ["C", "D"], saved, at: null },
      },
      target: null,
      preview: null,
      run: IDLE_RUN,
    });
    expect(rentalStage(setup(false))).toEqual({ kind: "recovery", drives: ["C", "D"] });
    expect(rentalStage(setup(true))).toEqual({ kind: "finish" });
    // The key part's restart, already queued, is not held up.
    const queued = setup(false);
    queued.read!.removal = { state: "queued", code: "55554444" };
    expect(rentalStage(queued).kind).toBe("restart");
  });
});

describe("the BitLocker recovery key", () => {
  const on = (letters: string[]) => (raw: typeof FACTS) => ({
    ...raw,
    volumes: [
      ...raw.volumes.map((v) => ({ ...v, bitlocker: letters.includes(v.letter) ? 1 : 2 })),
      {
        letter: "D",
        fs: "NTFS",
        label: "Games",
        size: 500 * GiB,
        free: 100 * GiB,
        fixed: true,
        bitlocker: letters.includes("D") ? 1 : 2,
      },
    ],
  });

  it("looks at C: and the games drive, and only those BitLocker protects", () => {
    expect(bitlockerDrives(pc(on(["C"])))).toEqual(["C"]);
    expect(bitlockerDrives(pc(on(["C", "D"]), [{ letter: "D", games: 4 }]))).toEqual(["C", "D"]);
    expect(bitlockerDrives(pc(on(["D"]), [{ letter: "C", games: 4 }]))).toEqual([]);
    expect(bitlockerDrives(pc(on([])))).toEqual([]);
    expect(bitlockerDrives(null)).toEqual([]);
  });

  it("asks again for a drive seen without BitLocker, should BitLocker protect it later", () => {
    const { files, disk } = memoryFiles();
    const store = recoveryStore("/data", files);
    store.saved(["C", "D"], 1000);
    // A read sees D: (the games drive) without BitLocker: its confirmation goes, C:'s stays.
    const offD = pc(on(["C"]), [{ letter: "D", games: 4 }]);
    expect(drivesOff(offD)).toEqual(["D"]);
    store.forget(drivesOff(offD));
    expect(store.read()).toEqual({ at: 1000, drives: ["C"] });
    // BitLocker on D: again, with a new key: the owner is asked again.
    expect(
      recoveryOf(store.read(), bitlockerDrives(pc(on(["C", "D"]), [{ letter: "D", games: 4 }]))).saved,
    ).toBe(false);
    // A drive whose state was not read keeps its confirmation; with none left, nothing is kept.
    const unread = pc((raw) => ({ ...raw, volumes: raw.volumes.map((v) => ({ ...v, bitlocker: null })) }));
    expect(drivesOff(unread)).toEqual([]);
    store.forget(drivesOff(pc(on([]))));
    expect(store.read()).toBeNull();
    expect(disk.size).toBe(0);
    expect(drivesOff(null)).toEqual([]);
  });

  it("keeps the owner's word that they saved it, for which drives and when, and never a key", () => {
    const { files, disk } = memoryFiles();
    const store = recoveryStore("/data", files);
    expect(recoveryOf(store.read(), ["C"])).toEqual({ drives: ["C"], saved: false, at: null });
    store.saved(["C"], 1000);
    expect(recoveryOf(store.read(), ["C"])).toEqual({ drives: ["C"], saved: true, at: 1000 });
    // A drive BitLocker protects later asks again.
    expect(recoveryOf(store.read(), ["C", "D"]).saved).toBe(false);
    store.saved(["D"], 2000);
    expect(recoveryOf(store.read(), ["C", "D"]).saved).toBe(true);
    expect(JSON.parse([...disk.values()][0]!)).toEqual({ at: 2000, drives: ["C", "D"] });
    // Nothing protected: nothing to save.
    expect(recoveryOf(null, []).saved).toBe(true);
  });

  it("keeps no recovery key or protector in what it read, even when one comes with the volumes", () => {
    const password = "123456-234567-345678-456789-567890-678901-789012-890123";
    const { facts } = pc((r) => ({
      ...r,
      volumes: r.volumes.map((v) => ({
        ...v,
        RecoveryPassword: password,
        KeyProtector: [{ KeyProtectorType: "RecoveryPassword", RecoveryPassword: password }],
      })),
    }));
    expect(facts.volumes.length).toBeGreaterThan(0);
    for (const v of facts.volumes) expect(Object.keys(v)).not.toContain("RecoveryPassword");
    expect(JSON.stringify(facts)).not.toMatch(/RecoveryPassword|KeyProtector|123456-234567/);
  });

  it("comes before the install, and before anything else that changes the boot once installed", () => {
    const due = { drives: ["C"], saved: false, at: null };
    const setup = (read: RentalRead): RentalSetup => ({
      reading: false,
      read,
      target: null,
      preview: null,
      run: IDLE_RUN,
    });
    const ready = { ...pc((r) => ({ ...r, fastStartup: 0 })), recovery: due };
    expect(rentalStage(setup(ready))).toEqual({ kind: "recovery", drives: ["C"] });
    expect(rentalLine(setup(ready))).toBe("Save your recovery key");
    expect(rentalStepAt(setup(ready))).toBe(0);
    expect(rentalStage(setup({ ...ready, recovery: { ...due, saved: true } })).kind).not.toBe("recovery");
    // A BIOS setting still comes first: the key is the last thing before the install.
    const bios = { ...pc((r) => ({ ...r, secureBoot: 0 })), recovery: due };
    expect(rentalStage(setup(bios)).kind).toBe("bios");
    // Installed before the gate: Go live, the key and removal all wait for it.
    const record = { complete: true, disk: 0, bootEntry: 3, partitions: [], mok: true };
    const installed = (key: RentalRead["key"]) =>
      setup({ ...pc((r) => ({ ...r, install: record })), key, recovery: due });
    for (const state of ["confirmed", "missed", "nokey"] as const) {
      expect(rentalStage(installed({ state, code: null }))).toEqual({ kind: "recovery", drives: ["C"] });
      expect(rentalReady(installed({ state, code: null }))).toBe(false);
    }
    // A blue screen already queued, or the question after it, is not held up.
    expect(rentalStage(installed({ state: "queued", code: "48217730" })).kind).toBe("restart");
    expect(rentalStage(installed({ state: "ask", code: null })).kind).toBe("ask");
  });

  it("names the drives as the owner reads them", () => {
    expect(drivesLine(["C"])).toBe("C:");
    expect(drivesLine(["C", "D"])).toBe("C: and D:");
    expect(drivesLine(["C", "D", "E"])).toBe("C:, D: and E:");
  });
});
