// Types for image-download.cjs, so the app and its tests can use it.

import type { Trust } from "./image-set.cjs";

export type Part = { name: string; bytes: number; sha256: string };

/** How far a download is: the manifest's check, the parts' compressed bytes, or the files' unpacked bytes. */
export type ImageProgress = { phase: "check" | "download" | "unpack"; done: number; total: number };

export const PART_BYTES: number;
export const PARTS_DIR: string;
export class DownloadError extends Error {
  /** Whether trying again can help (the download carries on), or only an update can. */
  retry: boolean;
  constructor(message: string, options?: { retry?: boolean });
}
export function packFile(file: string, outDir: string, partBytes?: number, level?: number): Promise<Part[]>;
export function packSet(
  dir: string,
  partBytes?: number,
  level?: number,
): Promise<{ compression: "gzip"; files: Record<string, { parts: Part[] }> }>;
export function sourceOf(files?: typeof import("node:fs")): string | null;
export function downloadSet(options: {
  url: string | null;
  dir: string;
  trust: Trust[];
  fetch?: typeof fetch;
  onProgress?: (progress: ImageProgress) => void;
  signal?: AbortSignal;
  free?: (dir: string) => number | null;
}): Promise<string>;
