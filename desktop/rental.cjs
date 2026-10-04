// Rental mode on this PC, in the main process. While the owner shares it, the
// PC restarts into Swiff OS, a locked system nobody at the PC can reach the
// player's Steam account from, and it comes back to Windows when they stop.
//
//   readRental   what Swiff OS needs from this PC, read without administrator
//                rights and without changing anything: UEFI, Secure Boot, the
//                TPM, the IOMMU, disk space, BitLocker, the graphics card and
//                Fast Startup, and whether Swiff OS is installed.
//   installPlan  the exact steps that install Swiff OS next to Windows: shrink
//                a drive (or use free space), add Swiff OS's partitions, write
//                it, add its UEFI boot entry, name the games drive.
//   switchPlan   the exact steps that start sharing (Swiff OS first in the
//                boot order, BootNext, restart) and stop it (Windows first).
//
// The plans are previews: each step carries its operations (`ops`, which the
// VM test in vm/ carries out on a disk image) and the Windows commands they
// stand for. Nothing in this app runs them on a PC yet.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { findSteamRoot, libraryPaths } = require("./pc.cjs");

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

// GPT partition types (the Discoverable Partitions Specification's for Linux).
const TYPE = {
  esp: "c12a7328-f81f-11d2-ba4b-00a0c93ec93b",
  root: "4f68bce3-e8cd-4db1-96e7-fbcaf984b709",
  verity: "2c7357ed-ebd2-46d9-aec1-23d437ec2bf5",
  linux: "0fc63daf-8483-4772-8e79-3d69d8477de4",
  windowsData: "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7",
};

// GPT attribute bits the image sets (Discoverable Partitions Specification):
// 60 read-only, 59 no-auto, which keeps the empty slot B from being mounted.
const READ_ONLY = "0x1000000000000000";
const NO_AUTO = "0x800000000000000";

/**
 * Swiff OS's partitions, as swiff-os/image/mkosi.repart lays them out: a fixed
 * 23.6 GiB with no size choice (captain decision D6). `split` names the image
 * file a partition's contents come from; slot B and the scratch start empty.
 * The unique ids, names and attributes are the image's own: an installer reads them from
 * the image it writes (imageLayout), because Swiff OS finds its root by an id
 * derived from the root hash.
 */
const SWIFF_OS = {
  version: "0.1.0",
  partitions: [
    { role: "esp", type: TYPE.esp, bytes: 1 * GiB, split: "esp", attrs: "0x0" },
    { role: "root-a", type: TYPE.root, bytes: 8 * GiB, split: "root-x86-64", attrs: READ_ONLY },
    { role: "verity-a", type: TYPE.verity, bytes: 128 * MiB, split: "root-x86-64-verity", attrs: READ_ONLY },
    { role: "root-b", type: TYPE.root, bytes: 8 * GiB, split: null, attrs: NO_AUTO },
    { role: "verity-b", type: TYPE.verity, bytes: 128 * MiB, split: null, attrs: READ_ONLY },
    { role: "scratch", type: TYPE.linux, bytes: 6528 * MiB, split: null, attrs: "0x0" },
  ],
};

/** What Swiff OS takes on the disk: 24,192 MiB. */
const SWIFF_OS_BYTES = SWIFF_OS.partitions.reduce((sum, p) => sum + p.bytes, 0);

/** A drive is shrunk only if Windows keeps at least this much free on it afterwards. */
const KEEP_FREE = 16 * GiB;

/** The name Swiff OS mounts the shared games library by (swiff-os/image/mkosi.extra/etc/fstab). */
const GAMES_LABEL = "SWIFFGAMES";

/** Where the install leaves the firmware boot entry's id, for the switch to find. */
const BOOT_ENTRY_FILE = String.raw`$env:ProgramData\Swiff\boot-entry.txt`;

/** The path systemd-boot (later, Swiff's shim) has on Swiff OS's own ESP. */
const BOOT_PATH = String.raw`\EFI\BOOT\BOOTX64.EFI`;

const alignUp = (n, to) => Math.ceil(n / to) * to;
const alignDown = (n, to) => Math.floor(n / to) * to;

// --- reading the PC ---------------------------------------------------------------
//
// One PowerShell script, run as the owner: every read here works without
// administrator rights. What needs them (the Secure Boot db, the TPM's
// endorsement certificate, how far a drive can shrink) is checked by the
// install's first step instead. Each read is best effort and null when it fails.

const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
function Read-Or($block) { try { & $block } catch { $null } }
$shell = New-Object -ComObject Shell.Application
[pscustomobject]@{
  firmware = $env:firmware_type
  secureBoot = Read-Or { (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot\State' -ErrorAction Stop).UEFISecureBootEnabled }
  tpm2 = Read-Or { @(Get-PnpDevice -InstanceId 'ACPI\MSFT0101*' -Status OK -ErrorAction Stop).Count -gt 0 }
  tpmInfo = Read-Or { (tpmtool getdeviceinformation) -join [Environment]::NewLine }
  securityProperties = @(Read-Or { (Get-CimInstance -Namespace root/Microsoft/Windows/DeviceGuard -ClassName Win32_DeviceGuard -ErrorAction Stop).AvailableSecurityProperties })
  fastStartup = Read-Or { (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -ErrorAction Stop).HiberbootEnabled }
  gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { [pscustomobject]@{ name = $_.Name; pnp = $_.PNPDeviceID } })
  disks = @(Get-Disk | ForEach-Object { [pscustomobject]@{ number = $_.Number; style = [string]$_.PartitionStyle; size = $_.Size; sector = $_.LogicalSectorSize; bus = [string]$_.BusType; system = $_.IsSystem } })
  partitions = @(Get-Partition | ForEach-Object { [pscustomobject]@{ disk = $_.DiskNumber; number = $_.PartitionNumber; letter = [string]$_.DriveLetter; type = $_.GptType; offset = $_.Offset; size = $_.Size } })
  volumes = @(Get-Volume | Where-Object DriveLetter | ForEach-Object { [pscustomobject]@{ letter = [string]$_.DriveLetter; fs = $_.FileSystem; label = $_.FileSystemLabel; size = $_.Size; free = $_.SizeRemaining; fixed = ([string]$_.DriveType -eq 'Fixed'); bitlocker = $shell.NameSpace("$($_.DriveLetter):").Self.ExtendedProperty('System.Volume.BitLockerProtection') } })
  bootEntry = Read-Or { (Get-Content -LiteralPath "$env:ProgramData\Swiff\boot-entry.txt" -TotalCount 1 -ErrorAction Stop).Trim() }
} | ConvertTo-Json -Compress -Depth 4
`;

/** Run a PowerShell script as the owner, unelevated, and resolve with what it prints. */
async function powershell(script) {
  const { stdout } = await promisify(execFile)(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  return stdout;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === "string" ? v.trim() : "");
const list = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []);
const letterOf = (v) => (/^[A-Z]$/i.test(str(v)) ? str(v).toUpperCase() : null);
const guidOf = (v) => str(v).replace(/[{}]/g, "").toLowerCase();

/** The graphics vendor from a PCI device id: locale-proof, unlike the names. */
function gpuVendor(pnp) {
  const vendor = /VEN_([0-9A-F]{4})/i.exec(str(pnp))?.[1]?.toUpperCase();
  return { "10DE": "nvidia", 1002: "amd", 8086: "intel" }[vendor] ?? "other";
}

/**
 * BitLocker on a drive, from the shell's System.Volume.BitLockerProtection,
 * which needs no administrator rights: 2 is off, 1 and 3 to 6 are on in some
 * form (on, encrypting, decrypting, suspended, locked); anything else unknown.
 */
function bitlockerState(value) {
  if (value === 2) return "off";
  if ([1, 3, 4, 5, 6].includes(value)) return "on";
  return null;
}

/**
 * The TPM's maker, from `tpmtool getdeviceinformation`, and whether it is
 * built into the processor (AMD fTPM, Intel PTT) or a separate chip, which
 * captain decision D3 (still open) accepts at a lower trust tier.
 */
function tpmMaker(info) {
  const maker = /Manufacturer ID:\s*(\S+)/i.exec(str(info))?.[1]?.toUpperCase() ?? null;
  if (!maker) return { maker: null, firmware: null };
  return { maker, firmware: ["AMD", "INTC", "MSFT", "QCOM"].includes(maker) };
}

/** The script's output as plain, checked facts. Anything it could not read is null. */
function factsOf(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const secureBoot = num(r.secureBoot);
  const fastStartup = num(r.fastStartup);
  const security = list(r.securityProperties).filter((v) => num(v) !== null);
  return {
    uefi: str(r.firmware) ? str(r.firmware).toUpperCase() === "UEFI" : null,
    secureBoot: secureBoot === null ? null : secureBoot === 1,
    tpm: { present: typeof r.tpm2 === "boolean" ? r.tpm2 : null, ...tpmMaker(r.tpmInfo) },
    iommu: security.length ? security.includes(3) : null,
    fastStartup: fastStartup === null ? null : fastStartup === 1,
    gpus: list(r.gpus)
      .filter((g) => str(g?.name))
      .map((g) => ({ name: str(g.name), vendor: gpuVendor(g.pnp) })),
    disks: list(r.disks)
      .filter((d) => num(d?.number) !== null && num(d?.size))
      .map((d) => ({
        number: d.number,
        gpt: str(d.style).toUpperCase() === "GPT",
        size: d.size,
        sector: num(d.sector) ?? 512,
        usb: str(d.bus).toUpperCase() === "USB",
        system: d.system === true,
      })),
    partitions: list(r.partitions)
      .filter((p) => num(p?.disk) !== null && num(p?.offset) !== null && num(p?.size))
      .map((p) => ({
        disk: p.disk,
        number: num(p.number),
        letter: letterOf(p.letter),
        type: guidOf(p.type),
        offset: p.offset,
        size: p.size,
      })),
    volumes: list(r.volumes)
      .filter((v) => letterOf(v?.letter) && num(v?.size))
      .map((v) => ({
        letter: letterOf(v.letter),
        fs: str(v.fs),
        label: str(v.label),
        size: v.size,
        free: num(v.free) ?? 0,
        fixed: v.fixed === true,
        bitlocker: bitlockerState(v.bitlocker),
      })),
    bootEntry: /^\{[0-9a-f-]{36}\}$/i.test(str(r.bootEntry)) ? str(r.bootEntry).toLowerCase() : null,
  };
}

// --- where Swiff OS goes ------------------------------------------------------------

/** The unused stretches of a GPT disk, MiB-aligned, with room left for the backup table at the end. */
function freeSpans(disk, partitions) {
  const taken = partitions.filter((p) => p.disk === disk.number).sort((a, b) => a.offset - b.offset);
  const spans = [];
  let at = MiB;
  for (const p of [...taken, { offset: alignDown(disk.size - MiB, MiB), size: 0 }]) {
    const start = alignUp(at, MiB);
    if (p.offset - start > 0) spans.push({ offset: start, bytes: p.offset - start });
    at = Math.max(at, p.offset + p.size);
  }
  return spans;
}

/**
 * Where Swiff OS can go, best first: free space on a GPT disk, then shrinking
 * the Windows drive (C:), then shrinking another fixed NTFS drive. A drive is
 * shrunk from its end, by just enough, and only if it keeps KEEP_FREE.
 */
function targetsOf(facts, need = SWIFF_OS_BYTES) {
  const disks = facts.disks.filter((d) => d.gpt && !d.usb);
  const free = disks.flatMap((disk) =>
    freeSpans(disk, facts.partitions)
      .filter((span) => span.bytes >= need)
      .map((span) => ({
        id: `free:${disk.number}:${span.offset}`,
        kind: "free",
        disk: disk.number,
        sector: disk.sector,
        start: span.offset,
      })),
  );
  const shrink = facts.volumes.flatMap((volume) => {
    const part = facts.partitions.find((p) => p.letter === volume.letter);
    const disk = part && disks.find((d) => d.number === part.disk);
    if (!disk || !volume.fixed || volume.fs.toUpperCase() !== "NTFS") return [];
    if (part.type !== TYPE.windowsData || volume.free < need + KEEP_FREE) return [];
    // Shrinking frees the end of the partition: Swiff OS starts at the first MiB boundary in it.
    let size = alignDown(part.size - need, MiB);
    while (size > 0 && alignUp(part.offset + size, MiB) + need > part.offset + part.size) size -= MiB;
    return [
      {
        id: `shrink:${volume.letter}`,
        kind: "shrink",
        letter: volume.letter,
        disk: disk.number,
        sector: disk.sector,
        partition: part.number,
        size,
        start: alignUp(part.offset + size, MiB),
        free: volume.free,
        system: volume.letter === "C",
      },
    ];
  });
  shrink.sort((a, b) => Number(b.system) - Number(a.system) || b.free - a.free);
  return [...free, ...shrink];
}

// --- the games drive ------------------------------------------------------------------

/** Steam's libraries on this PC by drive, with how many games each holds. */
function libraryDrives({ steamPath = null, files = fs, ...options } = {}) {
  const root = findSteamRoot({ steamPath, files, ...options });
  if (!root) return [];
  let vdf = "";
  try {
    vdf = files.readFileSync(path.join(root, "steamapps", "libraryfolders.vdf"), "utf8");
  } catch {
    // No list: only Steam's own folder.
  }
  const drives = new Map();
  for (const library of new Set([root, ...libraryPaths(vdf)])) {
    const letter = /^([A-Z]):/i.exec(library)?.[1]?.toUpperCase();
    if (!letter) continue;
    let games = 0;
    try {
      games = files
        .readdirSync(path.join(library, "steamapps"))
        .filter((n) => /^appmanifest_\d+\.acf$/.test(n)).length;
    } catch {
      // An unplugged or missing library holds nothing here.
    }
    drives.set(letter, (drives.get(letter) ?? 0) + games);
  }
  return [...drives].map(([letter, games]) => ({ letter, games }));
}

/** The drive Swiff OS shares games from: the one whose Steam libraries hold the most games. */
function gamesDriveOf(facts, libraries) {
  const best = [...libraries].sort((a, b) => b.games - a.games)[0];
  if (!best) return null;
  const volume = facts.volumes.find((v) => v.letter === best.letter);
  return {
    letter: best.letter,
    games: best.games,
    label: volume?.label ?? "",
    fs: volume?.fs ?? "",
    bitlocker: volume?.bitlocker ?? null,
  };
}

/** Swiff OS is installed: its boot entry is recorded and a disk has its root partition. */
const installedOf = (facts) => Boolean(facts.bootEntry && facts.partitions.some((p) => p.type === TYPE.root));

/** Everything the rental-mode screen shows, from the script's output and Steam's libraries. */
function rentalOf(raw, libraries = []) {
  const facts = factsOf(raw);
  const targets = targetsOf(facts);
  return {
    facts,
    need: SWIFF_OS_BYTES,
    targets,
    games: gamesDriveOf(facts, libraries),
    installed: installedOf(facts),
  };
}

/** What rental mode needs from this PC, read fresh; null where it cannot be read (off Windows). */
async function readRental({ platform = process.platform, run = powershell, libraries } = {}) {
  if (platform !== "win32") return null;
  try {
    return rentalOf(JSON.parse(await run(SCRIPT)), libraries ?? libraryDrives({ platform }));
  } catch {
    return null;
  }
}

// --- the image ------------------------------------------------------------------------

/**
 * Swiff OS's partitions as an image's own GPT has them (gpt.cjs readGpt), in
 * disk order, with the type, id and name each must keep. Throws unless the
 * image has exactly the partitions SWIFF_OS expects.
 */
function imageLayout(gpt) {
  const entries = [...gpt.entries].sort((a, b) => a.first - b.first);
  if (entries.length !== SWIFF_OS.partitions.length) throw new Error("The image has unexpected partitions.");
  return SWIFF_OS.partitions.map((want, i) => {
    const e = entries[i];
    const bytes = (e.last - e.first + 1) * gpt.sectorSize;
    if (e.type !== want.type || bytes !== want.bytes)
      throw new Error(`The image's partition ${i + 1} is not Swiff OS's ${want.role}.`);
    return { ...want, id: e.id, name: e.name, attrs: `0x${e.attrs.toString(16)}` };
  });
}

/** Without the image at hand: Swiff OS's layout with its ids and names still to be read from it. */
const PREVIEW_LAYOUT = SWIFF_OS.partitions.map((p) => ({ ...p, id: null, name: null }));

/** The image file a partition's contents come from: swiffos_0.1.0.esp.raw. */
const splitFile = (split, version = SWIFF_OS.version) => `swiffos_${version}.${split}.raw`;

// --- plans ------------------------------------------------------------------------------

/** 25,367,150,592 bytes → "24 GB" (whole gigabytes, as Explorer counts them). */
const gb = (bytes) => `${Math.round(bytes / GiB)} GB`;

/** One PowerShell line quoting `text` as a literal. */
const q = (text) => `'${String(text).replace(/'/g, "''")}'`;

/** Swiff OS's partitions placed from `start` (bytes) on, one after another. */
function placed(layout, start) {
  let at = start;
  return layout.map((p) => {
    const part = { ...p, offset: at };
    at += p.bytes;
    return part;
  });
}

/**
 * The steps that install Swiff OS next to Windows, for the target the owner
 * chose (an id from targetsOf). `layout` is imageLayout of the image being
 * installed; without it the ids and names show as the image's.
 */
function installPlan(rental, { target: targetId, layout = PREVIEW_LAYOUT } = {}) {
  const { facts, games } = rental;
  const target = rental.targets.find((t) => t.id === targetId) ?? rental.targets[0];
  if (!target) throw new Error(`This PC has no drive with ${gb(SWIFF_OS_BYTES)} to spare.`);
  const disk = target.disk;
  const parts = placed(layout, target.start);
  const espOffset = parts.find((p) => p.role === "esp").offset;
  const steps = [];

  const shrinkable =
    target.kind === "shrink"
      ? [
          `if ((Get-PartitionSupportedSize -DiskNumber ${disk} -PartitionNumber ${target.partition}).SizeMin -gt ${target.size}) { throw '${target.letter}: cannot shrink by ${gb(SWIFF_OS_BYTES)}.' }`,
        ]
      : [];
  steps.push({
    id: "check",
    title: "Check the Secure Boot keys and the TPM, as administrator",
    ops: [{ op: "check" }],
    commands: [
      "if (-not (Confirm-SecureBootUEFI)) { throw 'Secure Boot is off.' }",
      "if (-not (Get-Tpm).TpmReady) { throw 'The TPM is not ready.' }",
      "if (-not (Get-TpmEndorsementKeyInfo).ManufacturerCertificates) { throw 'The TPM has no endorsement key certificate.' }",
      "if ([Text.Encoding]::ASCII.GetString((Get-SecureBootUEFI db).Bytes) -notmatch 'Microsoft UEFI CA 2023') { throw 'The firmware lacks the Microsoft UEFI CA 2023.' }",
      ...shrinkable,
    ],
  });
  if (facts.fastStartup !== false) {
    steps.push({
      id: "fast-startup",
      title: "Turn off Fast Startup, so Windows leaves its drives readable",
      ops: [{ op: "fast-startup-off" }],
      commands: [
        String.raw`reg add "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Power" /v HiberbootEnabled /t REG_DWORD /d 0 /f`,
      ],
    });
  }
  if (target.kind === "shrink") {
    steps.push({
      id: "room",
      title: `Shrink ${target.letter}: by ${gb(SWIFF_OS_BYTES)}`,
      ops: [{ op: "shrink", disk, partition: target.partition, size: target.size }],
      commands: [
        `Resize-Partition -DiskNumber ${disk} -PartitionNumber ${target.partition} -Size ${target.size}`,
      ],
    });
  }
  steps.push({
    id: "partitions",
    title: `Add Swiff OS's ${parts.length} partitions on disk ${disk}`,
    ops: [
      {
        op: "gpt-add",
        disk,
        partitions: parts.map(({ type, id, name, attrs, offset, bytes }) => ({
          type,
          id,
          name,
          attrs,
          offset,
          bytes,
        })),
      },
    ],
    commands: [
      `# Swiff Host's GPT writer (gpt.cjs) on \\\\.\\PhysicalDrive${disk}: types, ids, names and attributes as in the image`,
      ...parts.map(
        (p) =>
          `#   ${p.role}: offset ${p.offset}, ${p.bytes} bytes, type ${p.type}, id ${p.id ?? "(image's)"}, name ${p.name ?? "(image's)"}, attributes ${p.attrs}`,
      ),
      `Update-Disk -Number ${disk}`,
    ],
  });
  const writes = parts.filter((p) => p.split);
  steps.push({
    id: "write",
    title: "Write Swiff OS: its boot partition and its system",
    ops: writes.map((p) => ({ op: "write", disk, offset: p.offset, bytes: p.bytes, source: p.split })),
    commands: writes.map(
      (p) =>
        `# Write ${splitFile(p.split)} to \\\\.\\PhysicalDrive${disk} at offset ${p.offset} (${p.bytes} bytes)`,
    ),
  });
  steps.push({
    id: "boot-entry",
    title: "Add Swiff OS to the PC's boot menu, after Windows",
    ops: [{ op: "boot-entry", disk, offset: espOffset, path: BOOT_PATH, title: "Swiff OS" }],
    commands: [
      `$esp = Get-Partition -DiskNumber ${disk} | Where-Object Offset -eq ${espOffset}`,
      "$used = @((Get-Volume).DriveLetter) + @((Get-PSDrive -PSProvider FileSystem).Name)",
      "$letter = [char[]](68..90) | Where-Object { $used -notcontains [string]$_ } | Select-Object -First 1",
      '$esp | Add-PartitionAccessPath -AccessPath "$($letter):\\"',
      "$entry = [regex]::Match((bcdedit /copy '{bootmgr}' /d 'Swiff OS'), '\\{[0-9a-fA-F-]{36}\\}').Value",
      'bcdedit /set $entry device "partition=$($letter):"',
      `bcdedit /set $entry path ${BOOT_PATH}`,
      "bcdedit /set '{fwbootmgr}' displayorder $entry /addlast",
      '$esp | Remove-PartitionAccessPath -AccessPath "$($letter):\\"',
      `New-Item -ItemType Directory -Force (Split-Path ${BOOT_ENTRY_FILE}) | Out-Null; Set-Content ${BOOT_ENTRY_FILE} $entry`,
    ],
  });
  if (games && games.label !== GAMES_LABEL) {
    steps.push({
      id: "games",
      title: `Name ${games.letter}: ${GAMES_LABEL}, so Swiff OS finds your Steam games`,
      ops: [{ op: "label", letter: games.letter, label: GAMES_LABEL }],
      commands: [`Set-Volume -DriveLetter ${games.letter} -NewFileSystemLabel ${q(GAMES_LABEL)}`],
    });
  }
  return { kind: "install", dryRun: true, target, steps };
}

/**
 * Start sharing: Swiff OS first in the boot order, so a power cut or a crash
 * comes back to it, and BootNext for this restart. Stop: Windows first again.
 */
function switchPlan(kind) {
  const entry = `$entry = (Get-Content ${BOOT_ENTRY_FILE} -TotalCount 1).Trim()`;
  if (kind === "start") {
    return {
      kind,
      dryRun: true,
      steps: [
        {
          id: "boot-order",
          title: "Put Swiff OS first in the boot order",
          ops: [{ op: "boot-first", entry: "swiff" }],
          commands: [entry, "bcdedit /set '{fwbootmgr}' displayorder $entry /addfirst"],
        },
        {
          id: "boot-next",
          title: "Start Swiff OS on this restart",
          ops: [{ op: "boot-next", entry: "swiff" }],
          commands: ["bcdedit /set '{fwbootmgr}' bootsequence $entry"],
        },
        {
          id: "restart",
          title: "Restart into rental mode",
          ops: [{ op: "restart" }],
          commands: ["shutdown /r /t 0"],
        },
      ],
    };
  }
  return {
    kind: "stop",
    dryRun: true,
    steps: [
      {
        id: "boot-order",
        title: "Put Windows first in the boot order again",
        ops: [{ op: "boot-first", entry: "windows" }],
        commands: ["bcdedit /set '{fwbootmgr}' displayorder '{bootmgr}' /addfirst"],
      },
    ],
  };
}

module.exports = {
  TYPE,
  SWIFF_OS,
  SWIFF_OS_BYTES,
  KEEP_FREE,
  GAMES_LABEL,
  SCRIPT,
  gpuVendor,
  bitlockerState,
  tpmMaker,
  factsOf,
  freeSpans,
  targetsOf,
  libraryDrives,
  gamesDriveOf,
  rentalOf,
  readRental,
  imageLayout,
  splitFile,
  installPlan,
  switchPlan,
};
