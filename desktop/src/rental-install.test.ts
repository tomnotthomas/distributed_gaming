// @vitest-environment node
// Rental mode's installer: the firmware variables it writes (efi.cjs), the
// runner that asks the owner before each step (rental-exec.cjs), and the
// elevated worker (rental-worker.cjs) carrying out the install and the
// uninstall on a stand-in for Windows: a disk in memory, firmware variables
// in a map, and PowerShell answering the few things it is asked.

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as efi from "../efi.cjs";
import { emptyGpt, gptWrites, readGpt, withPartitions, withResized, type Gpt } from "../gpt.cjs";
import { testBuild } from "../build-kind.cjs";
import { copyChecked, MANIFEST, SIGNATURE, readImageSet, trustOf } from "../image-set.cjs";
import { channelOf, clientOf, dryRun, handshake, runPlan, startWorker } from "../rental-exec.cjs";
import { checkOp, createWorker, diskPath, serve, type Windows } from "../rental-worker.cjs";
import {
  installOf,
  installPlan,
  keyRemovalPlan,
  mokRequest,
  rentalOf,
  splitFile,
  SWIFF_OS,
  switchPlan,
  TYPE,
  uninstallPlan,
  type PlanOp,
  type RentalPlan,
} from "../rental.cjs";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const DISK = 64 * GiB;
const C_INDEX = 2;
const MSR = "e3c9e316-0b5c-4db8-817d-f92df00215ae";
const RECOVERY = "de94bba4-06d1-4d40-a16a-bfd50179d6ac";
const CERT = Buffer.from("3082010a0282010100c0ffee", "hex");
const ID = (i: number) => `00000000-0000-4000-8000-00000000000${i}`;
const NAMES = ["esp", "swiffos_0.1.0", "swiffos_0.1.0", "_empty", "_empty", "swiff-scratch"];
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Swiff's signing key, for the tests, and what the app trusts of it. */
const SIGNER = generateKeyPairSync("ed25519");
const TRUST = [
  { publicKey: SIGNER.publicKey.export({ type: "spki", format: "pem" }) as string, certSha256: sha256(CERT) },
];

/**
 * An image set with its manifest, signed by `key`, and certificate `cert`, but
 * no split files: what every op but `write` reads.
 */
function imageSet(dir: string, { key = SIGNER.privateKey, cert = CERT } = {}) {
  const layout = SWIFF_OS.partitions.map((p, i) => ({ ...p, id: ID(i), name: NAMES[i]! }));
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const p of layout.filter((p) => p.split))
    files[splitFile(p.split!)] = { bytes: p.bytes, sha256: "0".repeat(64) };
  files["swiffos-key.cer"] = { bytes: cert.length, sha256: sha256(cert) };
  const manifest = Buffer.from(JSON.stringify({ version: "0.1.0", layout, files }));
  fs.writeFileSync(path.join(dir, MANIFEST), manifest);
  fs.writeFileSync(path.join(dir, SIGNATURE), sign(null, manifest, key));
  fs.writeFileSync(path.join(dir, "swiffos-key.cer"), cert);
  return layout;
}

/** Windows on a 64 GiB disk like a laptop's: ESP, reserved, C: (BitLocker on), recovery at the end. */
function fakeWindows(stateDir: string) {
  const chunks = new Map<number, Buffer>();
  const disk = {
    bytes: DISK,
    sector: 512,
    read(offset: number, length: number) {
      const out = Buffer.alloc(length);
      for (const [at, chunk] of chunks) {
        const from = Math.max(at, offset);
        const to = Math.min(at + chunk.length, offset + length);
        if (from < to) chunk.copy(out, from - offset, from - at, to - at);
      }
      return out;
    },
    write(writes: { offset: number; bytes: Buffer }[]) {
      for (const w of writes) chunks.set(w.offset, Buffer.from(w.bytes));
    },
    close() {},
  };
  const s = (b: number) => b / 512;
  const gpt0 = withPartitions(emptyGpt({ diskBytes: DISK, diskId: "5a1d0c3e-7b2f-4e1a-9c8d-3f6e2b1a0d9c" }), [
    {
      type: TYPE.esp,
      id: "1e5c7a90-3b2d-4f6e-8a1c-0d9e2f3b4a51",
      name: "EFI system partition",
      first: s(MiB),
      last: s(301 * MiB) - 1,
    },
    {
      type: MSR,
      id: "2f6d8ba1-4c3e-4071-9b2d-1eaf304c5b62",
      name: "Microsoft reserved partition",
      first: s(301 * MiB),
      last: s(317 * MiB) - 1,
    },
    {
      type: TYPE.windowsData,
      id: "307e9cb2-5d4f-4182-8c3e-2fb0415d6c73",
      name: "Basic data partition",
      first: s(317 * MiB),
      last: s(DISK - GiB - MiB) - 1,
    },
    {
      type: RECOVERY,
      id: "418fadc3-6e50-4293-9d4f-30c1526e7d84",
      name: "",
      first: s(DISK - GiB - MiB),
      last: s(DISK - MiB) - 1,
    },
  ]);
  disk.write(gptWrites(gpt0, { mbr: true }));
  const gpt = (): Gpt => readGpt(disk.read, { diskBytes: DISK });
  const cSize = () => {
    const c = gpt().entries.find((e) => e.index === C_INDEX)!;
    return (c.last - c.first + 1) * 512;
  };
  const resize = (size: number) => {
    const c = gpt().entries.find((e) => e.index === C_INDEX)!;
    disk.write(gptWrites(withResized(gpt(), C_INDEX, c.first + size / 512 - 1)));
  };
  const vars = new Map<string, Buffer>();
  const key = (guid: string, name: string) => `${guid}/${name}`;
  vars.set(
    key(efi.GLOBAL, "Boot0000"),
    efi.loadOption({
      title: "Windows Boot Manager",
      partition: {
        number: 1,
        first: 2048,
        sectors: s(300 * MiB),
        id: "1e5c7a90-3b2d-4f6e-8a1c-0d9e2f3b4a51",
      },
      path: "\\EFI\\Microsoft\\Boot\\bootmgfw.efi",
    }),
  );
  vars.set(key(efi.GLOBAL, "BootOrder"), efi.orderBytes([0]));
  vars.set(key(efi.GLOBAL, "BootCurrent"), efi.orderBytes([0]));
  let label = "Windows";
  let hiberboot = "1";
  const shell: string[] = [];
  const win: Windows = {
    stateDir,
    async openDisk(n) {
      if (n !== 0) throw new Error(`no disk ${n}`);
      return disk;
    },
    async firmware(requests) {
      const out: Record<string, Buffer | null> = {};
      for (const r of requests) {
        if ("set" in r) {
          if (r.data) vars.set(key(r.guid, r.set), Buffer.from(r.data));
          else vars.delete(key(r.guid, r.set));
        } else out[r.get] = vars.get(key(r.guid, r.get)) ?? null;
      }
      return out;
    },
    async powershell(lines) {
      const text = lines.join("\n");
      shell.push(text);
      let m: RegExpMatchArray | null;
      if (/Get-Partition -DiskNumber 0 -PartitionNumber 3$/m.test(text))
        return JSON.stringify({ letter: "C", size: cSize(), type: `{${TYPE.windowsData}}` });
      if (/HiberbootEnabled$/m.test(text)) return `${hiberboot}\r\n`;
      if (/HiberbootEnabled \/t REG_DWORD \/d (\d)/.test(text)) hiberboot = /\/d (\d)/.exec(text)![1]!;
      if ((m = /Resize-Partition -DiskNumber 0 -PartitionNumber 3 -Size (\d+)$/m.exec(text)))
        resize(Number(m[1]));
      if ((m = /-Size \(\[Math\]::Min\(\$max, (\d+)\)\)/.exec(text))) resize(Number(m[1]));
      if (/FileSystemLabel$/m.test(text)) return `${label}\r\n`;
      if ((m = /Set-Volume -DriveLetter C -NewFileSystemLabel '(.*)'/.exec(text))) label = m[1]!;
      return "";
    },
  };
  /** What the app's read-only script would print on this PC now. */
  const facts = () => ({
    firmware: "UEFI",
    secureBoot: 1,
    tpm2: true,
    tpmInfo: "-TPM Manufacturer ID: AMD",
    securityProperties: [1, 2, 3],
    fastStartup: Number(hiberboot),
    gpus: [{ name: "AMD Radeon(TM) Graphics", pnp: "PCI\\VEN_1002&DEV_1681" }],
    disks: [{ number: 0, style: "GPT", size: DISK, sector: 512, bus: "NVMe", system: true }],
    partitions: gpt().entries.map((e) => ({
      disk: 0,
      number: e.index + 1,
      letter: e.index === C_INDEX ? "C" : "\u0000",
      type: `{${e.type}}`,
      offset: e.first * 512,
      size: (e.last - e.first + 1) * 512,
    })),
    volumes: [
      { letter: "C", fs: "NTFS", label, size: cSize(), free: cSize() - 8 * GiB, fixed: true, bitlocker: 1 },
    ],
    install: (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(stateDir, "rental-install.json"), "utf8"));
      } catch {
        return null;
      }
    })(),
  });
  return { win, disk, gpt, vars, key, shell, facts, cSize, label: () => label, hiberboot: () => hiberboot };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swiff-install-"));
  fs.mkdirSync(path.join(dir, "image"));
  fs.mkdirSync(path.join(dir, "state"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function setup() {
  const layout = imageSet(path.join(dir, "image"));
  const pc = fakeWindows(path.join(dir, "state"));
  const worker = await createWorker({ imageDir: path.join(dir, "image"), trust: TRUST, win: pc.win });
  return { pc, worker, layout };
}

// Writing 9 GB is the VM test's (vm/windows-install-test.sh): here, everything else.
const skipping =
  (apply: (op: PlanOp) => Promise<unknown>) =>
  async (op: PlanOp): Promise<Record<string, unknown>> =>
    op.op === "write" || op.op === "image-check" ? {} : ((await apply(op)) as Record<string, unknown>);

describe("firmware variables", () => {
  it("writes a boot entry byte for byte as efibootmgr and virt-firmware do", () => {
    const option = efi.loadOption({
      title: "Swiff OS",
      partition: { number: 1, first: 2048, sectors: 2097152, id: "3D7B64D1-2E0C-493B-958E-7F825AEC1F7C" },
      path: "\\EFI\\swiff\\shimx64.efi",
    });
    expect(option.toString("hex")).toBe(
      "0100000060005300770069006600660020004f005300000004012a000100000000080000000000000000200000000000d1647b3d0c2e3b49958e7f825aec1f7c0202040432005c004500460049005c00730077006900660066005c007300680069006d007800360034002e0065006600690000007fff0400",
    );
    expect(efi.parseLoadOption(option)).toEqual({
      active: true,
      title: "Swiff OS",
      partition: "3d7b64d1-2e0c-493b-958e-7f825aec1f7c",
      file: "\\EFI\\swiff\\shimx64.efi",
    });
    expect(() =>
      efi.loadOption({ title: "x", partition: { number: 1, first: 1, sectors: 1, id: ID(0) }, path: "C:/x" }),
    ).toThrow();
  });

  it("reads a path the firmware split into one node per folder, and matches paths in any case", () => {
    const option = efi.loadOption({
      title: "S",
      partition: { number: 1, first: 2048, sectors: 2097152, id: ID(0) },
      path: "\\x.efi",
    });
    const hd = option.subarray(10, 52);
    const node = (text: string) => {
      const name = Buffer.from(`${text}\0`, "utf16le");
      const head = Buffer.from([4, 4, 0, 0]);
      head.writeUInt16LE(4 + name.length, 2);
      return Buffer.concat([head, name]);
    };
    const paths = Buffer.concat([
      hd,
      node("\\EFI"),
      node("SWIFF"),
      node("\\SHIMX64.EFI"),
      Buffer.from([0x7f, 0xff, 4, 0]),
    ]);
    const head = Buffer.alloc(6);
    head.writeUInt32LE(1, 0);
    head.writeUInt16LE(paths.length, 4);
    const split = Buffer.concat([head, Buffer.from("S\0", "utf16le"), paths]);
    expect(efi.parseLoadOption(split)).toMatchObject({ partition: ID(0), file: "\\EFI\\SWIFF\\SHIMX64.EFI" });
    expect(efi.samePath("\\EFI\\SWIFF\\SHIMX64.EFI", "\\EFI\\swiff\\shimx64.efi")).toBe(true);
    expect(efi.samePath("EFI/swiff/shimx64.efi", "\\EFI\\swiff\\shimx64.efi")).toBe(true);
    expect(efi.samePath("\\EFI\\swiff\\grubx64.efi", "\\EFI\\swiff\\shimx64.efi")).toBe(false);
    expect(efi.samePath(null, "\\x")).toBe(false);
  });

  it("orders boot entries, and names them Boot####", () => {
    expect(efi.orderOf(efi.orderBytes([0, 3, 0x1a]))).toEqual([0, 3, 0x1a]);
    expect(efi.placeIn([0, 3, 1], 1, "first")).toEqual([1, 0, 3]);
    expect(efi.placeIn([1, 0], 1, "last")).toEqual([0, 1]);
    expect(efi.bootName(26)).toBe("Boot001A");
    expect(efi.bootIndex("Boot001A")).toBe(26);
    expect(efi.bootIndex("BootOrder")).toBeNull();
  });

  it("queues a key's removal the way mokutil --delete does, and finds a key in MokList", () => {
    const { MokNew, MokAuth } = mokRequest(CERT, "12345678");
    const del = efi.mokVariables(CERT, "12345678", { remove: true });
    expect(del.MokDel!.equals(MokNew)).toBe(true);
    expect(del.MokDelAuth!.equals(MokAuth)).toBe(true);
    expect(efi.mokListHas(MokNew, CERT)).toBe(true);
    expect(efi.mokListHas(MokNew, Buffer.from("00", "hex"))).toBe(false);
    expect(efi.mokListHas(null, CERT)).toBe(false);
  });

  it("asks MokManager to wait for the owner with each request: MokTimeout -1, as mokutil --timeout -1", () => {
    expect(efi.mokVariables(CERT, "12345678").MokTimeout!.readInt32LE(0)).toBe(-1);
    expect(efi.mokVariables(CERT, "12345678", { remove: true }).MokTimeout!.readInt32LE(0)).toBe(-1);
    expect(mokRequest(CERT, "12345678").MokTimeout.equals(efi.MOK_WAIT)).toBe(true);
  });
});

describe("running a plan", () => {
  const plan: RentalPlan = {
    kind: "install",
    steps: [
      { id: "a", title: "A", confirm: null, ops: [{ op: "fast-startup-off" }], commands: [] },
      {
        id: "b",
        title: "B",
        confirm: "Changes the disk.",
        ops: [{ op: "installed" }, { op: "forget" }],
        commands: [],
      },
      { id: "c", title: "C", confirm: "Restarts.", ops: [{ op: "restart" }], commands: [] },
    ],
  };

  it("asks before each step that says so, and stops where the owner says no", async () => {
    const w = dryRun();
    const asked: string[] = [];
    const outcome = await runPlan(plan, {
      apply: w.apply,
      confirm: async (step) => (asked.push(step.id), step.id === "b"),
    });
    expect(asked).toEqual(["b", "c"]);
    expect(outcome).toMatchObject({ status: "stopped", done: ["a", "b"], stoppedAt: "c" });
    expect(w.ops.map((o) => o.op)).toEqual(["fast-startup-off", "installed", "forget"]);
  });

  it("stops at the first operation that fails, and says which", async () => {
    const events: unknown[] = [];
    const outcome = await runPlan(plan, {
      apply: async (op) => {
        if (op.op === "installed") throw new Error("no room");
        return {};
      },
      onEvent: (e) => events.push(e),
    });
    expect(outcome).toMatchObject({
      status: "failed",
      done: ["a"],
      failed: { step: "b", op: "installed", error: "no room" },
    });
    expect(events).toContainEqual({ type: "step", id: "b", state: "failed", error: "no room" });
  });

  it("runs only the steps asked for, one at a time", async () => {
    const w = dryRun();
    expect(await runPlan(plan, { apply: w.apply, only: ["c"] })).toMatchObject({
      status: "done",
      done: ["c"],
    });
    expect(w.ops).toEqual([{ op: "restart" }]);
  });
});

describe("the elevated worker", () => {
  it("installs Swiff OS next to Windows, then takes it all off again", async () => {
    const { pc, worker, layout } = await setup();
    const before = pc.cSize();
    const rental = rentalOf(pc.facts(), [{ letter: "C", games: 1 }]);
    const plan = installPlan(rental, { layout, code: "48217730" });
    const outcome = await runPlan(plan, { apply: skipping(worker.apply) });
    expect(outcome).toMatchObject({ status: "done" });
    // BitLocker suspended, Fast Startup off, C: named for Swiff OS.
    expect(pc.shell.join("\n")).toMatch(/manage-bde -protectors -disable C: -RebootCount 3/);
    expect(pc.hiberboot()).toBe("0");
    expect(pc.label()).toBe("SWIFFGAMES");
    // C: gave Swiff OS its room, and the image's six partitions are in it, with its ids and names.
    expect(pc.cSize()).toBeLessThan(before);
    const added = pc.gpt().entries.filter((e) => e.index > 3);
    expect(added.map((e) => [e.id, e.name])).toEqual(layout.map((p) => [p.id, p.name]));
    // The boot entry starts the shim on Swiff OS's ESP, last in the order; BootNext for the restart.
    const option = efi.parseLoadOption(pc.vars.get(pc.key(efi.GLOBAL, "Boot0001"))!);
    expect(option).toMatchObject({ title: "Swiff OS", partition: ID(0), file: "\\EFI\\swiff\\shimx64.efi" });
    expect(efi.orderOf(pc.vars.get(pc.key(efi.GLOBAL, "BootOrder")))).toEqual([0, 1]);
    expect(efi.orderOf(pc.vars.get(pc.key(efi.GLOBAL, "BootNext")))).toEqual([1]);
    // Swiff's key queued with the owner's code, as mokutil would.
    const { MokNew, MokAuth } = mokRequest(CERT, "48217730");
    expect(pc.vars.get(pc.key(efi.SHIM_LOCK, "MokNew"))!.equals(MokNew)).toBe(true);
    expect(pc.vars.get(pc.key(efi.SHIM_LOCK, "MokAuth"))!.equals(MokAuth)).toBe(true);
    // MokManager waits for the owner instead of counting 10 seconds down into Windows.
    expect(pc.vars.get(pc.key(efi.SHIM_LOCK, "MokTimeout"))!.readInt32LE(0)).toBe(-1);
    expect(pc.shell.at(-1)).toMatch(/^shutdown \/r \/t 5/m);
    const record = installOf(worker.state())!;
    // Each boot entry by what it starts, never by its Boot#### number.
    expect(record).toMatchObject({
      complete: true,
      disk: 0,
      bootEntry: { partition: ID(0), path: "\\EFI\\swiff\\shimx64.efi" },
      windowsEntry: { path: expect.stringMatching(/bootmgfw\.efi$/i) },
      bitlocker: "C",
      fastStartup: true,
      mok: true,
    });
    // The check's findings sit beside the record, not in it: a check alone is no install begun.
    expect(JSON.parse(fs.readFileSync(path.join(dir, "state", "rental-check.json"), "utf8"))).toMatchObject({
      ek: true,
    });
    expect(worker.state()).not.toHaveProperty("checked");
    expect(JSON.stringify(worker.state())).not.toMatch(/"bootEntry":\d/);
    expect(rentalOf(pc.facts()).installed).toBe(true);

    // Once: BootNext alone.
    pc.vars.delete(pc.key(efi.GLOBAL, "BootNext"));
    expect(await runPlan(switchPlan("once"), { apply: worker.apply })).toMatchObject({ status: "done" });
    expect(efi.orderOf(pc.vars.get(pc.key(efi.GLOBAL, "BootNext")))).toEqual([1]);
    expect(efi.orderOf(pc.vars.get(pc.key(efi.GLOBAL, "BootOrder")))).toEqual([0, 1]);
    // Sharing: Swiff OS first; stopping: Windows first.
    await runPlan(switchPlan("start"), { apply: worker.apply });
    expect(efi.orderOf(pc.vars.get(pc.key(efi.GLOBAL, "BootOrder")))).toEqual([1, 0]);
    await runPlan(switchPlan("stop"), { apply: worker.apply });
    expect(efi.orderOf(pc.vars.get(pc.key(efi.GLOBAL, "BootOrder")))).toEqual([0, 1]);

    // The key first, while shim and MokManager are still on the disk: MokDel, BootNext, restart.
    pc.vars.delete(pc.key(efi.GLOBAL, "BootNext"));
    expect(await runPlan(keyRemovalPlan("11112222"), { apply: worker.apply })).toMatchObject({
      status: "done",
    });
    expect(efi.orderOf(pc.vars.get(pc.key(efi.GLOBAL, "BootNext")))).toEqual([1]);
    const out = uninstallPlan(rentalOf(pc.facts()));
    expect(await runPlan(out, { apply: worker.apply })).toMatchObject({ status: "done" });
    expect(pc.gpt().entries).toHaveLength(4);
    expect(pc.cSize()).toBe(before);
    expect(pc.label()).toBe("Windows");
    expect(pc.hiberboot()).toBe("1");
    expect(pc.shell.join("\n")).toMatch(/manage-bde -protectors -enable C:/);
    expect(pc.vars.has(pc.key(efi.GLOBAL, "Boot0001"))).toBe(false);
    expect(pc.vars.has(pc.key(efi.GLOBAL, "BootNext"))).toBe(false);
    expect(efi.orderOf(pc.vars.get(pc.key(efi.GLOBAL, "BootOrder")))).toEqual([0]);
    expect(pc.vars.has(pc.key(efi.SHIM_LOCK, "MokNew"))).toBe(false);
    expect(pc.vars.get(pc.key(efi.SHIM_LOCK, "MokDel"))!.equals(MokNew)).toBe(true);
    expect(fs.existsSync(path.join(dir, "state", "rental-install.json"))).toBe(false);
    expect(rentalOf(pc.facts()).facts.install).toBeNull();
  });

  it("uses only an image set Swiff signed, carrying the certificate Swiff's key's sets carry", async () => {
    const image = path.join(dir, "image");
    const pc = fakeWindows(path.join(dir, "state"));
    const mok = { op: "mok-import", cert: "swiffos-key.cer", code: "48217730" } as const;
    const worker = async () => createWorker({ imageDir: image, trust: TRUST, win: pc.win });

    imageSet(image, { key: generateKeyPairSync("ed25519").privateKey });
    await expect((await worker()).apply(mok)).rejects.toThrow(/Swiff did not sign this image set/);
    imageSet(image);
    const manifest = JSON.parse(fs.readFileSync(path.join(image, MANIFEST), "utf8"));
    fs.writeFileSync(path.join(image, MANIFEST), JSON.stringify({ ...manifest, version: "0.1.1" }));
    await expect((await worker()).apply(mok)).rejects.toThrow(/Swiff did not sign this image set/);
    // Signed, but with another certificate than the one the app knows for this key.
    imageSet(image, { cert: Buffer.from("3082010a0282010100badbad", "hex") });
    await expect((await worker()).apply(mok)).rejects.toThrow(/certificate is not Swiff's/);
    // Swapped after the manifest was signed.
    imageSet(image);
    fs.writeFileSync(path.join(image, "swiffos-key.cer"), Buffer.from("3082010a0282010100badbad", "hex"));
    await expect((await worker()).apply(mok)).rejects.toThrow(/is not the file its image set lists/);
    // Left out of a download whose manifest and signature arrived: the image set's own failure, at the check too.
    fs.rmSync(path.join(image, "swiffos-key.cer"));
    await expect((await worker()).apply(mok)).rejects.toThrow(
      /swiffos-key\.cer of the image set is not on this PC/,
    );
    await expect((await worker()).apply({ op: "image-check" })).rejects.toThrow(
      /swiffos-key\.cer of the image set is not on this PC/,
    );
    expect(pc.vars.has(pc.key(efi.SHIM_LOCK, "MokNew"))).toBe(false);
    // Nothing of what was refused stays in the administrators' folder.
    expect(fs.readdirSync(path.join(dir, "state", "swiff-os"))).not.toContain("swiffos-key.cer");
  });

  it("keeps the image set it uses in the administrators' folder, emptied on every start", async () => {
    const image = path.join(dir, "image");
    imageSet(image);
    const pc = fakeWindows(path.join(dir, "state"));
    const home = path.join(dir, "state", "swiff-os");
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, "swiffos-key.cer"), "left by someone else");
    const worker = await createWorker({ imageDir: image, trust: TRUST, win: pc.win });
    expect(fs.readdirSync(home)).toEqual([]);
    await worker.apply({ op: "mok-import", cert: "swiffos-key.cer", code: "48217730" });
    expect(fs.readFileSync(path.join(home, "swiffos-key.cer")).equals(CERT)).toBe(true);
    expect(
      fs.readFileSync(path.join(home, MANIFEST)).equals(fs.readFileSync(path.join(image, MANIFEST))),
    ).toBe(true);
    // Changed in the owner's folder after it was read: the worker goes on with what it checked.
    fs.writeFileSync(path.join(image, MANIFEST), "{}");
    await expect(
      worker.apply({ op: "mok-delete", cert: "swiffos-key.cer", code: "48217730" }),
    ).resolves.toEqual({});
  });

  it("trusts the developer's key only in a test build, and refuses a tampered set in either", async () => {
    const dev = path.join(__dirname, "..", "image-trust.dev.json");
    const files = {
      readFileSync: (file: string) => {
        if (file === dev) return JSON.stringify(TRUST);
        if (file.endsWith("image-trust.json")) return "[]";
        throw new Error("ENOENT");
      },
    } as unknown as typeof fs;
    const image = path.join(dir, "image");
    const pc = fakeWindows(path.join(dir, "state"));
    const BAD = Buffer.from("3082010a0282010100badbad", "hex");
    const builds = { release: {}, test: { swiffBuild: "test" } };
    expect(testBuild({})).toBe(false);
    expect(testBuild({ swiffBuild: "release" })).toBe(false);
    for (const [kind, pkg] of Object.entries(builds)) {
      const trust = trustOf({ dev: testBuild(pkg) }, files);
      const check = async () =>
        (await createWorker({ imageDir: image, trust, win: pc.win })).apply({ op: "image-check" });

      imageSet(image);
      if (kind === "test") {
        expect(readImageSet(image, { trust }).version).toBe("0.1.0");
        // Past its signature and certificate, to its images, which this set leaves out.
        await expect(check()).rejects.toThrow(/swiffos_0\.1\.0\.esp\.raw of the image set is not on this PC/);
      } else {
        expect(() => readImageSet(image, { trust })).toThrow(/Swiff did not sign this image set/);
        await expect(check()).rejects.toThrow(/Swiff did not sign this image set/);
      }

      const manifest = JSON.parse(fs.readFileSync(path.join(image, MANIFEST), "utf8"));
      fs.writeFileSync(path.join(image, MANIFEST), JSON.stringify({ ...manifest, version: "0.1.1" }));
      await expect(check(), `${kind}: manifest`).rejects.toThrow(/Swiff did not sign this image set/);

      imageSet(image);
      fs.writeFileSync(path.join(image, "swiffos-key.cer"), BAD);
      await expect(check(), `${kind}: certificate`).rejects.toThrow(/image set/);

      // An image file swapped after the set was signed: never copied where the worker writes from.
      const good = Buffer.from("Swiff OS's root");
      const from = path.join(image, "root.raw");
      const to = path.join(dir, "state", "root.raw");
      fs.writeFileSync(from, "Someone else's!");
      await expect(
        copyChecked(from, to, { bytes: good.length, sha256: sha256(good) }),
        `${kind}: image`,
      ).rejects.toThrow(/root\.raw is not the file its image set lists/);
      expect(fs.existsSync(to)).toBe(false);
      fs.writeFileSync(from, good);
      await copyChecked(from, to, { bytes: good.length, sha256: sha256(good) });
      expect(fs.readFileSync(to).equals(good)).toBe(true);
      fs.rmSync(to);
    }
  });

  it("checks each image where it is, before anything changes: a missing, short or altered one stops it", async () => {
    const good = Buffer.from("Swiff OS's root");
    const listed = { bytes: good.length, sha256: sha256(good) };
    const from = path.join(dir, "image", "root.raw");
    const progress: number[] = [];
    await expect(copyChecked(from, null, listed)).rejects.toThrow(
      /root\.raw of the image set is not on this PC/,
    );
    // A download that stopped part way.
    fs.writeFileSync(from, good.subarray(0, 6));
    await expect(copyChecked(from, null, listed)).rejects.toThrow(
      /root\.raw is not the file its image set lists/,
    );
    fs.writeFileSync(from, "Someone else's!");
    await expect(copyChecked(from, null, listed)).rejects.toThrow(
      /root\.raw is not the file its image set lists/,
    );
    fs.writeFileSync(from, good);
    await copyChecked(from, null, listed, (done) => progress.push(done));
    expect(progress).toEqual([good.length]);
    // Checked in place: nothing written beside it, nothing taken from C:.
    expect(fs.readdirSync(path.join(dir, "image"))).toEqual(["root.raw"]);
  });

  it("adds only the image's own partitions, and writes only into the ones it added", async () => {
    const { pc, worker, layout } = await setup();
    const rental = rentalOf(pc.facts(), []);
    const plan = installPlan(rental, { layout });
    const add = plan.steps.find((s) => s.id === "partitions")!.ops[0]! as Extract<PlanOp, { op: "gpt-add" }>;
    const forged = { ...add, partitions: add.partitions.map((p, i) => (i === 1 ? { ...p, id: ID(9) } : p)) };
    await expect(worker.apply(forged)).rejects.toThrow(/not the image's root-a/);
    const shifted = { ...add, partitions: add.partitions.map((p) => ({ ...p, offset: p.offset - GiB })) };
    // Over C:, which is not shrunk yet.
    await expect(worker.apply(shifted)).rejects.toThrow(/overlap/);
    expect(pc.gpt().entries).toHaveLength(4);
    const c = pc.gpt().entries.find((e) => e.index === C_INDEX)!;
    await expect(
      worker.apply({ op: "write", disk: 0, offset: c.first * 512, bytes: GiB, source: "esp" }),
    ).rejects.toThrow(/not one of Swiff OS's partitions/);
  });

  it("keeps the boot partition typed Linux data until it is written, so Windows does not mount it mid-write", async () => {
    const { pc, worker, layout } = await setup();
    const plan = installPlan(rentalOf(pc.facts(), []), { layout });
    await runPlan(plan, { apply: skipping(worker.apply), only: ["room", "partitions"] });
    const esp = () => pc.gpt().entries.find((e) => e.id === ID(0))!;
    expect(esp().type).toBe(TYPE.linux);
    await runPlan(plan, { apply: skipping(worker.apply), only: ["boot-entry"] });
    expect(esp().type).toBe(TYPE.esp);
    expect(pc.shell.filter((t) => t === "Update-Disk -Number 0")).toHaveLength(2);
  });

  it("shrinks only the drive it was told about, and removes only what it added", async () => {
    const { worker } = await setup();
    await expect(
      worker.apply({ op: "shrink", disk: 0, partition: 3, size: 10 * GiB, letter: "D" }),
    ).rejects.toThrow(/is not D:/);
    await expect(
      worker.apply({
        op: "gpt-remove",
        disk: 0,
        partitions: [{ role: "esp", id: ID(0), offset: MiB, bytes: 300 * MiB }],
      }),
    ).rejects.toThrow(/not on that disk/);
    await expect(worker.apply({ op: "label", letter: "C", label: "Evil" })).rejects.toThrow(
      /does not name drives Evil/,
    );
    await expect(worker.apply({ op: "forget" })).resolves.toEqual({});
  });

  /** Swiff OS installed up to its boot entry, Boot0001. */
  async function withEntry() {
    const set = await setup();
    const plan = installPlan(rentalOf(set.pc.facts(), []), { layout: set.layout });
    await runPlan(plan, { apply: skipping(set.worker.apply), only: ["room", "partitions", "boot-entry"] });
    expect(installOf(set.worker.state())!.bootEntry).toEqual({
      partition: ID(0),
      path: "\\EFI\\swiff\\shimx64.efi",
    });
    expect(set.pc.vars.has(set.pc.key(efi.GLOBAL, "Boot0001"))).toBe(true);
    return set;
  }

  it("follows its boot entry when the firmware renumbers it, by the boot partition's id and shim's path", async () => {
    const { pc, worker } = await withEntry();
    // As on the GEEKOM: the entry moved to another number, its path in capitals, and BootOrder lists only Windows.
    const moved = efi.parseLoadOption(pc.vars.get(pc.key(efi.GLOBAL, "Boot0001"))!)!;
    expect(moved.partition).toBe(ID(0));
    const esp = pc.gpt().entries.find((e) => e.id === ID(0))!;
    pc.vars.delete(pc.key(efi.GLOBAL, "Boot0001"));
    pc.vars.set(
      pc.key(efi.GLOBAL, "Boot0005"),
      efi.loadOption({
        title: "Swiff OS",
        partition: { number: esp.index + 1, first: esp.first, sectors: esp.last - esp.first + 1, id: ID(0) },
        path: "\\EFI\\SWIFF\\SHIMX64.EFI",
      }),
    );
    pc.vars.set(pc.key(efi.GLOBAL, "BootOrder"), efi.orderBytes([0]));
    await expect(worker.apply({ op: "boot-next", entry: "swiff" })).resolves.toEqual({ entry: 5 });
    expect(efi.orderOf(pc.vars.get(pc.key(efi.GLOBAL, "BootNext")))).toEqual([5]);
    // The record does not change: it names what the entry starts, which did not move.
    expect(installOf(worker.state())!.bootEntry).toEqual({
      partition: ID(0),
      path: "\\EFI\\swiff\\shimx64.efi",
    });
    await worker.apply({ op: "boot-first", entry: "swiff" });
    expect(efi.orderOf(pc.vars.get(pc.key(efi.GLOBAL, "BootOrder")))).toEqual([5, 0]);
    // No new entry was made on the way.
    expect(pc.vars.has(pc.key(efi.GLOBAL, "Boot0001"))).toBe(false);
  });

  it("keeps hands off an entry that is not Swiff OS's, and adds its own again when the firmware dropped it", async () => {
    const { pc, worker } = await withEntry();
    const windows = pc.vars.get(pc.key(efi.GLOBAL, "Boot0000"))!;
    pc.vars.set(pc.key(efi.GLOBAL, "Boot0001"), windows);
    await expect(worker.apply({ op: "boot-next", entry: "swiff" })).resolves.toEqual({ entry: 2 });
    expect(pc.vars.get(pc.key(efi.GLOBAL, "Boot0001"))!.equals(windows)).toBe(true);
    expect(efi.parseLoadOption(pc.vars.get(pc.key(efi.GLOBAL, "Boot0002"))!)).toMatchObject({
      title: "Swiff OS",
      partition: ID(0),
      file: "\\EFI\\swiff\\shimx64.efi",
    });
    expect(efi.orderOf(pc.vars.get(pc.key(efi.GLOBAL, "BootOrder"))).at(-1)).toBe(2);
    expect(efi.orderOf(pc.vars.get(pc.key(efi.GLOBAL, "BootNext")))).toEqual([2]);
    expect(installOf(worker.state())).toMatchObject({
      bootEntry: { partition: ID(0), path: "\\EFI\\swiff\\shimx64.efi" },
      windowsEntry: { path: expect.stringMatching(/bootmgfw\.efi$/i) },
    });
    // Removing takes only its own entry away.
    await worker.apply({ op: "boot-entry-remove" });
    expect(pc.vars.has(pc.key(efi.GLOBAL, "Boot0002"))).toBe(false);
    expect(pc.vars.get(pc.key(efi.GLOBAL, "Boot0001"))!.equals(windows)).toBe(true);
    await expect(worker.apply({ op: "forget" })).rejects.toThrow(/still on this PC/);
  });

  it("counts a boot entry that is already gone as removed, every time it is asked", async () => {
    const { pc, worker } = await withEntry();
    pc.vars.delete(pc.key(efi.GLOBAL, "Boot0001"));
    pc.vars.set(pc.key(efi.GLOBAL, "BootOrder"), efi.orderBytes([0]));
    await expect(worker.apply({ op: "boot-entry-remove" })).resolves.toEqual({});
    expect(installOf(worker.state())!.bootEntry).toBeNull();
    await expect(worker.apply({ op: "boot-entry-remove" })).resolves.toEqual({});
    expect(efi.orderOf(pc.vars.get(pc.key(efi.GLOBAL, "BootOrder")))).toEqual([0]);
  });

  it("puts Windows first again by what its entry starts, wherever the firmware renumbered it", async () => {
    const { pc, worker } = await withEntry();
    const windows = pc.vars.get(pc.key(efi.GLOBAL, "Boot0000"))!;
    pc.vars.delete(pc.key(efi.GLOBAL, "Boot0000"));
    pc.vars.set(pc.key(efi.GLOBAL, "Boot0007"), windows);
    pc.vars.set(pc.key(efi.GLOBAL, "BootOrder"), efi.orderBytes([1, 7]));
    await worker.apply({ op: "boot-first", entry: "windows" });
    expect(efi.orderOf(pc.vars.get(pc.key(efi.GLOBAL, "BootOrder")))).toEqual([7, 1]);
  });

  it("turns a record from before, with Boot#### numbers, into what each entry starts", async () => {
    const { pc, layout } = await setup();
    const plan = installPlan(rentalOf(pc.facts(), []), { layout });
    const first = await createWorker({ imageDir: path.join(dir, "image"), trust: TRUST, win: pc.win });
    await runPlan(plan, { apply: skipping(first.apply), only: ["room", "partitions", "boot-entry"] });
    // As the GEEKOM's record was written: numbers, version 1.
    const file = path.join(dir, "state", "rental-install.json");
    const old = { ...JSON.parse(fs.readFileSync(file, "utf8")), version: 1, bootEntry: 1, windowsEntry: 0 };
    fs.writeFileSync(file, JSON.stringify(old));
    expect(installOf(old)!.bootEntry).toEqual({ partition: null, path: null });
    const worker = await createWorker({ imageDir: path.join(dir, "image"), trust: TRUST, win: pc.win });
    expect(worker.state()).toMatchObject({
      version: 2,
      bootEntry: { partition: ID(0), path: "\\EFI\\swiff\\shimx64.efi" },
      windowsEntry: { path: expect.stringMatching(/bootmgfw\.efi$/i) },
    });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).bootEntry).toEqual({
      partition: ID(0),
      path: "\\EFI\\swiff\\shimx64.efi",
    });
  });

  it("asks MokManager to wait with every Swiff OS start, and takes that back with the request", async () => {
    const { pc, worker } = await withEntry();
    await worker.apply({ op: "boot-next", entry: "swiff" });
    expect(pc.vars.get(pc.key(efi.SHIM_LOCK, "MokTimeout"))!.equals(efi.MOK_WAIT)).toBe(true);
    await worker.apply({ op: "mok-cancel" });
    expect(pc.vars.has(pc.key(efi.SHIM_LOCK, "MokTimeout"))).toBe(false);
  });

  it("reads BootNext back, and fails the restart's step when the firmware did not keep it", async () => {
    const { pc, worker } = await withEntry();
    const firmware = pc.win.firmware;
    pc.win.firmware = async (requests) =>
      firmware(requests.filter((r) => !("set" in r) || r.set !== "BootNext"));
    await expect(worker.apply({ op: "boot-next", entry: "swiff" })).rejects.toThrow(/did not keep BootNext/);
  });

  it("names the raw disk so that no Node version reads it as a share's root", () => {
    expect(diskPath(1)).toBe("\\\\.\\GLOBALROOT\\Device\\Harddisk1\\Partition0");
    // Electron 33's Node turned \\.\PhysicalDrive0 into \\.\PhysicalDrive0\ (EIO); this name has no root to add one to.
    expect(path.win32.toNamespacedPath(diskPath(0))).toBe(diskPath(0));
  });

  it("refuses operations it does not know, or that carry the wrong things", () => {
    expect(() => checkOp({ op: "format" })).toThrow(/Not an operation this installer knows/);
    expect(() => checkOp({ op: "bitlocker-suspend", letter: "C:", restarts: 3 })).toThrow();
    expect(() =>
      checkOp({ op: "boot-entry", disk: 0, offset: 0, path: "\\EFI\\evil.efi", title: "Swiff OS" }),
    ).toThrow();
    expect(() => checkOp({ op: "mok-import", cert: "other.cer", code: "12345678" })).toThrow();
    expect(() => checkOp({ op: "restart" })).not.toThrow();
  });
});

describe("the worker's pipe", () => {
  /** A peer without the token: answers the other end's nonce with a guess, and records what it hears. */
  const stranger = (socket: net.Socket) => {
    const heard: string[] = [];
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      for (const line of String(chunk).trim().split("\n")) {
        heard.push(line);
        const msg = JSON.parse(line);
        if (msg.nonce) socket.write(`${JSON.stringify({ proof: "00".repeat(32) })}\n`);
      }
    });
    socket.write(`${JSON.stringify({ nonce: "guess" })}\n`);
    return heard;
  };

  it("talks only to the process that proves it holds its token, and carries progress back", async () => {
    const pipe = path.join(dir, "pipe.sock");
    let strangerHeard: string[] = [];
    const client = await startWorker({
      imageDir: dir,
      pipe,
      command: (p, token) => ({ file: p, args: [token] }),
      launch: async ({ file, args: [token] }) => {
        // Someone else first: hung up on, and never told the token.
        const other = net.connect(file!);
        other.on("connect", () => (strangerHeard = stranger(other)));
        await new Promise((r) => other.once("close", r));
        expect(strangerHeard.join("\n")).not.toContain(token);
        const socket = net.connect(file!);
        socket.on("connect", async () => {
          const c = await handshake(socket, token!, "worker");
          c.send({ ok: true });
          c.listen(({ id, op }) => {
            c.send({ id, progress: { what: "x", done: 1, total: 2 } });
            c.send(op.op === "restart" ? { id, ok: false, error: "no" } : { id, ok: true, result: { echo: op.op } });
          });
        });
      },
    });
    const progress: unknown[] = [];
    await expect(client.apply({ op: "installed" }, (p) => progress.push(p))).resolves.toEqual({
      echo: "installed",
    });
    expect(progress).toEqual([{ what: "x", done: 1, total: 2 }]);
    await expect(client.apply({ op: "restart" })).rejects.toThrow("no");
    client.close();
  });

  it("has the worker hang up on a pipe that cannot prove it holds the token, before any hello or operation", async () => {
    const pipe = path.join(dir, "fake-app.sock");
    const token = "a".repeat(64);
    let heard: string[] = [];
    let closed!: Promise<unknown>;
    const server = net.createServer((s) => {
      closed = new Promise((r) => s.once("close", r));
      heard = stranger(s);
      // An operation sent along with the guess: never carried out.
      s.write(`${JSON.stringify({ id: 1, op: { op: "restart" } })}\n`);
    });
    await new Promise<void>((r) => server.listen(pipe, r));
    await serve(pipe, token, dir, []);
    await closed;
    server.close();
    // Its nonce and its proof over the stranger's nonce, which proves nothing to anyone else: no hello, no result.
    expect(heard.map((line) => Object.keys(JSON.parse(line)))).toEqual([["nonce"], ["proof"]]);
    expect(heard.join("\n")).not.toContain(token);
  });

  it("fails every call still waiting when the worker goes away", async () => {
    const pipe = path.join(dir, "gone.sock");
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(pipe, r));
    const socket = net.connect(pipe);
    socket.on("error", () => {});
    const client = clientOf(channelOf(socket, randomBytes(32), "app"));
    await expect(client.apply({ op: "installed" })).rejects.toThrow(/stopped/);
    server.close();
  });

  it("lets a process relaying both handshakes add no operation of its own", async () => {
    const pipe = path.join(dir, "app.sock");
    const relayPipe = path.join(dir, "relay.sock");
    const carried: unknown[] = [];
    let toWorker!: net.Socket;
    let workerClosed!: Promise<unknown>;
    const relay = net.createServer((down) => {
      toWorker = down;
      const up = net.connect(pipe);
      down.on("data", (chunk) => up.write(chunk));
      up.on("data", (chunk) => down.write(chunk));
      down.on("close", () => up.destroy());
    });
    await new Promise<void>((r) => relay.listen(relayPipe, r));
    const client = await startWorker({
      imageDir: dir,
      pipe,
      command: (p, token) => ({ file: p, args: [token] }),
      launch: async ({ args: [token] }) => {
        // The worker reaches the relay's instance of the pipe, which passes everything on to the app.
        const socket = net.connect(relayPipe);
        workerClosed = new Promise((r) => socket.once("close", r));
        socket.on("connect", async () => {
          const c = await handshake(socket, token!, "worker");
          c.send({ ok: true });
          c.listen((msg) => carried.push(msg));
        });
      },
    });
    // Both proofs went through the relay, and the app heard the worker's hello. Now the relay's own operations:
    const body = JSON.stringify({ id: 1, op: { op: "restart" } });
    toWorker.write(`${JSON.stringify({ id: 1, op: { op: "restart" } })}\n`);
    toWorker.write(`${JSON.stringify({ seq: 1, body, mac: "00".repeat(32) })}\n`);
    await workerClosed;
    expect(carried).toEqual([]);
    await expect(client.apply({ op: "installed" })).rejects.toThrow(/stopped/);
    relay.close();
  });

  it("refuses a replayed, reordered, reflected or forged message", () => {
    /** A socket in memory: what is written to it, and a way to hand it data. */
    const fake = () => {
      const s = {
        lines: [] as string[],
        destroyed: false,
        data: (_chunk: string) => {},
        on: (event: string, fn: (chunk: string) => void) => {
          if (event === "data") s.data = fn;
          return s;
        },
        off: () => s,
        write: (line: string) => void s.lines.push(line),
        destroy: () => void (s.destroyed = true),
      };
      return s;
    };
    const key = randomBytes(32);
    const app = fake();
    const sender = channelOf(app as never, key, "app");
    for (const id of [1, 2]) sender.send({ id, op: { op: "restart" } });
    const receiver = (side: "app" | "worker" = "worker", k = key) => {
      const socket = fake();
      const got: unknown[] = [];
      channelOf(socket as never, k, side).listen((msg) => got.push(msg));
      return { socket, got };
    };

    const inOrder = receiver();
    inOrder.socket.data(app.lines.join(""));
    expect(inOrder.got).toEqual([
      { id: 1, op: { op: "restart" } },
      { id: 2, op: { op: "restart" } },
    ]);
    expect(inOrder.socket.destroyed).toBe(false);

    const replayed = receiver();
    replayed.socket.data(app.lines[0]!);
    replayed.socket.data(app.lines[0]!);
    expect(replayed.got).toHaveLength(1);
    expect(replayed.socket.destroyed).toBe(true);

    const reordered = receiver();
    reordered.socket.data(app.lines[1]! + app.lines[0]!);
    expect(reordered.got).toEqual([]);
    expect(reordered.socket.destroyed).toBe(true);

    // The app's own message sent back to it, as if from the worker.
    const reflected = receiver("app");
    reflected.socket.data(app.lines[0]!);
    expect(reflected.got).toEqual([]);
    expect(reflected.socket.destroyed).toBe(true);

    const forged = receiver("worker", randomBytes(32));
    forged.socket.data(app.lines[0]!);
    expect(forged.got).toEqual([]);
    expect(forged.socket.destroyed).toBe(true);
  });
});
