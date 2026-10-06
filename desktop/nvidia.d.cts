// Types for nvidia.cjs, so the renderer and its tests can use its results and helpers.

/** The driver Swiff OS expects (swiff-os-nvidia-driver): one release, its licence and its packages. */
export type NvidiaManifest = {
  version: string;
  mirror: string;
  licence: { url: string; sha256: string };
  files: { sha256: string; size: number; path: string; name: string }[];
  bytes: number;
};

/** The driver on this PC. */
export type NvidiaDriver = {
  /** The release Swiff OS runs: "595.91.07". */
  version: string;
  /** What installing downloads, in bytes. */
  bytes: number;
  /** Where it goes on the games drive: D:\SwiffOS\nvidia\595.91.07; null without a games drive. */
  folder: string | null;
  /** Every package is there, at its size. */
  installed: boolean;
  /** When the owner accepted NVIDIA's licence for this release and Swiff's current terms; null if they have not. */
  accepted: { at: string } | null;
};

/**
 *   offline    Ubuntu's server could not be reached
 *   gone       it no longer has a file of this driver
 *   server     it answered with an error
 *   changed    what it sent is not what Swiff OS expects
 *   space      the games drive lacks the room
 *   write      the games drive could not be written
 *   cancelled  the owner stopped it
 */
export type NvidiaError = "offline" | "gone" | "server" | "changed" | "space" | "write" | "cancelled";

export const MANIFEST_FILE: string;
export const ACCEPTANCE_FILE: string;
export const TERMS_VERSION: string;
export const SPARE_BYTES: number;
export const NVIDIA_FIRST_SUPPORTED: number;
export function supportedCard(gpus: { vendor: string; device: number | null }[]): boolean;
export function parseManifest(text: string): NvidiaManifest;
export function readManifest(
  file?: string,
  files?: { readFileSync(file: string, encoding: "utf8"): string },
): NvidiaManifest;
export function driverFolder(letter: string, version: string): string;
export function fetchLicence(options: {
  manifest: NvidiaManifest;
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<{ ok: true; text: string } | { ok: false; error: NvidiaError }>;
export function readAcceptance(dataDir: string, files?: unknown): Record<string, unknown> | null;
export function driverState(options: {
  manifest: NvidiaManifest;
  letter: string | null;
  dataDir: string;
  files?: unknown;
}): NvidiaDriver;
export function installDriver(options: {
  manifest: NvidiaManifest;
  folder: string;
  dataDir: string;
  free?: number | null;
  fetch: typeof globalThis.fetch;
  files?: unknown;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  now?: () => Date;
}): Promise<{ ok: true } | { ok: false; error: NvidiaError }>;
export function removeDriver(options: {
  folder: string;
  dataDir: string;
  files?: unknown;
}): { ok: true } | { ok: false; error: "write"; detail: string };
