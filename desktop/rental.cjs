// Rental mode on this PC, in the main process. While the owner shares it, the
// PC restarts into Swiff OS, a locked system nobody at the PC can reach the
// player's Steam account from, and it comes back to Windows when they stop.
//
//   readRental     what Swiff OS needs from this PC, read without administrator
//                  rights and without changing anything: UEFI, Secure Boot, the
//                  TPM, the IOMMU, disk space, BitLocker, the graphics card and
//                  Fast Startup, and what an install has done so far.
//   installPlan    the exact steps that install Swiff OS next to Windows:
//                  suspend BitLocker, shrink a drive (or use free space), add
//                  Swiff OS's partitions, hand it this PC's machine key
//                  (provision.cjs), write it (and the project Lanterel Host
//                  reports errors to, onto its ESP), add its UEFI boot entry,
//                  name the games drive, then queue Swiff's key for the owner
//                  to confirm once at the PC (MOK) and restart into that
//                  confirmation.
//   uninstallPlan  the steps that take it all back off, from what the install
//                  recorded: also what undoes an install that stopped half way.
//   removePlan     Remove Swiff OS, as one action in two parts: Swiff's key off
//                  first (one restart, confirmed at MokManager), then the
//                  uninstall, a check that nothing of Swiff OS is left, and a
//                  restart that shows Windows still starts.
//   switchPlan     the steps that start Swiff OS once (BootNext), start sharing
//                  (Swiff OS first in the boot order, BootNext, restart) and stop
//                  it (Windows first). Each restart into Swiff OS hands it this
//                  PC's machine key again first.
//
// Each step carries its operations (`ops`) and the Windows commands they
// stand for (commandsOf). The installer (rental-exec.cjs) runs the ops through
// one elevated worker (rental-worker.cjs), which runs those same commands; the
// VM test in vm/ carries them out on a disk image instead. A step that changes
// the disk or the firmware says what it changes (`confirm`); the owner agrees
// to all of them at once, with the one OK that starts the install, and the app
// then runs them by itself. Only a restart waits for the owner again.

const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { mokVariables, NV_BS_RT, SHIM_LOCK } = require("./efi.cjs");
const { dbTrusts, lastLog } = require("./measured-boot.cjs");
const { findSteamRoot, libraryPaths, steamPathOnce } = require("./pc.cjs");

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
 * file a partition's contents come from; slot B, the scratch, the keep and the
 * state start empty. The keep is where this app leaves the provisioning
 * (provision.cjs) and Swiff OS keeps it sealed; the state is Swiff OS's
 * persistent state, which it formats itself.
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
    { role: "scratch", type: TYPE.linux, bytes: 3440 * MiB, split: null, attrs: "0x0" },
    { role: "keep", type: TYPE.linux, bytes: 16 * MiB, split: null, attrs: "0x0" },
    { role: "state", type: TYPE.linux, bytes: 3072 * MiB, split: null, attrs: "0x0" },
  ],
};

/** What Swiff OS takes on the disk: 24,192 MiB. */
const SWIFF_OS_BYTES = SWIFF_OS.partitions.reduce((sum, p) => sum + p.bytes, 0);

/** A drive is shrunk only if Windows keeps at least this much free on it afterwards. */
const KEEP_FREE = 16 * GiB;

/** The name Swiff OS mounts the shared games library by (swiff-os/image/mkosi.extra/etc/fstab). */
const GAMES_LABEL = "SWIFFGAMES";

/**
 * What the firmware starts on Swiff OS's own ESP: Ubuntu's shim, which
 * Microsoft's 3rd-party UEFI CA signs. It starts grubx64.efi beside it, which
 * is Swiff's own systemd-boot (signed with Swiff's key), and MokManager
 * (mmx64.efi) when a MOK request is queued. The image set puts all three
 * there (swiff-os/image-set.sh).
 */
const BOOT_PATH = String.raw`\EFI\swiff\shimx64.efi`;

/** The boot menu's name for Swiff OS. */
const BOOT_TITLE = "Lanterel OS";

/**
 * The CA that signs the shim Swiff OS ships (Ubuntu's, from the image's own
 * archive snapshot): the firmware's db must trust it. Microsoft's 2023 CA
 * does not sign Ubuntu's shim yet.
 */
const SHIM_CA = "Microsoft Corporation UEFI CA 2011";

/** BitLocker stays suspended this many restarts: the MOK confirmation's, Windows' after it, and one to spare. */
const BITLOCKER_RESTARTS = 3;

/**
 * The file the install leaves in the root folder of Lanterel OS's ESP for its
 * error reports: the project Lanterel Host reports to (swiff-os/README.md,
 * "Error reports"). Written by esp-file.cjs.
 */
const ERROR_REPORTS_FILE = "LANTEREL.ENV";

/**
 * LANTEREL.ENV's lines for `project`, or null unless it is a PostHog project
 * key and an https origin on posthog.com, as Lanterel OS takes them: the same
 * rule as projectOf in packages/error-tracking, which this CommonJS file
 * cannot import (rental.test.ts checks the two agree on its project-cases.json). The key is PostHog's
 * public client token, which the web app ships to every visitor, never a
 * personal API key: only phc_ keys are written.
 */
function errorReportsFile({ key, host }) {
  if (typeof key !== "string" || typeof host !== "string") return null;
  let url;
  try {
    url = new URL(host.trim());
  } catch {
    return null;
  }
  const onPosthog = url.hostname === "posthog.com" || url.hostname.endsWith(".posthog.com");
  const bare =
    !url.username && !url.password && !url.port && url.pathname === "/" && !url.search && !url.hash;
  if (!/^phc_\w{1,100}$/.test(key.trim()) || url.protocol !== "https:" || !onPosthog || !bare) return null;
  return `LANTEREL_POSTHOG_KEY=${key.trim()}\nLANTEREL_POSTHOG_HOST=${url.origin}\n`;
}

/** Where the install records what it changed, for the switch, the uninstall and a recovery to find. */
const INSTALL_FILE = String.raw`$env:ProgramData\Swiff\rental-install.json`;

// --- Swiff's key, enrolled once as a MOK ----------------------------------------------
//
// shim boots only what Microsoft's db or its MOK list trusts, and Swiff's key
// is in neither until the owner confirms it once, at the PC. Windows queues the
// request as `mokutil --import --simple-hash` would on Linux (efi.cjs). On the
// next start shim opens MokManager, a blue screen where the owner chooses
// Enroll MOK and types the code; MokManager clears the request whether or not
// they did, so a missed screen is queued again with a new code.

/** Swiff's Secure Boot certificate (DER), shipped beside the image: the key that signs systemd-boot and the UKI. */
const MOK_CERT = "swiffos-key.cer";

/** Digits only: the keys least likely to move between keyboard layouts at the firmware's screen. */
const MOK_CODE_DIGITS = 8;

/** A one-time code for the confirmation: 8 random digits. */
const mokCode = (random = crypto.randomInt) =>
  Array.from({ length: MOK_CODE_DIGITS }, () => String(random(10))).join("");

/**
 * The variables that queue `cert` (DER) for enrolment with `code`, as
 * `mokutil --import --simple-hash --timeout -1` writes them: MokNew, an
 * EFI_SIGNATURE_LIST of the one certificate owned by shim; MokAuth, SHA-256 of
 * MokNew then the code as UTF-16LE; and MokTimeout, -1, so MokManager waits
 * for the owner. All non-volatile, with boot and runtime access.
 */
function mokRequest(cert, code) {
  const { MokNew, MokAuth, MokTimeout } = mokVariables(cert, code);
  return { guid: SHIM_LOCK, attributes: NV_BS_RT, MokNew, MokAuth, MokTimeout };
}

const alignUp = (n, to) => Math.ceil(n / to) * to;
const alignDown = (n, to) => Math.floor(n / to) * to;

// --- reading the PC ---------------------------------------------------------------
//
// One PowerShell script, run as the owner: every read here works without
// administrator rights. The Secure Boot db, which Windows reads only for
// administrators, comes from this start's measured-boot log instead, where
// the firmware measured all of it. What needs administrator rights all the
// same (the TPM's endorsement certificate, how far a drive can shrink) is
// checked by the install's first step, which also checks the db once more,
// and is kept in the install's record. Each read is best effort and null
// when it fails.

const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
function Read-Or($block) { try { & $block } catch { $null } }
$shell = New-Object -ComObject Shell.Application
$system = Read-Or { Get-CimInstance Win32_ComputerSystem -ErrorAction Stop }
[pscustomobject]@{
  firmware = $env:firmware_type
  secureBoot = Read-Or { (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot\State' -ErrorAction Stop).UEFISecureBootEnabled }
  tpm2 = Read-Or { @(Get-PnpDevice -InstanceId 'ACPI\MSFT0101*' -Status OK -ErrorAction Stop).Count -gt 0 }
  tpmInfo = Read-Or { (tpmtool getdeviceinformation) -join [Environment]::NewLine }
  securityProperties = @(Read-Or { (Get-CimInstance -Namespace root/Microsoft/Windows/DeviceGuard -ClassName Win32_DeviceGuard -ErrorAction Stop).AvailableSecurityProperties })
  fastStartup = Read-Or { (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -ErrorAction Stop).HiberbootEnabled }
  gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { [pscustomobject]@{ name = $_.Name; pnp = $_.PNPDeviceID } })
  disks = @(Get-Disk | ForEach-Object { [pscustomobject]@{ number = $_.Number; style = [string]$_.PartitionStyle; size = $_.Size; sector = $_.LogicalSectorSize; bus = [string]$_.BusType; system = $_.IsSystem } })
  partitions = @(Get-Partition | ForEach-Object { [pscustomobject]@{ disk = $_.DiskNumber; number = $_.PartitionNumber; letter = [string]$_.DriveLetter; type = $_.GptType; id = [string]$_.Guid; offset = $_.Offset; size = $_.Size } })
  volumes = @(Get-Volume | Where-Object DriveLetter | ForEach-Object { [pscustomobject]@{ letter = [string]$_.DriveLetter; fs = $_.FileSystem; label = $_.FileSystemLabel; size = $_.Size; free = $_.SizeRemaining; fixed = ([string]$_.DriveType -eq 'Fixed'); bitlocker = $shell.NameSpace("$($_.DriveLetter):").Self.ExtendedProperty('System.Volume.BitLockerProtection') } })
  bios = Read-Or { (Get-CimInstance Win32_BIOS -ErrorAction Stop).Manufacturer }
  maker = $system.Manufacturer
  model = $system.Model
  cpu = Read-Or { @(Get-CimInstance Win32_Processor -ErrorAction Stop)[0].Manufacturer }
  install = Read-Or { Get-Content -LiteralPath "$env:ProgramData\Swiff\rental-install.json" -Raw -ErrorAction Stop | ConvertFrom-Json }
  check = Read-Or { Get-Content -LiteralPath "$env:ProgramData\Swiff\rental-check.json" -Raw -ErrorAction Stop | ConvertFrom-Json }
  lastLive = Read-Or { Get-Content -LiteralPath "$env:ProgramData\Swiff\last-live.json" -Raw -ErrorAction Stop | ConvertFrom-Json }
} | ConvertTo-Json -Compress -Depth 6
`;

/** Run a PowerShell script as the owner, unelevated, and resolve with what it prints. */
async function powershell(script) {
  const { stdout } = await promisify(execFile)(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { timeout: 90_000, windowsHide: true, maxBuffer: 1024 * 1024 },
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

const GUID_TEXT = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const guidOrNull = (v) => (GUID_TEXT.test(str(v)) ? str(v).toLowerCase() : null);
const countOf = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/**
 * A boot entry as the install records it: by what it starts (the partition's
 * GPT id and the file), never by its Boot#### number, which firmware changes.
 * A record from before (a number) still says there is one: the worker turns it
 * into this on its next start.
 */
function loaderOf(v) {
  if (Number.isInteger(v) && v >= 0 && v <= 0xffff) return { partition: null, path: null };
  if (!v || typeof v !== "object" || !str(v.path)) return null;
  return { partition: guidOrNull(v.partition), path: str(v.path) };
}

/**
 * What an install recorded so far (rental-install.json, which only the
 * elevated worker writes), checked; null when nothing was installed. Every
 * field is what the install changed, so the uninstall can put it back.
 */
function installOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const s = raw.shrink;
  return {
    complete: raw.complete === true,
    disk: countOf(raw.disk),
    bitlocker: letterOf(raw.bitlocker),
    fastStartup: raw.fastStartup === true,
    shrink:
      s && letterOf(s.letter) && countOf(s.partition) && num(s.from) && num(s.to)
        ? { letter: letterOf(s.letter), partition: s.partition, from: s.from, to: s.to }
        : null,
    partitions: list(raw.partitions)
      .filter((p) => guidOrNull(p?.id) && num(p?.offset) !== null && num(p?.bytes))
      .map((p) => ({ role: str(p.role), id: guidOrNull(p.id), offset: p.offset, bytes: p.bytes })),
    bootEntry: loaderOf(raw.bootEntry),
    windowsEntry: loaderOf(raw.windowsEntry),

    labels: list(raw.labels)
      .filter((l) => letterOf(l?.letter) && typeof l.from === "string")
      .map((l) => ({ letter: letterOf(l.letter), from: l.from })),
    mok: raw.mok === true,
  };
}

/** The script's output as plain, checked facts. Anything it could not read is null. */
function factsOf(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const secureBoot = num(r.secureBoot);
  const fastStartup = num(r.fastStartup);
  const security = list(r.securityProperties).filter((v) => num(v) !== null);
  const cpu = str(r.cpu).toLowerCase();
  return {
    uefi: str(r.firmware) ? str(r.firmware).toUpperCase() === "UEFI" : null,
    secureBoot: secureBoot === null ? null : secureBoot === 1,
    // Whether the Secure Boot db trusts SHIM_CA (readRental, from the measured-boot log).
    db: typeof r.db === "boolean" ? r.db : null,
    // Who made the firmware and the PC: where its settings are, and the key that opens it.
    vendor: { bios: str(r.bios), maker: str(r.maker), model: str(r.model) },
    cpu: cpu.includes("amd") ? "amd" : cpu.includes("intel") ? "intel" : null,
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
        id: guidOrNull(guidOf(p.id)),
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
    install: installOf(r.install),
    // What the install's first step last read as administrator (rental-check.json).
    checked: checkedOf(r.check),
  };
}

/** What the administrator side last read of the TPM (rental-check.json), or null; a record from before has no certificate. */
function checkedOf(check) {
  if (!check || typeof check !== "object" || typeof check.ek !== "boolean") return null;
  const certificate = typeof check.certificate === "string" && check.certificate ? check.certificate : null;
  return {
    ek: check.ek,
    certificate,
    intermediates: certificate ? list(check.intermediates).filter((c) => typeof c === "string" && c) : [],
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
  // Swiff OS's ESP is a FAT with 512-byte sectors (swiff-os/image-set.sh): only such disks take it.
  const disks = facts.disks.filter((d) => d.gpt && !d.usb && d.sector === 512);
  // A system disk always has partitions: none read at all, or none for it, means the read failed,
  // not free space. A blank data disk with none, beside disks that were read, is real free space.
  const read = (disk) =>
    facts.partitions.length > 0 && (!disk.system || facts.partitions.some((p) => p.disk === disk.number));
  const free = disks.filter(read).flatMap((disk) =>
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
  const seen = new Set();
  for (const library of [root, ...libraryPaths(vdf)]) {
    const key = path.win32.normalize(library).replace(/\\+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
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
/** Swiff OS is installed: the install recorded that it finished. */
const installedOf = (facts) => facts.install?.complete === true;

/**
 * The last live run in Swiff OS (last-live.json, which swiff-hostd leaves for
 * Windows), checked; null when there is none or it does not read as one.
 */
function lastLiveOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const at = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : num(v));
  const from = at(raw.from);
  const to = at(raw.to);
  const sessions = countOf(raw.sessions);
  if (from === null || to === null || to < from || sessions === null) return null;
  const early = countOf(raw.early) ?? 0;
  return { from, to, sessions, early: Math.min(early, sessions), earned: num(raw.earned) };
}

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
    lastLive: lastLiveOf(raw?.lastLive),
  };
}

/** What rental mode needs from this PC, read fresh; null where it cannot be read (off Windows). */
async function readRental({
  platform = process.platform,
  run = powershell,
  steamPath = steamPathOnce,
  libraries,
  log = lastLog,
  ...options
} = {}) {
  if (platform !== "win32") return null;
  try {
    const facts = JSON.parse(await run(SCRIPT));
    const boot = log();
    if (boot) facts.db = dbTrusts(boot.events, SHIM_CA);
    return rentalOf(
      facts,
      libraries ?? libraryDrives({ platform, steamPath: await steamPath(), ...options }),
    );
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
      throw new Error(`The image's partition ${i + 1} is not Lanterel OS's ${want.role}.`);
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

const FAST_STARTUP_KEY = String.raw`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Power`;

/**
 * The TPM's endorsement key certificates, one `ek-cert:` line each (base64 DER): the ones in the
 * TPM, then the ones Windows fetched from its maker (Intel PTT keeps its certificate online). Reading
 * them needs administrator rights; ekOf picks the EK's own and the intermediates beside it.
 */
const EK_LINES = [
  "try { $info = Get-TpmEndorsementKeyInfo -ErrorAction Stop } catch { $info = $null }",
  "foreach ($c in @($info.ManufacturerCertificates) + @($info.AdditionalCertificates)) { if ($c) { 'ek-cert: ' + [Convert]::ToBase64String($c.RawData) } }",
];

/** The most intermediates the server takes beside an EK certificate (server/src/tpm-verifier.ts). */
const MAX_EK_INTERMEDIATES = 8;

/**
 * The EK keys swiff-attest makes, in the order it tries them (swiff-os/hostd/src/attest.ts): RSA 2048,
 * else ECC P-256. A certificate for any other key Node reads is for an EK it never uses; one whose key
 * Node cannot read (null: an RSAES-OAEP key, say) comes last, as it may still be either.
 */
const EK_KEYS = [
  (key) => key?.asymmetricKeyType === "rsa" && key.asymmetricKeyDetails?.modulusLength === 2048,
  (key) => key?.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1",
  (key) => key === null,
];

/** A certificate's public key, or null when Node cannot read it. */
function keyOf(cert) {
  try {
    return cert.publicKey;
  } catch {
    return null;
  }
}

/**
 * The TPM's EK certificate in `out`, what EK_LINES printed: the first that is no CA's for the EK
 * swiff-attest uses (EK_KEYS), the TPM's own before Windows' downloads, with the intermediate CAs
 * beside it (never a self-signed root, which the server must already have). Null when there is none.
 */
function ekOf(out) {
  const certs = [];
  for (const line of String(out).split(/\r?\n/)) {
    const b64 = line.startsWith("ek-cert: ") ? line.slice(9).trim() : "";
    if (!b64 || certs.some((c) => c.b64 === b64)) continue;
    try {
      certs.push({ b64, cert: new crypto.X509Certificate(Buffer.from(b64, "base64")) });
    } catch {
      // Not a certificate: Windows keeps others beside them, which are no use here.
    }
  }
  const leaves = certs.filter((c) => !c.cert.ca).map((c) => ({ ...c, key: keyOf(c.cert) }));
  const leaf = EK_KEYS.map((fits) => leaves.find((c) => fits(c.key))).find(Boolean);
  if (!leaf) return null;
  return {
    certificate: leaf.b64,
    intermediates: certs
      .filter((c) => c.cert.ca && !c.cert.checkIssued(c.cert))
      .slice(0, MAX_EK_INTERMEDIATES)
      .map((c) => c.b64),
  };
}

/** Runs a console tool and fails on its exit code, which PowerShell would ignore. */
const tool = (line) =>
  `${line}; if ($LASTEXITCODE) { throw '${line.split(" ")[0]} failed: exit code ' + $LASTEXITCODE }`;

/**
 * The PowerShell lines an operation is, for the operations that are Windows
 * commands: the elevated worker runs exactly these, and the plan shows them.
 * Null for the operations the worker does itself, in bytes (the partition
 * table, the image, the firmware variables).
 */
function shellOf(op) {
  switch (op.op) {
    case "check":
      return [
        "if (-not (Confirm-SecureBootUEFI)) { throw 'Secure Boot is off.' }",
        "if (-not (Get-Tpm).TpmReady) { throw 'The TPM is not ready.' }",
        `if ([Text.Encoding]::ASCII.GetString((Get-SecureBootUEFI db).Bytes) -notmatch ${q(SHIM_CA)}) { throw ${q(`The firmware does not trust the ${SHIM_CA}, which signs the shim Lanterel OS starts from.`)} }`,
        ...(op.shrink
          ? [
              `if ((Get-PartitionSupportedSize -DiskNumber ${op.shrink.disk} -PartitionNumber ${op.shrink.partition}).SizeMin -gt ${op.shrink.size}) { throw '${op.shrink.letter}: cannot shrink by ${gb(SWIFF_OS_BYTES)}.' }`,
            ]
          : []),
        // The EK certificate, for the app to register at Go live; the install itself does not need it.
        ...EK_LINES,
      ];
    case "ek":
      return [
        "try { $tpm = Get-Tpm -ErrorAction Stop } catch { $tpm = $null }",
        "if (-not $tpm.TpmReady) { throw 'The TPM is not ready.' }",
        ...EK_LINES,
      ];
    case "bitlocker-suspend":
      return [tool(`manage-bde -protectors -disable ${op.letter}: -RebootCount ${op.restarts}`)];
    case "bitlocker-resume":
      return [tool(`manage-bde -protectors -enable ${op.letter}:`)];
    case "fast-startup-off":
    case "fast-startup-on":
      return [
        tool(
          `reg add "${FAST_STARTUP_KEY}" /v HiberbootEnabled /t REG_DWORD /d ${op.op === "fast-startup-on" ? 1 : 0} /f`,
        ),
      ];
    case "shrink":
      return [`Resize-Partition -DiskNumber ${op.disk} -PartitionNumber ${op.partition} -Size ${op.size}`];
    case "grow":
      return [
        `$max = (Get-PartitionSupportedSize -DiskNumber ${op.disk} -PartitionNumber ${op.partition}).SizeMax`,
        `Resize-Partition -DiskNumber ${op.disk} -PartitionNumber ${op.partition} -Size ([Math]::Min($max, ${op.size}))`,
      ];
    case "label":
      return [`Set-Volume -DriveLetter ${op.letter} -NewFileSystemLabel ${q(op.label)}`];
    case "restart":
      return [tool("shutdown /r /t 5")];
    default:
      return null;
  }
}

/** What an operation does, as the commands it is or, for the worker's own byte-level ones, in words. */
function commandsOf(op) {
  const shell = shellOf(op);
  if (shell) return shell;
  switch (op.op) {
    case "image-check":
      return [
        "# Check that Lanterel signed Lanterel OS's image set (swiffos.json), that its certificate is Lanterel's, and that each image file has the SHA-256 it lists, where it is, before anything changes",
        "# Each image is hashed again as it is copied into the administrators' folder, as it is written, and as it is read back",
      ];
    case "gpt-add":
      return [
        `# Lanterel Host's GPT writer (gpt.cjs) on disk ${op.disk} (\\\\.\\GLOBALROOT\\Device\\Harddisk${op.disk}\\Partition0): types, ids, names and attributes as in the image`,
        "#   (the boot partition is typed Linux data until it is written: Windows would mount it as an ESP mid-write)",
        ...op.partitions.map(
          (p) =>
            `#   ${p.role}: offset ${p.offset}, ${p.bytes} bytes, type ${p.type}, id ${p.id ?? "(image's)"}, name ${p.name ?? "(image's)"}, attributes ${p.attrs}`,
        ),
        `Update-Disk -Number ${op.disk}`,
      ];
    case "gpt-remove":
      return [
        `# Lanterel Host's GPT writer (gpt.cjs) on disk ${op.disk} (\\\\.\\GLOBALROOT\\Device\\Harddisk${op.disk}\\Partition0): remove only these, each checked for Lanterel OS's type, id, offset and size`,
        ...op.partitions.map((p) => `#   ${p.role}: id ${p.id}, offset ${p.offset}, ${p.bytes} bytes`),
        `Update-Disk -Number ${op.disk}`,
      ];
    case "write":
      return [
        `# Write ${splitFile(op.source)} to disk ${op.disk} at offset ${op.offset} (${op.bytes} bytes), then read it back against its SHA-256`,
      ];
    case "esp-file":
      return [
        `# Write ${ERROR_REPORTS_FILE} into the root folder of the boot partition at offset ${op.offset}, as its FAT has it: where Lanterel OS reports its errors`,
        ...errorReportsFile(op)
          .trimEnd()
          .split("\n")
          .map((line) => `#   ${line}`),
      ];
    case "boot-entry":
      return [
        `# Lanterel Host's GPT writer: the boot partition at offset ${op.offset} gets the EFI system partition type, then Update-Disk -Number ${op.disk}`,
        `# Boot####, the first free number: "${op.title}", HD(the ESP at offset ${op.offset}, GPT, its id)/File(${op.path})`,
        "# BootOrder: as it was, with it last",
      ];
    case "boot-entry-remove":
      return ["# Lanterel OS's Boot#### deleted, and taken out of BootOrder and BootNext"];
    case "boot-first":
      return [`# BootOrder: ${op.entry === "swiff" ? "Lanterel OS" : "Windows Boot Manager"} first`];
    case "boot-next":
      return ["# BootNext: Lanterel OS's Boot####, for the next start only"];
    case "mok-import":
      return [
        `# Lanterel Host's firmware-variable writer, as administrator: mokutil --import ${op.cert} --simple-hash, from Windows`,
        `#   ${mokVar("MokNew")}: ${op.cert} as an EFI_SIGNATURE_LIST (X.509, owner shim), non-volatile, boot and runtime access`,
        `#   ${mokVar("MokAuth")}: SHA-256 of MokNew, then the one-time code in UTF-16LE, the same attributes`,
      ];
    case "mok-delete":
      return [
        `# Lanterel Host's firmware-variable writer, as administrator: mokutil --delete ${op.cert} --simple-hash, from Windows`,
        `#   ${mokVar("MokDel")} and ${mokVar("MokDelAuth")}, the same way, with a new one-time code`,
      ];
    case "mok-cancel":
      return [
        `# ${mokVar("MokNew")}, ${mokVar("MokAuth")}, ${mokVar("MokDel")}, ${mokVar("MokDelAuth")} and ${mokVar("MokTimeout")} deleted, if a request is still queued`,
      ];
    case "removal-check":
      return [
        `# Read back, as administrator: no Boot#### starts ${BOOT_PATH}, BootNext names none, no request for shim is left`,
        ...(op.disk !== null
          ? [
              `#   and disk ${op.disk}'s partition table has none of Lanterel OS's partitions: ${op.ids.join(", ")}`,
            ]
          : []),
      ];
    case "provision":
      return [
        "# Lanterel Host's provisioning record (provision.cjs): the server, this PC's machine id and its machine key, written raw at the start of Lanterel OS's keep partition, then read back",
        "#   Lanterel OS seals it to this PC's TPM at its next start and zeroes it there; the machine key is never shown or logged",
      ];
    case "installed":
      return [`# Record in ${INSTALL_FILE} that Lanterel OS is installed`];
    case "forget":
      return [`Remove-Item ${INSTALL_FILE}`];
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}

/** A plan step: its commands come from its operations. `confirm` says what the owner agrees to before it runs. */
const step = (id, title, ops, confirm = null) => ({
  id,
  title,
  confirm,
  ops,
  commands: ops.flatMap(commandsOf),
});

/**
 * Hand Swiff OS what its agent needs to offer this PC: the server, the machine
 * id and the machine key (provision.cjs). The op names none of them: the app
 * fills them in as the step runs, from the machine key it keeps encrypted, so
 * neither the plan on screen nor a report carries the key.
 */
const provisionStep = () =>
  step(
    "provision",
    "Give Lanterel OS this PC's machine key",
    [{ op: "provision" }],
    "Lanterel OS gets this PC's machine id and machine key on its own partition, and at its next start seals them to this PC's TPM, so only Lanterel OS on this PC can read them.",
  );

/**
 * The steps that install Swiff OS next to Windows, for the target the owner
 * chose (an id from targetsOf). `layout` is the image set's (image-set.cjs);
 * without it the ids and names show as the image's. `errorReports`, the
 * project Lanterel Host reports to (null when its build has none or the PC
 * says DO_NOT_TRACK), goes onto Lanterel OS's ESP for it to report to as well.
 */
function installPlan(
  rental,
  { target: targetId, layout = PREVIEW_LAYOUT, code = mokCode(), errorReports = null } = {},
) {
  const { facts, games } = rental;
  // An install that stopped after adding its partitions goes on in them: their room is made and
  // laid out already, so trying again writes Swiff OS into them from the start.
  const made = facts.install && !facts.install.complete && facts.install.disk !== null ? facts.install : null;
  const room = made?.partitions.length ? made.partitions[0] : null;
  // A target the owner chose that is no longer there is refused, never swapped for another drive.
  const target = room
    ? {
        id: `made:${made.disk}:${room.offset}`,
        kind: "free",
        disk: made.disk,
        sector: 512,
        start: room.offset,
      }
    : targetId
      ? rental.targets.find((t) => t.id === targetId)
      : rental.targets[0];
  if (targetId && !target) throw new Error("The drive you chose for Lanterel OS is no longer available.");
  if (!target) throw new Error(`This PC has no drive with ${gb(SWIFF_OS_BYTES)} to spare.`);
  const disk = target.disk;
  const parts = placed(layout, target.start);
  const esp = parts.find((p) => p.role === "esp");
  const steps = [];

  const shrink =
    target.kind === "shrink"
      ? { disk, partition: target.partition, size: target.size, letter: target.letter }
      : null;
  steps.push(
    step("check", "Check the Secure Boot keys and the TPM (asks for administrator)", [
      { op: "check", ...(shrink ? { shrink } : {}) },
      { op: "image-check" },
    ]),
  );
  // Windows' own drive: BitLocker on it would ask for its recovery key after the firmware changes.
  if (bitlockerOn(rental)) steps.push(bitlockerStep(BITLOCKER_RESTARTS));
  if (facts.fastStartup !== false) {
    steps.push(
      step("fast-startup", "Turn off Fast Startup so Lanterel OS can read your drives", [
        { op: "fast-startup-off" },
      ]),
    );
  }
  if (shrink) {
    steps.push(
      step(
        "room",
        `Shrink ${target.letter}: by ${gb(SWIFF_OS_BYTES)}`,
        [{ op: "shrink", ...shrink }],
        `${target.letter}: gives ${gb(SWIFF_OS_BYTES)} from its end to Lanterel OS and keeps its files. Back up anything important first.`,
      ),
    );
  }
  if (!room)
    steps.push(
      step(
        "partitions",
        `Create ${parts.length} partitions for Lanterel OS on disk ${disk}`,
        [
          {
            op: "gpt-add",
            disk,
            partitions: parts.map(({ role, type, id, name, attrs, offset, bytes }) => ({
              role,
              type,
              id,
              name,
              attrs,
              offset,
              bytes,
            })),
          },
        ],
        `Disk ${disk}'s partition table gets Lanterel OS's ${parts.length} partitions, in the ${gb(SWIFF_OS_BYTES)} ${shrink ? `${target.letter}: gave` : "that was free"}.`,
      ),
    );
  // Before the long write: a PC without its machine key in the app stops here, with nothing to write again.
  steps.push(provisionStep());
  steps.push(
    step(
      "write",
      "Copy Lanterel OS onto them",
      [
        ...parts
          .filter((p) => p.split)
          .map((p) => ({ op: "write", disk, offset: p.offset, bytes: p.bytes, source: p.split })),
        // After the ESP is written and read back, and before it is typed ESP, which Windows would mount.
        ...(errorReports && errorReportsFile(errorReports)
          ? [{ op: "esp-file", disk, offset: esp.offset, key: errorReports.key, host: errorReports.host }]
          : []),
      ],
      "Lanterel OS is written into its new partitions, and read back to check it. Nothing outside them is touched.",
    ),
  );
  steps.push(
    step(
      "boot-entry",
      "Add Lanterel OS to the boot menu, after Windows",
      [{ op: "boot-entry", disk, offset: esp.offset, path: BOOT_PATH, title: BOOT_TITLE }],
      "The PC's firmware gets a Lanterel OS entry, last in its boot order: Windows still starts first.",
    ),
  );
  const stale = games
    ? facts.volumes.filter((v) => v.label === GAMES_LABEL && v.letter !== games.letter)
    : [];
  if (stale.length) {
    steps.push(
      step(
        "games-clear",
        `Take the name ${GAMES_LABEL} off ${stale.map((v) => `${v.letter}:`).join(", ")}, so only your games drive has it`,
        stale.map((v) => ({ op: "label", letter: v.letter, label: "" })),
      ),
    );
  }
  if (games && games.label !== GAMES_LABEL) {
    steps.push(
      step("games", `Label ${games.letter}: ${GAMES_LABEL} so Lanterel OS finds your games`, [
        { op: "label", letter: games.letter, label: GAMES_LABEL },
      ]),
    );
  }
  // Recorded as installed before BootNext is set: the restart's blue screen is the install's last part.
  const [mok, restart] = mokSteps(code);
  const [importKey, bootNext] = mok.ops;
  const ops = [importKey, { op: "installed" }, bootNext];
  steps.push({ ...mok, ops, commands: ops.flatMap(commandsOf) });
  steps.push(restart);
  return { kind: "install", target, steps, mok: { code } };
}

/** BitLocker protects C:, Windows' own drive. */
const bitlockerOn = (rental) => rental?.facts.volumes.find((v) => v.letter === "C")?.bitlocker === "on";

/**
 * The drives BitLocker protects that a change to the boot can ask the
 * recovery key of: C:, Windows' own, and the games drive Swiff OS shares.
 * Before any boot change the owner keeps that key somewhere they can reach it
 * (recovery-key.cjs); Swiff never reads it.
 */
function bitlockerDrives(rental) {
  if (!rental) return [];
  const letters = ["C", ...(rental.games ? [rental.games.letter] : [])];
  return [...new Set(letters)].filter(
    (l) => rental.facts.volumes.find((v) => v.letter === l)?.bitlocker === "on",
  );
}

/** The plans that change what the PC starts: each waits for the BitLocker recovery key to be saved. */
const BOOT_CHANGES = new Set(["install", "uninstall", "mok", "unkey", "remove", "once", "start"]);

/**
 * Suspend BitLocker on C: for `restarts` restarts: a start that goes through
 * shim and on into Windows in the same power-on (Continue boot at MokManager)
 * changes PCR 7, and BitLocker would ask for its recovery key.
 */
const bitlockerStep = (restarts) =>
  step(
    "bitlocker",
    `Suspend BitLocker on C: for the next ${restarts} restarts`,
    [{ op: "bitlocker-suspend", letter: "C", restarts }],
    "C: stays encrypted, but its key is left open for the restarts ahead. Have your BitLocker recovery key at hand.",
  );

/** The firmware variable's PowerShell name: MokNew-605dab50-…. */
const mokVar = (name) => `${name}-${SHIM_LOCK}`;

/**
 * Queue Swiff's key with a one-time code and point the next start at Swiff
 * OS, where shim shows the confirmation; then restart once. After it the PC
 * starts Windows again, still first in the boot order. Also what the owner
 * runs again after missing the screen, with a new code.
 *
 * The restart is its own last step, the one that asks the owner (`confirm`):
 * the app runs everything before it by itself and restarts only when the
 * owner, code written down, says Restart now. BootNext is set before that,
 * so a restart from Windows' own menu reaches the blue screen too.
 */
function mokSteps(code) {
  return [
    step("mok", "Make a one-time code for Lanterel's key", [
      { op: "mok-import", cert: MOK_CERT, code },
      { op: "boot-next", entry: "swiff" },
    ]),
    step(
      "mok-restart",
      "Restart once to confirm the key",
      [{ op: "restart" }],
      "The PC restarts now, once, to the blue screen. Save your work first.",
    ),
  ];
}

/**
 * Confirm Swiff's key again, once installed: after a missed blue screen, the
 * same request with a new code, BitLocker on C: suspended for its restart and
 * the one after (`rental`, the PC's read, says whether it is on). Whether the
 * key is enrolled cannot be read from Windows: shim publishes MokListRT only
 * to the system it starts.
 */
function mokPlan(code = mokCode(), rental = null) {
  return {
    kind: "mok",
    steps: [...(bitlockerOn(rental) ? [bitlockerStep(2)] : []), ...mokSteps(code)],
    mok: { code },
  };
}

/**
 * The steps that take Swiff OS off this PC again, from what the install
 * recorded (facts.install): its boot entry, its partitions, C:'s space, the
 * names and settings it changed. An install that stopped half way is undone
 * by the same steps: each is there only for what was done. Swiff's key stays
 * enrolled: removing it (keyRemovalPlan) needs Swiff OS's boot partition, so
 * it comes first.
 */
function uninstallPlan(rental) {
  const install = rental.facts.install;
  if (!install) throw new Error("Lanterel OS is not installed on this PC.");
  const steps = [];
  steps.push(
    step(
      "boot-entry",
      "Take Lanterel OS out of the boot menu",
      [...(install.bootEntry !== null ? [{ op: "boot-entry-remove" }] : []), { op: "mok-cancel" }],
      install.bootEntry !== null ? "The PC's firmware forgets its Lanterel OS entry." : null,
    ),
  );
  if (install.partitions.length && install.disk !== null) {
    steps.push(
      step(
        "partitions",
        `Remove Lanterel OS's ${install.partitions.length} partitions from disk ${install.disk}`,
        [{ op: "gpt-remove", disk: install.disk, partitions: install.partitions }],
        "Lanterel OS and everything on its partitions is deleted. Windows' own partitions are not touched.",
      ),
    );
  }
  if (install.shrink && install.disk !== null) {
    const { letter, partition, from, to } = install.shrink;
    steps.push(
      step(
        "room",
        `Give ${letter}: its ${gb(from - to)} back`,
        [{ op: "grow", disk: install.disk, partition, letter, size: from }],
        `${letter}: grows back to its size before Lanterel OS, into the space Lanterel OS left.`,
      ),
    );
  }
  if (install.labels.length) {
    steps.push(
      step(
        "labels",
        `Give ${install.labels.map((l) => `${l.letter}:`).join(", ")} back ${install.labels.length === 1 ? "its name" : "their names"}`,
        install.labels.map((l) => ({ op: "label", letter: l.letter, label: l.from })),
      ),
    );
  }
  if (install.fastStartup)
    steps.push(step("fast-startup", "Turn Fast Startup back on", [{ op: "fast-startup-on" }]));
  if (install.bitlocker)
    steps.push(
      step("bitlocker", `Resume BitLocker on ${install.bitlocker}:`, [
        { op: "bitlocker-resume", letter: install.bitlocker },
      ]),
    );
  steps.push(step("forget", "Forget the install", [{ op: "forget" }]));
  return { kind: "uninstall", steps };
}

/**
 * Ask the PC to stop trusting Swiff's key: MokManager removes it once the
 * owner confirms at the PC with a new code, as they confirmed it in (BitLocker
 * suspended as for mokPlan). shim and
 * MokManager live on Swiff OS's boot partition, so this runs while Swiff OS
 * is still installed, before the uninstall.
 */
function keyRemovalPlan(code = mokCode(), rental = null) {
  return {
    kind: "unkey",
    steps: [
      ...(bitlockerOn(rental) ? [bitlockerStep(2)] : []),
      step("mok-remove", "Make a one-time code to remove Lanterel's key", [
        { op: "mok-delete", cert: MOK_CERT, code },
        { op: "boot-next", entry: "swiff" },
      ]),
      step(
        "restart",
        "Restart once to confirm the removal",
        [{ op: "restart" }],
        "The PC restarts now, once, to the blue screen. Save your work first.",
      ),
    ],
    mok: { code },
  };
}

/**
 * Remove Swiff OS: the owner's one action, carried out in two parts, each its
 * own plan (`phase`), because Swiff's key can only come off through
 * MokManager, which lives on Swiff OS's own boot partition.
 *
 *   key   with Swiff's key (maybe) enrolled: BitLocker on C: suspended for
 *         the restart, MokDel queued with a new code, BootNext into
 *         MokManager, and the restart, where the owner confirms the removal.
 *   disk  the uninstall (uninstallPlan), then a check as administrator that
 *         no boot entry, request or partition of Swiff OS is left, and a
 *         restart that shows Windows still starts: the app checks the next
 *         start against what the removal recorded (rental-removal.cjs).
 *
 * `key` says whether to start with the key; the caller knows (main: the
 * install finished and the key was not already taken off, or never went in).
 */
function removePlan(rental, { key = false, code = mokCode() } = {}) {
  const install = rental?.facts.install;
  if (!install) throw new Error("Lanterel OS is not installed on this PC.");
  if (key && install.partitions.length && install.bootEntry !== null) {
    const unkey = keyRemovalPlan(code, rental);
    return { ...unkey, kind: "remove", phase: "key" };
  }
  const { steps } = uninstallPlan(rental);
  const forget = steps.pop();
  const ids = install.partitions.map((p) => p.id);
  steps.push(
    step("verify", "Check nothing of Lanterel OS is left", [
      { op: "removal-check", disk: install.disk, ids },
    ]),
    forget,
    step(
      "restart",
      "Restart once to check Windows starts",
      [{ op: "restart" }],
      "The PC restarts now, once, into Windows. Save your work first.",
    ),
  );
  return { kind: "remove", phase: "disk", steps };
}

/** Why going live stopped at its TPM step: the TPM's certificate is not the one the app registered. */
const EK_UNREGISTERED = "This PC's TPM certificate isn't registered with Lanterel yet.";

/**
 * Going live reads the TPM's EK certificate first, as administrator. With `registered` (the
 * certificate the app registered with the server, or null for none), the step stops the plan when
 * the TPM has another one (a new board, a new TPM), before anything changes what the PC starts: the
 * app registers the one it read, then goes live again. Without it (the console installer), it reads.
 */
const EK_STEP = (registered) =>
  step("ek", "Read this PC's TPM certificate", [
    { op: "ek", ...(registered === undefined ? {} : { registered }) },
  ]);

/**
 * Start Swiff OS once: BootNext, then restart; whatever happens there, the
 * next start is Windows again. Start sharing: Swiff OS first in the boot
 * order, so a power cut or a crash comes back to it, and BootNext for this
 * restart. Stop: Windows first again. `registered`: the EK the app registered, for EK_STEP.
 */
function switchPlan(kind, { registered } = {}) {
  if (kind === "once") {
    return {
      kind,
      steps: [
        EK_STEP(registered),
        provisionStep(),
        step("once", "Start Lanterel OS on the next restart only", [{ op: "boot-next", entry: "swiff" }]),
        step(
          "restart",
          "Restart into Lanterel OS",
          [{ op: "restart" }],
          "The PC restarts into Lanterel OS now. Its next restart after that starts Windows.",
        ),
      ],
    };
  }
  if (kind === "start") {
    return {
      kind,
      steps: [
        EK_STEP(registered),
        provisionStep(),
        step("boot-order", "Put Lanterel OS first in the boot order", [{ op: "boot-first", entry: "swiff" }]),
        step("boot-next", "Start Lanterel OS on this restart", [{ op: "boot-next", entry: "swiff" }]),
        step(
          "restart",
          "Restart into rental mode",
          [{ op: "restart" }],
          "The PC restarts into Lanterel OS now, and keeps starting it until you stop sharing.",
        ),
      ],
    };
  }
  return {
    kind: "stop",
    steps: [
      step("boot-order", "Put Windows first in the boot order again", [
        { op: "boot-first", entry: "windows" },
      ]),
    ],
  };
}

module.exports = {
  TYPE,
  SWIFF_OS,
  SWIFF_OS_BYTES,
  KEEP_FREE,
  GAMES_LABEL,
  MOK_CERT,
  SHIM_LOCK,
  SHIM_CA,
  BOOT_PATH,
  BOOT_TITLE,
  ERROR_REPORTS_FILE,
  BITLOCKER_RESTARTS,
  BOOT_CHANGES,
  SCRIPT,
  gpuVendor,
  bitlockerState,
  tpmMaker,
  factsOf,
  installOf,
  freeSpans,
  targetsOf,
  libraryDrives,
  gamesDriveOf,
  lastLiveOf,
  rentalOf,
  readRental,
  imageLayout,
  splitFile,
  mokCode,
  mokRequest,
  mokSteps,
  mokPlan,
  keyRemovalPlan,
  removePlan,
  bitlockerDrives,
  shellOf,
  commandsOf,
  ekOf,
  errorReportsFile,
  installPlan,
  uninstallPlan,
  switchPlan,
  EK_UNREGISTERED,
};
