// The rental-mode installer's elevated side: the one process Swiff Host runs
// as administrator (one UAC prompt), which carries out a plan's operations
// (rental.cjs) on this PC. It takes them one at a time from the app over a
// named pipe the app opened, and does each itself:
//
//   commands       check, BitLocker, Fast Startup, shrink and grow, labels,
//                  restart: exactly the PowerShell lines rental.cjs shellOf
//                  shows the owner
//   partitions     gpt.cjs on disk N (\\.\GLOBALROOT\Device\HarddiskN\Partition0):
//                  Swiff OS's partitions added
//                  with the image's ids and names, and removed again
//   the image      the image set, signed by a key the app trusts (image-set.cjs),
//                  kept in %ProgramData%\Swiff\swiff-os (writable by
//                  administrators only); each split file copied there and checked
//                  as it is copied at its write, written from there into its own
//                  partition, hashed as it goes and read back, against the image
//                  set's SHA-256, and its copy removed
//   firmware       Boot####, BootOrder, BootNext and shim's MOK requests
//                  (efi.cjs), through SetFirmwareEnvironmentVariableEx
//
// It trusts nothing it is sent: an operation runs only if it matches the image
// set and what the install recorded so far. Partitions it adds must be the
// image's, its writes go only into partitions it added, and what it removes
// must be what it added. That record, %ProgramData%\Swiff\rental-install.json
// (writable by administrators only), is what the uninstall and a recovery
// after a failed step work from.
//
//   rental-worker.cjs <pipe> <token> <image-dir>     (also: Swiff Host --swiff-rental-worker ...)

const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const efi = require("./efi.cjs");
const { gptWrites, readGpt, withPartitions, withRemoved, withRetyped } = require("./gpt.cjs");
const {
  BLOCK,
  MANIFEST,
  SIGNATURE,
  copyChecked,
  fileOf,
  hashOf,
  imageSetOf,
  readSigned,
  sourceOf,
  trustOf,
} = require("./image-set.cjs");
const { BOOT_PATH, BOOT_TITLE, GAMES_LABEL, MOK_CERT, TYPE, shellOf } = require("./rental.cjs");
const { handshake } = require("./rental-exec.cjs");

/** The partition types Swiff OS's partitions have: the only ones this worker adds or removes. */
const SWIFF_TYPES = new Set([TYPE.esp, TYPE.root, TYPE.verity, TYPE.linux]);

/**
 * Swiff OS's boot partition's type until it is written: Linux data, which
 * Windows leaves alone. Typed ESP, Windows mounts the FAT the moment its boot
 * sector is written and refuses the rest of the write; the boot entry step
 * gives it the ESP type.
 */
const STAGING = TYPE.linux;

/** What Windows Boot Manager's entry starts, wherever Windows' own ESP is. */
const WINDOWS_PATH = String.raw`\EFI\Microsoft\Boot\bootmgfw.efi`;

const isInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isLetter = (v) => typeof v === "string" && /^[A-Z]$/.test(v);
const isGuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v);

/** Throws `message` unless `ok`. */
function must(ok, message) {
  if (!ok) throw new Error(message);
}

// --- Windows ------------------------------------------------------------------------

/**
 * Runs PowerShell lines as this (elevated) process; resolves with what they
 * print, rejects with the error's message. Windows' command line holds 32,767
 * characters: a longer script runs from a file in `dir`, which only
 * administrators may write (the install's record folder).
 */
function powershell(lines, { timeout = 30 * 60_000, dir = null } = {}) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "try {",
    ...lines,
    "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const file =
    encoded.length > 30_000 && dir
      ? path.join(dir, `run-${crypto.randomBytes(8).toString("hex")}.ps1`)
      : null;
  // UTF-8 with a byte order mark, which Windows PowerShell reads as UTF-8.
  if (file) fs.writeFileSync(file, `\ufeff${script}`, "utf8");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        ...(file ? ["-File", file] : ["-EncodedCommand", encoded]),
      ],
      { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (file) fs.rmSync(file, { force: true });
        if (error) reject(new Error(String(stderr).trim().split(/\r?\n/)[0] || error.message));
        else resolve(String(stdout));
      },
    );
  });
}

/** Firmware variables through the Win32 API, with SeSystemEnvironmentPrivilege enabled (C#, compiled by PowerShell). */
const FIRMWARE = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SwiffFirmware {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern uint GetFirmwareEnvironmentVariableExW(string name, string guid, byte[] buffer, uint size, out uint attributes);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool SetFirmwareEnvironmentVariableExW(string name, string guid, byte[] buffer, uint size, uint attributes);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool LookupPrivilegeValueW(string system, string name, out long luid);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref Privilege state, uint length, IntPtr previous, IntPtr returned);
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  struct Privilege { public uint Count; public long Luid; public uint Attributes; }
  public static void Enable() {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) throw new Win32Exception();
    var p = new Privilege { Count = 1, Attributes = 2 };
    if (!LookupPrivilegeValueW(null, "SeSystemEnvironmentPrivilege", out p.Luid)) throw new Win32Exception();
    if (!AdjustTokenPrivileges(token, false, ref p, 0, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
    int e = Marshal.GetLastWin32Error();
    if (e != 0) throw new Win32Exception(e);
  }
  public static byte[] Get(string name, string guid) {
    var buffer = new byte[65536];
    uint attributes;
    uint n = GetFirmwareEnvironmentVariableExW(name, guid, buffer, (uint)buffer.Length, out attributes);
    if (n == 0) {
      int e = Marshal.GetLastWin32Error();
      if (e == 203) return null;
      throw new Win32Exception(e, "Reading " + name + ": " + new Win32Exception(e).Message);
    }
    var data = new byte[n];
    Array.Copy(buffer, data, n);
    return data;
  }
  public static void Set(string name, string guid, byte[] data, uint attributes) {
    uint size = data == null ? 0 : (uint)data.Length;
    if (SetFirmwareEnvironmentVariableExW(name, guid, data, size, attributes)) return;
    int e = Marshal.GetLastWin32Error();
    if (size == 0 && e == 203) return;
    throw new Win32Exception(e, "Writing " + name + ": " + new Win32Exception(e).Message);
  }
}
'@
[SwiffFirmware]::Enable()
`;

/**
 * Reads and writes firmware variables in one PowerShell run: `requests` are
 * `{ get: name, guid }` or `{ set: name, guid, data: Buffer | null }` (null
 * deletes), done in order. Resolves with each get's bytes (null when absent),
 * by name.
 */
async function firmware(requests, dir = null) {
  const json = JSON.stringify(
    requests.map((r) => ({
      name: r.get ?? r.set,
      guid: `{${r.guid}}`,
      set: Boolean(r.set),
      data: r.data ? Buffer.from(r.data).toString("base64") : null,
    })),
  );
  const out = await powershell(
    [
      FIRMWARE,
      `$requests = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(json).toString("base64")}')) | ConvertFrom-Json`,
      "$out = @{}",
      "foreach ($r in $requests) {",
      "  if ($r.set) { $bytes = if ($r.data) { [Convert]::FromBase64String($r.data) } else { $null }; [SwiffFirmware]::Set($r.name, $r.guid, $bytes, 7) }",
      "  else { $v = [SwiffFirmware]::Get($r.name, $r.guid); $out[$r.name] = if ($v) { [Convert]::ToBase64String($v) } else { $null } }",
      "}",
      "ConvertTo-Json -InputObject $out -Compress",
    ],
    { dir },
  );
  const got = JSON.parse(out.trim() || "{}");
  return Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v ? Buffer.from(v, "base64") : null]));
}

/**
 * The whole of disk `number`, by the name Windows' object manager gives it.
 * Not \\.\PhysicalDriveN: the Node in Electron 33 (20.18) takes that for a
 * network share's root and opens \\.\PhysicalDriveN\ instead, which fails as
 * EIO; the Node of a Windows console (22+) leaves it alone, so only the app
 * met it.
 */
const diskPath = (number) => `\\\\.\\GLOBALROOT\\Device\\Harddisk${number}\\Partition0`;

/** A physical disk, opened for raw reads and writes: sector-aligned, as Windows requires. */
async function openDisk(number) {
  const info = JSON.parse(
    await powershell([
      `$d = Get-Disk -Number ${number}`,
      "[pscustomobject]@{ size = $d.Size; sector = $d.LogicalSectorSize } | ConvertTo-Json -Compress",
    ]),
  );
  const fd = fs.openSync(diskPath(number), "r+");
  return diskOf(fd, info.size, info.sector);
}

/** A disk over an open file descriptor: what gpt.cjs reads and the image is written through. */
function diskOf(fd, bytes, sector, files = fs) {
  const aligned = (offset, length) =>
    must(offset % sector === 0 && length % sector === 0, "A disk access is not sector-aligned.");
  return {
    bytes,
    sector,
    read(offset, length) {
      aligned(offset, length);
      const buf = Buffer.alloc(length);
      const n = files.readSync(fd, buf, 0, length, offset);
      must(n === length, "A disk read came back short.");
      return buf;
    },
    write(writes) {
      for (const w of writes) {
        aligned(w.offset, w.bytes.length);
        const n = files.writeSync(fd, w.bytes, 0, w.bytes.length, w.offset);
        must(n === w.bytes.length, "A disk write came back short.");
      }
    },
    close: () => files.closeSync(fd),
  };
}

const STATE_DIR = path.join(process.env.ProgramData ?? "C:\\ProgramData", "Swiff");

const WINDOWS = {
  powershell: (lines) => powershell(lines, { dir: STATE_DIR }),
  firmware: (requests) => firmware(requests, STATE_DIR),
  openDisk,
  stateDir: STATE_DIR,
};

// --- what the install recorded ----------------------------------------------------------

const EMPTY = () => ({
  version: 2,
  complete: false,
  disk: null,
  bitlocker: null,
  fastStartup: false,
  shrink: null,
  partitions: [],
  bootEntry: null,
  windowsEntry: null,
  labels: [],
  mok: false,
});

/**
 * The install's record in `dir`. Only administrators may write the folder:
 * its permissions are set again on every start, so a folder someone else made
 * first cannot feed this worker a record of their own.
 */
async function openState(win, files = fs) {
  const dir = win.stateDir;
  const file = path.join(dir, "rental-install.json");
  files.mkdirSync(dir, { recursive: true });
  await win.powershell([
    // The folder: SYSTEM and Administrators full control, Users read, nothing inherited from
    // ProgramData. What is in it: owned by Administrators and inheriting just that (icacls /T
    // would put the folder's inheritance flags on the files, which leaves them an empty ACL).
    `& icacls ${JSON.stringify(dir)} /setowner '*S-1-5-32-544' /Q | Out-Null`,
    "if ($LASTEXITCODE) { throw 'Could not take ownership of the install record folder.' }",
    `& icacls ${JSON.stringify(dir)} /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /Q | Out-Null`,
    "if ($LASTEXITCODE) { throw 'Could not set the permissions of the install record.' }",
    `if (Test-Path ${JSON.stringify(path.join(dir, "*"))}) {`,
    `  & icacls ${JSON.stringify(path.join(dir, "*"))} /setowner '*S-1-5-32-544' /Q | Out-Null`,
    `  & icacls ${JSON.stringify(path.join(dir, "*"))} /reset /Q | Out-Null`,
    "  if ($LASTEXITCODE) { throw 'Could not set the permissions of the install record.' }",
    "}",
  ]);
  let state = EMPTY();
  // No record yet is a fresh start; a record that cannot be read stops everything.
  if (files.existsSync(file)) {
    try {
      state = { ...EMPTY(), ...JSON.parse(files.readFileSync(file, "utf8")) };
    } catch (error) {
      throw new Error(`The install record ${file} cannot be read: ${error.message}`);
    }
  }
  return {
    get: () => state,
    exists: () => files.existsSync(file),
    save(change) {
      state = { ...state, ...change };
      const tmp = `${file}.tmp`;
      files.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
      files.renameSync(tmp, file);
    },
    forget() {
      files.rmSync(file, { force: true });
      state = EMPTY();
    },
  };
}

// --- the operations -----------------------------------------------------------------

/** The shape each operation must have before anything runs: what an operation may carry, checked. */
function checkOp(op) {
  must(op && typeof op === "object" && typeof op.op === "string", "Not an operation.");
  switch (op.op) {
    case "check":
      if (op.shrink)
        must(
          isInt(op.shrink.disk) &&
            isInt(op.shrink.partition) &&
            isInt(op.shrink.size) &&
            isLetter(op.shrink.letter),
          "A bad check.",
        );
      return;
    case "bitlocker-suspend":
      return must(
        isLetter(op.letter) && Number.isInteger(op.restarts) && op.restarts >= 1 && op.restarts <= 15,
        "A bad BitLocker step.",
      );
    case "bitlocker-resume":
      return must(isLetter(op.letter), "A bad BitLocker step.");
    case "shrink":
    case "grow":
      return must(
        isInt(op.disk) && isInt(op.partition) && isInt(op.size) && isLetter(op.letter),
        "A bad resize.",
      );
    case "gpt-add":
    case "gpt-remove":
      return must(
        isInt(op.disk) && Array.isArray(op.partitions) && op.partitions.length > 0,
        "A bad partition step.",
      );
    case "write":
      return must(
        isInt(op.disk) && isInt(op.offset) && isInt(op.bytes) && typeof op.source === "string",
        "A bad write.",
      );
    case "boot-entry":
      return must(
        isInt(op.disk) && isInt(op.offset) && op.path === BOOT_PATH && op.title === BOOT_TITLE,
        "A bad boot entry.",
      );
    case "boot-first":
      return must(op.entry === "swiff" || op.entry === "windows", "A bad boot order.");
    case "boot-next":
      return must(op.entry === "swiff", "A bad BootNext.");
    case "label":
      return must(
        isLetter(op.letter) && typeof op.label === "string" && op.label.length <= 32,
        "A bad label.",
      );
    case "mok-import":
    case "mok-delete":
      return must(
        op.cert === MOK_CERT && typeof op.code === "string" && /^\d{8}$/.test(op.code),
        "A bad MOK request.",
      );
    case "image-check":
    case "fast-startup-off":
    case "fast-startup-on":
    case "boot-entry-remove":
    case "mok-cancel":
    case "installed":
    case "forget":
    case "restart":
      return;
    default:
      throw new Error(`Not an operation this installer knows: ${op.op}.`);
  }
}

/**
 * The worker: `apply(op, progress)` carries out one operation and resolves
 * with what it reports (warnings, the boot entry it made). `win` is Windows
 * (WINDOWS), or a stand-in in tests.
 */
async function createWorker({ imageDir, trust = trustOf({ dev: false }), win = WINDOWS, files = fs }) {
  const state = await openState(win, files);
  const run = (op) => win.powershell(shellOf(op));

  // The image set as this worker uses it: in the record's folder, so only administrators can change
  // it, and only what was checked there. Emptied on every start: nothing in it is from before.
  const home = path.join(win.stateDir, "swiff-os");
  files.rmSync(home, { recursive: true, force: true });
  files.mkdirSync(home);
  let set = null;
  /** The image set in `imageDir`, read once, signed by a key in `trust`, and kept in `home`. */
  const imageSet = () => {
    if (set) return set;
    const { manifest, signature } = readSigned(imageDir, files);
    const checked = imageSetOf(manifest, signature, trust);
    files.writeFileSync(path.join(home, MANIFEST), manifest);
    files.writeFileSync(path.join(home, SIGNATURE), signature);
    return (set = { ...checked, dir: home });
  };
  /** Swiff's certificate, read once: these very bytes are checked, kept in `home`, and used. */
  function certificate() {
    const file = fileOf(imageSet(), MOK_CERT);
    let cert;
    try {
      cert = files.readFileSync(path.join(imageDir, MOK_CERT));
    } catch {
      throw new Error(`${MOK_CERT} of the image set is not on this PC.`);
    }
    must(
      cert.length === file.bytes && crypto.createHash("sha256").update(cert).digest("hex") === file.sha256,
      `${MOK_CERT} is not the file its image set lists.`,
    );
    files.writeFileSync(file.path, cert);
    return cert;
  }

  /** The disk's GPT, read fresh. */
  const withDisk = async (number, use) => {
    const disk = await win.openDisk(number);
    try {
      return await use(disk, readGpt(disk.read, { diskBytes: disk.bytes, sectorSize: disk.sector }));
    } finally {
      disk.close();
    }
  };

  /**
   * Whether a Boot#### variable's bytes start `loader`: the same file on the
   * same partition (by its GPT id), or by file alone when the loader's
   * partition was not recorded.
   */
  const starts = (bytes, loader) => {
    const option = bytes && efi.parseLoadOption(bytes);
    return Boolean(
      option &&
      efi.samePath(option.file, loader.path) &&
      (loader.partition === null || option.partition === loader.partition),
    );
  };

  /** Every Boot#### the firmware has now, by number: 0000 to 00FF, and whatever BootOrder names beyond them. */
  const bootEntries = async () => {
    const order = efi.orderOf((await win.firmware([{ get: "BootOrder", guid: efi.GLOBAL }])).BootOrder);
    const numbers = [...new Set([...Array.from({ length: 256 }, (_, i) => i), ...order])];
    const got = await win.firmware(numbers.map((n) => ({ get: efi.bootName(n), guid: efi.GLOBAL })));
    return { order, numbers: numbers.filter((n) => got[efi.bootName(n)]), got };
  };

  /**
   * The number the firmware gives `loader` now, found by what it starts, never
   * by a number kept from before: firmware renumbers entries (the GEEKOM moved
   * Swiff OS's, and its BootOrder then listed only Windows). Prefers one in
   * BootOrder. Null when no entry starts it.
   */
  const numberOf = async (loader) => {
    const { order, numbers, got } = await bootEntries();
    const hits = numbers.filter((n) => starts(got[efi.bootName(n)], loader));
    return hits.find((n) => order.includes(n)) ?? hits[0] ?? null;
  };

  /** Swiff OS's loader: shim, on Swiff OS's own boot partition. */
  const swiffLoader = () => {
    const esp = state.get().partitions.find((p) => p.role === "esp");
    must(esp, "Swiff OS has no boot partition.");
    return { partition: esp.id, path: BOOT_PATH };
  };

  /** Swiff OS's boot entry's number now; null when the firmware has none (it dropped it, or it was removed). */
  const findEntry = () => numberOf(swiffLoader());

  /**
   * Add Swiff OS's boot entry at the first free number, last in BootOrder, for
   * its boot partition on `disk` (typed ESP by now): the install's own step,
   * and how an entry the firmware dropped comes back.
   */
  const addEntry = async (disk) => {
    const esp = state.get().partitions.find((p) => p.role === "esp");
    must(esp, "Swiff OS has no boot partition.");
    const partition = await withDisk(disk, async (_disk, gpt) => {
      const e = gpt.entries.find((x) => x.id === esp.id);
      must(e && e.type === TYPE.esp, "Swiff OS's boot partition is not on the disk.");
      return { number: e.index + 1, first: e.first, sectors: e.last - e.first + 1, id: e.id };
    });
    const names = Array.from({ length: 256 }, (_, i) => efi.bootName(i));
    const got = await win.firmware([
      { get: "BootOrder", guid: efi.GLOBAL },
      { get: "BootCurrent", guid: efi.GLOBAL },
      ...names.map((name) => ({ get: name, guid: efi.GLOBAL })),
    ]);
    const free = names.findIndex((name) => !got[name]);
    must(free >= 0, "The firmware has no free boot entry number.");
    const order = efi.orderOf(got.BootOrder);
    const current = got.BootCurrent ? efi.orderOf(got.BootCurrent)[0] : null;
    await win.firmware([
      {
        set: efi.bootName(free),
        guid: efi.GLOBAL,
        data: efi.loadOption({ title: BOOT_TITLE, partition, path: BOOT_PATH }),
      },
      { set: "BootOrder", guid: efi.GLOBAL, data: efi.orderBytes(efi.placeIn(order, free, "last")) },
    ]);
    // Windows' entry is the one this boot came from, recorded once by what it starts: a later add keeps the first.
    const windows =
      current === null ? null : efi.parseLoadOption(got[efi.bootName(current)] ?? Buffer.alloc(0));
    state.save({
      bootEntry: swiffLoader(),
      windowsEntry:
        state.get().windowsEntry ??
        (windows?.file ? { partition: windows.partition, path: windows.file } : null),
    });
    return free;
  };

  /** Swiff OS's boot entry, wherever the firmware has it now, or added again when it is gone. */
  const ourEntry = async () => {
    const { disk } = state.get();
    must(disk !== null && state.get().bootEntry !== null, "Swiff OS has no boot entry.");
    return (await findEntry()) ?? (await addEntry(disk));
  };

  /** Windows Boot Manager's entry's number now, by what it starts. */
  const windowsEntry = async () => {
    const loader = state.get().windowsEntry ?? { partition: null, path: WINDOWS_PATH };
    const found = await numberOf(loader);
    must(found !== null, "The firmware has no Windows Boot Manager entry.");
    return found;
  };

  /**
   * A record from before entries were kept by what they start (version 1 kept
   * Boot#### numbers, which firmware changes): each number becomes the loader
   * its entry starts, read once. Swiff OS's is shim on its boot partition,
   * whatever the number points at now.
   */
  if (typeof state.get().bootEntry === "number" || typeof state.get().windowsEntry === "number") {
    const { bootEntry, windowsEntry: windowsNumber, partitions } = state.get();
    const esp = partitions.find((p) => p.role === "esp");
    let windows = null;
    if (typeof windowsNumber === "number") {
      const name = efi.bootName(windowsNumber);
      const option = efi.parseLoadOption(
        (await win.firmware([{ get: name, guid: efi.GLOBAL }]))[name] ?? Buffer.alloc(0),
      );
      // An entry that no longer starts Windows Boot Manager is not taken for it.
      if (option?.file && efi.samePath(option.file, WINDOWS_PATH))
        windows = { partition: option.partition, path: option.file };
    }
    state.save({
      version: 2,
      bootEntry: typeof bootEntry === "number" && esp ? { partition: esp.id, path: BOOT_PATH } : null,
      windowsEntry: windows ?? (typeof windowsNumber === "number" ? null : state.get().windowsEntry),
    });
  }

  async function apply(op, progress = () => {}) {
    checkOp(op);
    const s = state.get();
    switch (op.op) {
      case "check": {
        const out = await run(op);
        const warnings = out
          .split(/\r?\n/)
          .filter((l) => l.startsWith("warning: "))
          .map((l) => l.slice(9));
        // Kept for the app, which reads it without administrator rights, beside the install's record but
        // not in it: a check changes nothing on the PC, so it must not read as an install begun.
        files.writeFileSync(
          path.join(win.stateDir, "rental-check.json"),
          `${JSON.stringify({ at: Date.now(), ek: !warnings.some((w) => /endorsement key/i.test(w)) })}\n`,
        );
        return { warnings };
      }
      case "image-check": {
        // Signed, its certificate Swiff's, and each image the one listed, checked where it is before
        // anything changes: each is copied, and checked again as it is, only at its write, after C: has
        // given Swiff OS its room.
        const { files: listed } = imageSet();
        certificate();
        for (const [name, file] of Object.entries(listed))
          if (name !== MOK_CERT)
            await copyChecked(
              path.join(imageDir, name),
              null,
              file,
              (done, total) => progress({ what: `Checking ${name}`, done, total }),
              files,
            );
        return {};
      }
      case "bitlocker-suspend":
        await run(op);
        state.save({ bitlocker: op.letter });
        return {};
      case "bitlocker-resume":
        must(s.bitlocker === op.letter, `BitLocker on ${op.letter}: was not suspended by the install.`);
        await run(op);
        state.save({ bitlocker: null });
        return {};
      case "fast-startup-off": {
        const was = (
          await win.powershell([
            "(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power').HiberbootEnabled",
          ])
        ).trim();
        await run(op);
        if (was === "1") state.save({ fastStartup: true });
        return {};
      }
      case "fast-startup-on":
        must(s.fastStartup, "Fast Startup was not turned off by the install.");
        await run(op);
        state.save({ fastStartup: false });
        return {};
      case "shrink": {
        must(!s.shrink && !s.partitions.length, "The install already made its room.");
        const part = JSON.parse(
          await win.powershell([
            `$p = Get-Partition -DiskNumber ${op.disk} -PartitionNumber ${op.partition}`,
            "[pscustomobject]@{ letter = [string]$p.DriveLetter; size = $p.Size; type = [string]$p.GptType } | ConvertTo-Json -Compress",
          ]),
        );
        must(part.letter === op.letter, `Partition ${op.partition} of disk ${op.disk} is not ${op.letter}:.`);
        must(
          part.type.replace(/[{}]/g, "").toLowerCase() === TYPE.windowsData,
          `${op.letter}: is not a Windows data partition.`,
        );
        must(op.size < part.size, `${op.letter}: is already smaller than that.`);
        await run(op);
        state.save({
          disk: op.disk,
          shrink: { letter: op.letter, partition: op.partition, from: part.size, to: op.size },
        });
        return {};
      }
      case "grow": {
        const k = s.shrink;
        must(
          k &&
            s.disk === op.disk &&
            k.letter === op.letter &&
            k.partition === op.partition &&
            k.from === op.size,
          "The install did not shrink that drive by that much.",
        );
        must(!s.partitions.length, "Swiff OS's partitions are still in the way.");
        await run(op);
        state.save({ shrink: null });
        return {};
      }
      case "gpt-add": {
        must(!s.partitions.length, "Swiff OS's partitions are already there.");
        must(s.disk === null || s.disk === op.disk, "Swiff OS's room is on another disk.");
        // Exactly the image's partitions, back to back: nothing else may be added.
        const { layout } = imageSet();
        must(op.partitions.length === layout.length, "Those are not Swiff OS's partitions.");
        op.partitions.forEach((p, i) => {
          const want = layout[i];
          must(
            p.role === want.role &&
              p.type === want.type &&
              p.id === want.id &&
              p.name === want.name &&
              p.attrs === want.attrs &&
              p.bytes === want.bytes,
            `Partition ${i + 1} is not the image's ${want.role}.`,
          );
          must(
            i === 0 || p.offset === op.partitions[i - 1].offset + op.partitions[i - 1].bytes,
            "Swiff OS's partitions are not back to back.",
          );
        });
        await withDisk(op.disk, async (disk, gpt) => {
          const ss = gpt.sectorSize;
          op.partitions.forEach((p) =>
            must(p.offset % ss === 0 && p.bytes % ss === 0, "A partition is not whole sectors."),
          );
          const next = withPartitions(
            gpt,
            op.partitions.map((p) => ({
              type: p.role === "esp" ? STAGING : p.type,
              id: p.id,
              name: p.name,
              attrs: BigInt(p.attrs),
              first: p.offset / ss,
              last: (p.offset + p.bytes) / ss - 1,
            })),
          );
          disk.write(gptWrites(next));
        });
        state.save({
          disk: op.disk,
          partitions: op.partitions.map(({ role, id, offset, bytes }) => ({ role, id, offset, bytes })),
        });
        await win.powershell([`Update-Disk -Number ${op.disk}`]);
        // Windows must see them where they were written.
        await withDisk(op.disk, async (_disk, gpt) => {
          for (const p of op.partitions)
            must(
              gpt.entries.some((e) => e.id === p.id && e.first * gpt.sectorSize === p.offset),
              `Partition ${p.role} did not stay on the disk.`,
            );
        });
        return {};
      }
      case "gpt-remove": {
        must(s.disk === op.disk, "Swiff OS is not on that disk.");
        must(s.bootEntry === null, "Take Swiff OS out of the boot menu first.");
        must(
          op.partitions.length === s.partitions.length &&
            op.partitions.every(
              (p, i) =>
                p.id === s.partitions[i].id &&
                p.offset === s.partitions[i].offset &&
                p.bytes === s.partitions[i].bytes,
            ),
          "Those are not the partitions the install added.",
        );
        await withDisk(op.disk, async (disk, gpt) => {
          const gone = s.partitions.map((p) => {
            const e = gpt.entries.find((x) => x.id === p.id);
            must(
              e &&
                SWIFF_TYPES.has(e.type) &&
                e.first * gpt.sectorSize === p.offset &&
                (e.last - e.first + 1) * gpt.sectorSize === p.bytes,
              `Partition ${p.role} is not the one the install added.`,
            );
            return e.index;
          });
          disk.write(gptWrites(withRemoved(gpt, gone)));
        });
        state.save({ partitions: [] });
        await win.powershell([`Update-Disk -Number ${op.disk}`]);
        return {};
      }
      case "write": {
        const part = s.partitions.find((p) => p.offset === op.offset && p.bytes === op.bytes);
        const layout = part && imageSet().layout.find((p) => p.role === part.role);
        must(
          s.disk === op.disk && layout && layout.split === op.source,
          "That is not one of Swiff OS's partitions.",
        );
        const source = sourceOf(imageSet(), op.source);
        must(source.bytes === op.bytes, "The file is not the size of its partition.");
        const what = path.basename(source.path);
        await copyChecked(
          path.join(imageDir, what),
          source.path,
          source,
          (done, total) => progress({ what: `Copying ${what}`, done, total }),
          files,
        );
        const fd = files.openSync(source.path, "r");
        try {
          await withDisk(op.disk, async (disk) => {
            // Hashed as it is written, so a file that changed since its check is caught.
            const written = await hashOf(
              async (buf, at) => {
                const n = files.readSync(fd, buf, 0, buf.length, at);
                if (n === buf.length) disk.write([{ offset: op.offset + at, bytes: buf }]);
                return n;
              },
              op.bytes,
              (done, total) => progress({ what: `Writing ${what}`, done, total }),
            );
            must(written === source.sha256, `${what} changed while it was written.`);
            const back = await hashOf(
              async (buf, at) => {
                disk.read(op.offset + at, buf.length).copy(buf);
                return buf.length;
              },
              op.bytes,
              (done, total) => progress({ what: `Checking ${what}`, done, total }),
            );
            must(back === source.sha256, `${what} did not read back as written.`);
          });
        } finally {
          files.closeSync(fd);
        }
        // On the disk now: its copy gives C: its room back.
        files.rmSync(source.path);
        return {};
      }
      case "boot-entry": {
        const esp = s.partitions.find((p) => p.role === "esp");
        must(s.disk === op.disk && esp && esp.offset === op.offset, "That is not Swiff OS's boot partition.");
        if (s.bootEntry !== null) return { entry: await ourEntry() };
        // Written and checked: the boot partition becomes an ESP now, before the firmware is pointed at it.
        const retyped = await withDisk(op.disk, async (disk, gpt) => {
          const e = gpt.entries.find((x) => x.id === esp.id);
          must(
            e && (e.type === TYPE.esp || e.type === STAGING),
            "Swiff OS's boot partition is not on the disk.",
          );
          if (e.type === TYPE.esp) return false;
          disk.write(gptWrites(withRetyped(gpt, e.index, TYPE.esp)));
          return true;
        });
        if (retyped) await win.powershell([`Update-Disk -Number ${op.disk}`]);
        return { entry: await addEntry(op.disk) };
      }
      case "boot-entry-remove": {
        // Gone already (the firmware dropped it): nothing of Swiff OS is left in the boot menu.
        const entry = s.bootEntry === null ? null : await findEntry();
        if (entry === null) {
          state.save({ bootEntry: null });
          return {};
        }
        const got = await win.firmware([
          { get: "BootOrder", guid: efi.GLOBAL },
          { get: "BootNext", guid: efi.GLOBAL },
        ]);
        const next = got.BootNext ? efi.orderOf(got.BootNext)[0] : null;
        await win.firmware([
          ...(next === entry ? [{ set: "BootNext", guid: efi.GLOBAL, data: null }] : []),
          {
            set: "BootOrder",
            guid: efi.GLOBAL,
            data: efi.orderBytes(efi.orderOf(got.BootOrder).filter((n) => n !== entry)),
          },
          { set: efi.bootName(entry), guid: efi.GLOBAL, data: null },
        ]);
        state.save({ bootEntry: null });
        return {};
      }
      case "boot-first": {
        const entry = op.entry === "swiff" ? await ourEntry() : await windowsEntry();
        const got = await win.firmware([{ get: "BootOrder", guid: efi.GLOBAL }]);
        await win.firmware([
          {
            set: "BootOrder",
            guid: efi.GLOBAL,
            data: efi.orderBytes(efi.placeIn(efi.orderOf(got.BootOrder), entry, "first")),
          },
        ]);
        return {};
      }
      case "boot-next": {
        const entry = await ourEntry();
        await win.firmware([
          { set: "BootNext", guid: efi.GLOBAL, data: efi.orderBytes([entry]) },
          // Should shim meet a key it cannot check, its MokManager waits for the owner rather than
          // counting down into Windows in the same power-on (which changes PCR 7: the PIN, BitLocker).
          { set: "MokTimeout", guid: efi.SHIM_LOCK, data: efi.MOK_WAIT },
        ]);
        // The restart must reach Swiff OS: BootNext is read back, not trusted.
        const back = await win.firmware([{ get: "BootNext", guid: efi.GLOBAL }]);
        must(efi.orderOf(back.BootNext)[0] === entry, "The firmware did not keep BootNext.");
        return { entry };
      }
      case "mok-import":
      case "mok-delete": {
        const vars = efi.mokVariables(certificate(), op.code, {
          remove: op.op === "mok-delete",
        });
        await win.firmware(
          Object.entries(vars).map(([name, data]) => ({ set: name, guid: efi.SHIM_LOCK, data })),
        );
        const back = await win.firmware(
          Object.keys(vars).map((name) => ({ get: name, guid: efi.SHIM_LOCK })),
        );
        for (const [name, data] of Object.entries(vars))
          must(back[name] && back[name].equals(data), `The firmware did not keep ${name}.`);
        if (op.op === "mok-import") state.save({ mok: true });
        return {};
      }
      case "mok-cancel":
        await win.firmware(
          ["MokNew", "MokAuth", "MokTimeout"].map((name) => ({ set: name, guid: efi.SHIM_LOCK, data: null })),
        );
        return {};
      case "label": {
        const recorded = s.labels.find((l) => l.letter === op.letter);
        const restore = recorded && recorded.from === op.label;
        must(
          restore || op.label === GAMES_LABEL || op.label === "",
          `The install does not name drives ${op.label}.`,
        );
        const was = (await win.powershell([`(Get-Volume -DriveLetter ${op.letter}).FileSystemLabel`])).trim();
        await run(op);
        if (restore) state.save({ labels: s.labels.filter((l) => l !== recorded) });
        else if (!recorded) state.save({ labels: [...s.labels, { letter: op.letter, from: was }] });
        return {};
      }
      case "installed":
        must(s.partitions.length && s.bootEntry !== null, "Swiff OS is not on this PC yet.");
        state.save({ complete: true });
        return {};
      case "forget":
        must(
          s.bootEntry === null && !s.partitions.length && !s.shrink,
          "Part of Swiff OS is still on this PC.",
        );
        state.forget();
        return {};
      case "restart":
        await run(op);
        return {};
      default:
        throw new Error(`Not an operation this installer knows: ${op.op}.`);
    }
  }

  return { apply, state: () => state.get() };
}

// --- talking to the app ---------------------------------------------------------------

/**
 * Serve the app on `pipe`, for the image set in `imageDir` signed by a key in
 * `trust`: prove it holds `token` (which only the app knows, from this
 * process's command line) and have the app prove the same (handshake), say
 * hello, then carry out each operation it sends,
 * one at a time, as newline-delimited JSON: `{ id, op }` in, `{ id, progress }`
 * while it runs, then `{ id, ok, result }` or `{ id, ok: false, error }`. Exits
 * when the app hangs up.
 */
async function serve(pipe, token, imageDir, trust) {
  const socket = net.connect(pipe);
  await new Promise((resolve, reject) => socket.once("connect", resolve).once("error", reject));
  const send = (msg) => socket.write(`${JSON.stringify(msg)}\n`);
  let buffered;
  try {
    // A pipe that is not the app's (anyone can open one by that name) is hung up on.
    buffered = await handshake(socket, token, "worker");
  } catch {
    return;
  }
  let worker;
  try {
    worker = await createWorker({ imageDir, trust });
    send({ ok: true });
  } catch (error) {
    send({ ok: false, error: error.message });
    socket.end();
    return;
  }
  let queue = Promise.resolve();
  const onData = (chunk) => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      queue = queue.then(async () => {
        try {
          const result = await worker.apply(msg.op, (progress) => send({ id: msg.id, progress }));
          send({ id: msg.id, ok: true, result });
        } catch (error) {
          send({ id: msg.id, ok: false, error: error.message });
        }
      });
    }
  };
  socket.on("data", onData);
  onData("");
  await new Promise((resolve) => socket.once("close", resolve));
}

module.exports = {
  SWIFF_TYPES,
  checkOp,
  createWorker,
  diskOf,
  diskPath,
  firmware,
  powershell,
  serve,
  WINDOWS,
};

if (require.main === module) {
  const [pipe, token, imageDir] = process.argv.slice(2);
  serve(pipe, token, imageDir, trustOf({ dev: true })).then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
