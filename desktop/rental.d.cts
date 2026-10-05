// Types for rental.cjs, so the renderer and its tests can use its results and helpers.

import type { Gpt } from "./gpt.cjs";

export type GpuVendor = "nvidia" | "amd" | "intel" | "other";

/** What rental mode needs from this PC, as read without administrator rights. Null where it could not be read. */
export type RentalFacts = {
  uefi: boolean | null;
  secureBoot: boolean | null;
  tpm: { present: boolean | null; maker: string | null; firmware: boolean | null };
  iommu: boolean | null;
  fastStartup: boolean | null;
  /** Each graphics card: its PCI device number (null if unread) and Windows driver version (null if unread). */
  gpus: { name: string; vendor: GpuVendor; device: number | null; driver: string | null }[];
  disks: { number: number; gpt: boolean; size: number; sector: number; usb: boolean; system: boolean }[];
  partitions: {
    disk: number;
    number: number | null;
    letter: string | null;
    type: string;
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
  bootEntry: string | null;
};

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
};

export type PlanOp =
  | { op: "check" }
  | { op: "fast-startup-off" }
  | { op: "shrink"; disk: number; partition: number | null; size: number }
  | {
      op: "gpt-add";
      disk: number;
      partitions: {
        type: string;
        id: string | null;
        name: string | null;
        attrs: string;
        offset: number;
        bytes: number;
      }[];
    }
  | { op: "write"; disk: number; offset: number; bytes: number; source: string }
  | { op: "boot-entry"; disk: number; offset: number; path: string; title: string }
  | { op: "label"; letter: string; label: string }
  | { op: "mok-import"; cert: string; code: string }
  | { op: "boot-first"; entry: "swiff" | "windows" }
  | { op: "boot-next"; entry: "swiff" }
  | { op: "restart" };

/** One step of a plan: what it does in words, its operations, and the Windows commands they stand for. */
export type PlanStep = { id: string; title: string; ops: PlanOp[]; commands: string[] };

/** A plan, always a preview here: nothing in the app runs it. */
export type RentalPlan = {
  kind: "install" | "mok" | "start" | "stop";
  dryRun: true;
  target?: RentalTarget;
  steps: PlanStep[];
  /** The install's or the re-confirmation's one-time code, which the owner types at the PC to confirm Swiff's key (MOK). */
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
export const SCRIPT: string;
export function gpuVendor(pnp: string): GpuVendor;
export function gpuDevice(pnp: string): number | null;
export function bitlockerState(value: unknown): "on" | "off" | null;
export function tpmMaker(info: unknown): { maker: string | null; firmware: boolean | null };
export function factsOf(raw: unknown): RentalFacts;
export function freeSpans(
  disk: RentalFacts["disks"][number],
  partitions: RentalFacts["partitions"],
): { offset: number; bytes: number }[];
export function targetsOf(facts: RentalFacts, need?: number): RentalTarget[];
export function libraryDrives(options?: {
  platform?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  steamPath?: string | null;
  files?: { readFileSync(file: string, encoding: "utf8"): string; readdirSync(dir: string): string[] };
}): { letter: string; games: number }[];
export function gamesDriveOf(
  facts: RentalFacts,
  libraries: { letter: string; games: number }[],
): GamesDrive | null;
export function rentalOf(raw: unknown, libraries?: { letter: string; games: number }[]): RentalRead;
export function readRental(options?: {
  platform?: string;
  run?: (script: string) => Promise<string>;
  steamPath?: () => Promise<string | null>;
  libraries?: { letter: string; games: number }[];
  env?: Record<string, string | undefined>;
  home?: string;
  files?: { readFileSync(file: string, encoding: "utf8"): string; readdirSync(dir: string): string[] };
}): Promise<RentalRead | null>;
export function imageLayout(gpt: Gpt): LayoutPartition[];
export function splitFile(split: string, version?: string): string;
export function mokCode(random?: (max: number) => number): string;
export function mokRequest(
  cert: Uint8Array,
  code: string,
): { guid: string; attributes: number; MokNew: Buffer; MokAuth: Buffer };
export function mokSteps(code: string): PlanStep[];
export function mokPlan(code?: string): RentalPlan;
export function installPlan(
  rental: RentalRead,
  options?: { target?: string | null; layout?: LayoutPartition[]; code?: string },
): RentalPlan;
export function switchPlan(kind: "start" | "stop"): RentalPlan;
