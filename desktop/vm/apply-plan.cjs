// The VM test's stand-in for Windows: it carries out the host app's rental-mode
// plans (rental.cjs) on a disk image instead of a PC. The disk steps run the
// app's own code (gpt.cjs for the partition table, the plan's offsets for the
// writes); the Windows-only steps have Linux stand-ins:
//
//   shrink            ntfsresize, then ntfsfix -d (Resize-Partition leaves the volume clean)
//   label             ntfslabel
//   write             the image set's file (image-set.cjs), at the plan's offset
//   boot-entry, boot-first, boot-next, mok-import
//                     the VM's firmware variables, through boot-vars.py
//   check, image-check, fast-startup-off, installed, restart
//                     nothing: they need Windows, or the next boot is the restart
//
// The real installer, on real Windows, is vm/windows-install-test.sh's.
//
//   node apply-plan.cjs windows <disk.raw> <bytes>      lay out a disk like a Windows PC's
//   node apply-plan.cjs facts <disk.raw>                print what the app's preflight would read
//   node apply-plan.cjs install <disk.raw> <image-set> <facts.json> <vars.fd>
//   node apply-plan.cjs switch <start|stop> <vars.fd>
//   node apply-plan.cjs mok <vars.fd> <cert.der> <code>   only the install's MOK request, with this code
//
// The install's one-time code is $SWIFF_MOK_CODE when set. <cert.der> stands in
// for Swiff's certificate (MOK_CERT) that the install enrols.
//
// NTFS tools run through sudo on a loop device over the partition; $NTFS_BIN
// names their directory, $LD_LIBRARY_PATH reaches them, $BOOT_VARS is the
// command that edits the firmware variables.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { emptyGpt, gptWrites, readGpt, withPartitions, withResized } = require("../gpt.cjs");
const { fileOf, readImageSet, sourceOf, trustOf } = require("../image-set.cjs");
const { MOK_CERT, TYPE, installPlan, mokRequest, mokSteps, rentalOf, switchPlan } = require("../rental.cjs");

const MiB = 1024 * 1024;
const MSR = "e3c9e316-0b5c-4db8-817d-f92df00215ae";
const RECOVERY = "de94bba4-06d1-4d40-a16a-bfd50179d6ac";
const BLOCK = 4 * MiB;
const ZERO = Buffer.alloc(BLOCK);

const ntfs = (tool) => path.join(process.env.NTFS_BIN ?? "/usr/sbin", tool);
const bootVars = (args) =>
  execFileSync(process.env.BOOT_VARS ?? "boot-vars.py", args, { stdio: ["ignore", "inherit", "inherit"] });

/** A disk image file as gpt.cjs reads and writes disks. */
function openDisk(file) {
  const fd = fs.openSync(file, "r+");
  const bytes = fs.fstatSync(fd).size;
  return {
    bytes,
    read(offset, length) {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, offset);
      return buf;
    },
    write(writes) {
      for (const w of writes) fs.writeSync(fd, w.bytes, 0, w.bytes.length, w.offset);
    },
    close: () => fs.closeSync(fd),
  };
}

/**
 * Run NTFS tools through sudo on a loop device over `bytes` bytes at `offset`
 * of `file`: `run(tool, before, after)` puts the device between the two.
 */
function onLoop(file, offset, bytes, run) {
  const loop = execFileSync("sudo", [
    "-n",
    "losetup",
    "-f",
    "--show",
    "-o",
    String(offset),
    "--sizelimit",
    String(bytes),
    file,
  ])
    .toString()
    .trim();
  try {
    return run((tool, before, after = []) =>
      execFileSync(
        "sudo",
        [
          "-n",
          "env",
          `LD_LIBRARY_PATH=${process.env.LD_LIBRARY_PATH ?? ""}`,
          ntfs(tool),
          ...before,
          loop,
          ...after,
        ],
        {
          input: "y\n",
          stdio: ["pipe", "pipe", "inherit"],
        },
      ).toString(),
    );
  } finally {
    execFileSync("sudo", ["-n", "losetup", "-d", loop]);
  }
}

// --- a disk laid out like a Windows PC's -----------------------------------------------

/**
 * The layout Windows Setup leaves: a 300 MiB ESP, the 16 MiB reserved
 * partition, C:, and a 1 GiB recovery partition at the end, as on the PC
 * this test was modelled on. Prints the partitions as JSON.
 */
function windows(file, bytes) {
  fs.writeFileSync(file, "");
  fs.truncateSync(file, bytes);
  const disk = openDisk(file);
  const s = (b) => b / 512;
  const recovery = bytes - MiB - 1024 * MiB;
  const gpt = withPartitions(emptyGpt({ diskBytes: bytes, diskId: "5a1d0c3e-7b2f-4e1a-9c8d-3f6e2b1a0d9c" }), [
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
      last: s(recovery) - 1,
    },
    {
      type: RECOVERY,
      id: "418fadc3-6e50-4293-9d4f-30c1526e7d84",
      name: "",
      first: s(recovery),
      last: s(bytes - MiB) - 1,
      attrs: 0x8000000000000001n,
    },
  ]);
  disk.write(gptWrites(gpt, { mbr: true }));
  disk.close();
  console.log(
    JSON.stringify(
      gpt.entries.map((e) => ({
        index: e.index,
        offset: e.first * 512,
        bytes: (e.last - e.first + 1) * 512,
      })),
    ),
  );
}

// --- what the app's preflight would read on it ------------------------------------------

/**
 * The raw facts rental.cjs's PowerShell script would print on a PC with this
 * disk: UEFI, Secure Boot on, a TPM 2.0 and an IOMMU (as the VM has), Fast
 * Startup on, C: its third partition with the Steam library.
 */
function facts(file) {
  const disk = openDisk(file);
  const gpt = readGpt(disk.read, { diskBytes: disk.bytes });
  disk.close();
  const c = gpt.entries.find((e) => e.type === TYPE.windowsData);
  const cBytes = (c.last - c.first + 1) * 512;
  const label = onLoop(file, c.first * 512, cBytes, (run) => run("ntfslabel", [])).trim();
  console.log(
    JSON.stringify({
      firmware: "UEFI",
      secureBoot: 1,
      tpm2: true,
      tpmInfo: "-TPM Manufacturer ID: IBM",
      securityProperties: [1, 2, 3],
      fastStartup: 1,
      gpus: [{ name: "QEMU virtio GPU", pnp: "PCI\\VEN_1AF4&DEV_1050" }],
      disks: [{ number: 0, style: "GPT", size: disk.bytes, sector: 512, bus: "SATA", system: true }],
      partitions: gpt.entries.map((e) => ({
        disk: 0,
        number: e.index + 1,
        letter: e === c ? "C" : "\u0000",
        type: `{${e.type}}`,
        offset: e.first * 512,
        size: (e.last - e.first + 1) * 512,
      })),
      // A fresh NTFS: nearly all of it free.
      volumes: [
        { letter: "C", fs: "NTFS", label, size: cBytes, free: cBytes - 256 * MiB, fixed: true, bitlocker: 2 },
      ],
      bootEntry: null,
    }),
  );
}

// --- carrying out a plan -----------------------------------------------------------------

/** Copy `bytes` bytes of `source` to `offset` of the disk, skipping all-zero blocks (the disk is sparse). */
function writeImage(disk, source, offset, bytes) {
  const fd = fs.openSync(source, "r");
  const size = fs.fstatSync(fd).size;
  if (size !== bytes) throw new Error(`${source} is ${size} bytes, the partition ${bytes}`);
  const buf = Buffer.alloc(BLOCK);
  for (let at = 0; at < bytes; at += BLOCK) {
    const n = fs.readSync(fd, buf, 0, Math.min(BLOCK, bytes - at), at);
    const chunk = buf.subarray(0, n);
    if (!chunk.equals(ZERO.subarray(0, n))) disk.write([{ offset: offset + at, bytes: chunk }]);
  }
  fs.closeSync(fd);
}

function apply(op, ctx) {
  const say = (line) => console.log(`  ${op.op}: ${line}`);
  switch (op.op) {
    case "check":
    case "image-check":
    case "fast-startup-off":
    case "installed":
    case "restart":
      return say("Windows only, nothing to do in the VM");
    case "shrink": {
      const disk = openDisk(ctx.file);
      const gpt = readGpt(disk.read, { diskBytes: disk.bytes });
      const part = gpt.entries.find((e) => e.index + 1 === op.partition);
      onLoop(ctx.file, part.first * 512, (part.last - part.first + 1) * 512, (run) => {
        run("ntfsresize", ["-f", "-s", String(op.size)]);
        run("ntfsfix", ["-d"]);
      });
      disk.write(gptWrites(withResized(gpt, part.index, part.first + op.size / 512 - 1)));
      disk.close();
      return say(`partition ${op.partition} is now ${op.size} bytes`);
    }
    case "gpt-add": {
      const disk = openDisk(ctx.file);
      const gpt = readGpt(disk.read, { diskBytes: disk.bytes });
      const next = withPartitions(
        gpt,
        op.partitions.map((p) => ({
          type: p.type,
          id: p.id,
          name: p.name,
          attrs: BigInt(p.attrs),
          first: p.offset / 512,
          last: (p.offset + p.bytes) / 512 - 1,
        })),
      );
      disk.write(gptWrites(next));
      disk.close();
      return say(`${op.partitions.length} partitions added`);
    }
    case "write": {
      const disk = openDisk(ctx.file);
      const source = sourceOf(ctx.set, op.source).path;
      writeImage(disk, source, op.offset, op.bytes);
      disk.close();
      return say(`${path.basename(source)} at ${op.offset}`);
    }
    case "boot-entry": {
      const disk = openDisk(ctx.file);
      const gpt = readGpt(disk.read, { diskBytes: disk.bytes });
      disk.close();
      const esp = gpt.entries.find((e) => e.first * 512 === op.offset);
      bootVars([
        "entry",
        ctx.vars,
        op.title,
        String(esp.index + 1),
        String(esp.first),
        String(esp.last - esp.first + 1),
        esp.id,
        op.path,
      ]);
      return say(`"${op.title}" on partition ${esp.index + 1}, ${op.path}, last in the boot order`);
    }
    case "label": {
      // C: is the Windows data partition in this VM.
      const disk = openDisk(ctx.file);
      const c = readGpt(disk.read, { diskBytes: disk.bytes }).entries.find(
        (e) => e.type === TYPE.windowsData,
      );
      disk.close();
      onLoop(ctx.file, c.first * 512, (c.last - c.first + 1) * 512, (run) =>
        run("ntfslabel", [], [op.label]),
      );
      return say(`${op.letter}: is ${op.label}`);
    }
    case "boot-first":
      bootVars(["first", ctx.vars, op.entry === "swiff" ? "Swiff OS" : "Windows Boot Manager"]);
      return say(op.entry);
    case "boot-next":
      bootVars(["next", ctx.vars, "Swiff OS"]);
      return say(op.entry);
    case "mok-import": {
      const request = mokRequest(fs.readFileSync(ctx.cert ?? fileOf(ctx.set, MOK_CERT).path), op.code);
      const files = ["MokNew", "MokAuth", "MokTimeout"].map((name) => {
        const file = path.join(path.dirname(ctx.vars), `${name}.bin`);
        fs.writeFileSync(file, request[name]);
        return file;
      });
      bootVars(["mok", ctx.vars, ...files]);
      return say(`MokNew ${request.MokNew.length} bytes, MokAuth, MokTimeout -1`);
    }
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}

function run(plan, ctx) {
  for (const step of plan.steps) {
    console.log(`- ${step.title}`);
    for (const op of step.ops) apply(op, ctx);
  }
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "windows") windows(args[0], Number(args[1]));
else if (cmd === "facts") facts(args[0]);
else if (cmd === "install") {
  const [file, dir, factsFile, vars] = args;
  const set = readImageSet(dir, { trust: trustOf({ dev: true }) });
  const rental = rentalOf(JSON.parse(fs.readFileSync(factsFile, "utf8")), [{ letter: "C", games: 1 }]);
  const plan = installPlan(rental, {
    layout: set.layout,
    ...(process.env.SWIFF_MOK_CODE ? { code: process.env.SWIFF_MOK_CODE } : {}),
  });
  run(plan, { file, set, vars });
} else if (cmd === "switch") {
  run(switchPlan(args[0]), { vars: args[1] });
} else if (cmd === "mok") {
  const [vars, cert, code] = args;
  // The request alone: this VM boots its ESP as the firmware's own disk entry, with no Swiff OS entry for BootNext.
  const [mok] = mokSteps(code);
  run({ steps: [{ ...mok, ops: mok.ops.filter((op) => op.op === "mok-import") }] }, { vars, cert });
} else {
  console.error("usage: apply-plan.cjs windows|facts|install|switch|mok ...");
  process.exit(2);
}
