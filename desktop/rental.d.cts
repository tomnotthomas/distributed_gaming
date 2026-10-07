// Types for rental.cjs, so the renderer and its tests can use its results and helpers.

import type { Gpt } from "./gpt.cjs";
import type { Recovery } from "./recovery-key.cjs";
import type { KeyState } from "./rental-key.cjs";
import type { Removal } from "./rental-removal.cjs";

export type GpuVendor = "nvidia" | "amd" | "intel" | "other";

/** What rental mode needs from this PC, as read without administrator rights. Null where it could not be read. */
export type RentalFacts = {
  uefi: boolean | null;
  secureBoot: boolean | null;
  /** Whether the Secure Boot db trusts the CA that signs Swiff OS's shim (SHIM_CA), from this start's measured-boot log. */
  db: boolean | null;
  /** Who made the firmware (Win32_BIOS) and the PC (Win32_ComputerSystem); empty when not read. */
  vendor: { bios: string; maker: string; model: string };
  cpu: "amd" | "intel" | null;
  tpm: { present: boolean | null; maker: string | null; firmware: boolean | null };
  iommu: boolean | null;
  fastStartup: boolean | null;
  gpus: { name: string; vendor: GpuVendor }[];
  disks: { number: number; gpt: boolean; size: number; sector: number; usb: boolean; system: boolean }[];
  partitions: {
    disk: number;
    number: number | null;
    letter: string | null;
    type: string;
    /** The partition's GPT unique id; null when not read. */
    id: string | null;
    offset: number;
    size: number;
  }[];
  volumes: {
    letter: string;
    fs: string;
    label: string;
    size: number;
    free: number;
    fixed: boolean;
    bitlocker: "on" | "off" | null;
  }[];
  install: InstallRecord | null;
  /** What the install's first step last read as administrator: whether the TPM has an endorsement key certificate. */
  checked: { ek: boolean } | null;
};

/** What an install recorded so far (rental-install.json): what it changed, for the uninstall to put back. */
export type InstallRecord = {
  complete: boolean;
  disk: number | null;
  /** The drive whose BitLocker the install suspended. */
  bitlocker: string | null;
  /** Fast Startup was on before the install turned it off. */
  fastStartup: boolean;
  shrink: { letter: string; partition: number; from: number; to: number } | null;
  partitions: { role: string; id: string; offset: number; bytes: number }[];
  /**
   * Swiff OS's boot entry, and Windows' (BootCurrent when the entry was made), by what each
   * starts, never by Boot#### number. Both fields null in a record from before, where only a number was kept.
   */
  bootEntry: BootLoader | null;
  windowsEntry: BootLoader | null;
  labels: { letter: string; from: string }[];
  mok: boolean;
};

/** A boot entry by what it starts: the file, on the partition with this GPT id. */
export type BootLoader = { partition: string | null; path: string | null };

/** Where Swiff OS can go: free space on a disk, or the end of a drive shrunk for it. `start` is in bytes. */
export type RentalTarget =
  | { id: string; kind: "free"; disk: number; sector: number; start: number }
  | {
      id: string;
      kind: "shrink";
      letter: string;
      disk: number;
      sector: number;
      partition: number | null;
      size: number;
      start: number;
      free: number;
      system: boolean;
    };

/** The drive Swiff OS shares the owner's Steam games from. */
export type GamesDrive = {
  letter: string;
  games: number;
  label: string;
  fs: string;
  bitlocker: "on" | "off" | null;
};

export type RentalRead = {
  facts: RentalFacts;
  /** Bytes Swiff OS takes on the disk. */
  need: number;
  targets: RentalTarget[];
  games: GamesDrive | null;
  installed: boolean;
  /** The version of Swiff OS's image set on this PC, which main adds to the read; null when there is none. */
  image?: string | null;
  /** An image set is on this PC, but Swiff did not sign it (image-set.cjs): main adds it with `image`. */
  imageRefused?: boolean;
  /** Where Swiff's key stands as far as the app knows (rental-key.cjs), which main adds; null when it knows nothing. */
  key?: KeyState | null;
  /** The last time the PC was live in Swiff OS, as swiff-hostd leaves it for Windows; null when there is none. */
  lastLive?: LastLive | null;
  /** Remove Swiff OS across its restarts (rental-removal.cjs), which main adds; null when none is under way. */
  removal?: Removal | null;
  /** Whether the BitLocker recovery key still has to be saved before a boot change (recovery-key.cjs), which main adds. */
  recovery?: Recovery;
};

/** A live run in Swiff OS, summed up: when, how many sessions, how many ended early, what it earned (euros). */
export type LastLive = { from: number; to: number; sessions: number; early: number; earned: number | null };

type GptAddPartition = {
  role: string;
  type: string;
  id: string | null;
  name: string | null;
  attrs: string;
  offset: number;
  bytes: number;
};

export type PlanOp =
  | { op: "check"; shrink?: { disk: number; partition: number | null; size: number; letter: string } }
  | { op: "image-check" }
  | { op: "bitlocker-suspend"; letter: string; restarts: number }
  | { op: "bitlocker-resume"; letter: string }
  | { op: "fast-startup-off" }
  | { op: "fast-startup-on" }
  | { op: "shrink"; disk: number; partition: number | null; size: number; letter: string }
  | { op: "grow"; disk: number; partition: number; size: number; letter: string }
  | { op: "gpt-add"; disk: number; partitions: GptAddPartition[] }
  | { op: "gpt-remove"; disk: number; partitions: InstallRecord["partitions"] }
  | { op: "write"; disk: number; offset: number; bytes: number; source: string }
  | { op: "esp-file"; disk: number; offset: number; key: string; host: string }
  | { op: "boot-entry"; disk: number; offset: number; path: string; title: string }
  | { op: "boot-entry-remove" }
  | { op: "label"; letter: string; label: string }
  | { op: "mok-import"; cert: string; code: string }
  | { op: "mok-delete"; cert: string; code: string }
  | { op: "mok-cancel" }
  | { op: "boot-first"; entry: "swiff" | "windows" }
  | { op: "boot-next"; entry: "swiff" }
  | { op: "installed" }
  | { op: "removal-check"; disk: number | null; ids: string[] }
  | { op: "forget" }
  | { op: "restart" };

/**
 * One step of a plan: what it does in words, its operations, and the Windows
 * commands they are. `confirm` says what the owner agrees to before a step
 * that changes the disk or the firmware runs; null for the others.
 */
export type PlanStep = {
  id: string;
  title: string;
  confirm: string | null;
  ops: PlanOp[];
  commands: string[];
};

export type RentalPlan = {
  kind: "install" | "uninstall" | "mok" | "unkey" | "remove" | "once" | "start" | "stop";
  /** Remove Swiff OS's part: its key first (one restart, at MokManager), then the disk. */
  phase?: "key" | "disk";
  target?: RentalTarget;
  steps: PlanStep[];
  /** The one-time code the owner types at the PC to confirm Swiff's key (MOK), or its removal. */
  mok?: { code: string };
};

export type LayoutPartition = {
  role: string;
  type: string;
  bytes: number;
  split: string | null;
  /** GPT attribute bits, as hex: "0x1000000000000000" is read-only. */
  attrs: string;
  id: string | null;
  name: string | null;
};

export const TYPE: Record<"esp" | "root" | "verity" | "linux" | "windowsData", string>;
export const SWIFF_OS: { version: string; partitions: Omit<LayoutPartition, "id" | "name">[] };
export const SWIFF_OS_BYTES: number;
export const KEEP_FREE: number;
export const GAMES_LABEL: string;
export const MOK_CERT: string;
export const SHIM_LOCK: string;
export const SHIM_CA: string;
export const BOOT_PATH: string;
export const BOOT_TITLE: string;
export const ERROR_REPORTS_FILE: string;
export const BITLOCKER_RESTARTS: number;
/** The plan kinds that change what the PC starts: each waits for the BitLocker recovery key. */
export const BOOT_CHANGES: Set<string>;
/** The drives BitLocker protects that a boot change can ask the recovery key of: C:, and the games drive. */
export function bitlockerDrives(rental: RentalRead | null): string[];
export const SCRIPT: string;
/** The graphics vendor from a PCI device id: locale-proof, unlike the names. */
export function gpuVendor(pnp: string): GpuVendor;
/** BitLocker on a drive, from the shell's System.Volume.BitLockerProtection: on, off, or null when unknown. */
export function bitlockerState(value: unknown): "on" | "off" | null;
/** The TPM's maker, from `tpmtool getdeviceinformation`, and whether it is built into the processor. */
export function tpmMaker(info: unknown): { maker: string | null; firmware: boolean | null };
/** The script's output as plain, checked facts. Anything it could not read is null. */
export function factsOf(raw: unknown): RentalFacts;
/** What an install recorded so far (rental-install.json), checked; null when nothing was installed. */
export function installOf(raw: unknown): InstallRecord | null;
/** The unused stretches of a GPT disk, MiB-aligned, with room left for the backup table at the end. */
export function freeSpans(
  disk: RentalFacts["disks"][number],
  partitions: RentalFacts["partitions"],
): { offset: number; bytes: number }[];
/** Where Swiff OS can go, best first: free space on a GPT disk, then shrinking C:, then another fixed NTFS drive. */
export function targetsOf(facts: RentalFacts, need?: number): RentalTarget[];
/** Steam's libraries on this PC by drive, with how many games each holds. */
export function libraryDrives(options?: {
  platform?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  steamPath?: string | null;
  files?: { readFileSync(file: string, encoding: "utf8"): string; readdirSync(dir: string): string[] };
}): { letter: string; games: number }[];
/** The drive Swiff OS shares games from: the one whose Steam libraries hold the most games. */
export function gamesDriveOf(
  facts: RentalFacts,
  libraries: { letter: string; games: number }[],
): GamesDrive | null;
/** The last live run in Swiff OS (last-live.json), checked; null when there is none or it does not read as one. */
export function lastLiveOf(raw: unknown): LastLive | null;
/** Everything the rental-mode screen shows, from the script's output and Steam's libraries. */
export function rentalOf(raw: unknown, libraries?: { letter: string; games: number }[]): RentalRead;
/** What rental mode needs from this PC, read fresh; null where it cannot be read (off Windows). */
export function readRental(options?: {
  platform?: string;
  run?: (script: string) => Promise<string>;
  steamPath?: () => Promise<string | null>;
  libraries?: { letter: string; games: number }[];
  env?: Record<string, string | undefined>;
  home?: string;
  files?: { readFileSync(file: string, encoding: "utf8"): string; readdirSync(dir: string): string[] };
}): Promise<RentalRead | null>;
/** Swiff OS's partitions as an image's own GPT has them, in disk order; throws unless they are the ones SWIFF_OS expects. */
export function imageLayout(gpt: Gpt): LayoutPartition[];
/** The image file a partition's contents come from: swiffos_0.1.0.esp.raw. */
export function splitFile(split: string, version?: string): string;
/** A one-time code for the MOK confirmation: 8 random digits. */
export function mokCode(random?: (max: number) => number): string;
/** MokNew, MokAuth and MokTimeout, the variables that queue `cert` (DER) for enrolment with `code`. */
export function mokRequest(
  cert: Uint8Array,
  code: string,
): { guid: string; attributes: number; MokNew: Buffer; MokAuth: Buffer; MokTimeout: Buffer };
/** Queue Swiff's key with a one-time code and point the next start at Swiff OS, then restart once into its confirmation. */
export function mokSteps(code: string): PlanStep[];
/** Confirm Swiff's key again after a missed confirmation, with a new code, BitLocker on C: suspended as `rental` says. */
export function mokPlan(code?: string, rental?: RentalRead | null): RentalPlan;
/** The steps that install Swiff OS next to Windows, for the target the owner chose, then queue Swiff's key. */
export function installPlan(
  rental: RentalRead,
  options?: {
    target?: string | null;
    layout?: LayoutPartition[];
    code?: string;
    errorReports?: { key: string; host: string } | null;
  },
): RentalPlan;
/** LANTEREL.ENV's lines for `project`, or null unless it is a PostHog project key and an https origin on posthog.com, as Swiff OS takes them. */
export function errorReportsFile(project: { key?: unknown; host?: unknown }): string | null;
/** The steps that take Swiff OS off this PC again, from what the install recorded; also what undoes an install that stopped half way. */
export function uninstallPlan(rental: RentalRead): RentalPlan;
/** Ask the PC to stop trusting Swiff's key: MokManager removes it once the owner confirms at the PC with a new code. */
export function keyRemovalPlan(code?: string, rental?: RentalRead | null): RentalPlan;
/** Remove Swiff OS, in two parts (`phase`): Swiff's key off through MokManager first when `key`, then the disk. */
export function removePlan(rental: RentalRead, options?: { key?: boolean; code?: string }): RentalPlan;
/** Start Swiff OS once, start sharing (Swiff OS first in the boot order), or stop (Windows first again). */
export function switchPlan(kind: "once" | "start" | "stop"): RentalPlan;
/** The PowerShell lines an operation is; null for the operations the worker does itself, in bytes. */
export function shellOf(op: PlanOp): string[] | null;
/** What an operation does, as the commands it is or, for the worker's own byte-level ones, in words. */
export function commandsOf(op: PlanOp): string[];
