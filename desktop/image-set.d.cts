// Types for image-set.cjs, so the installer's tests can use it.

import type { LayoutPartition } from "./rental.cjs";

export type ImageSet = {
  dir: string;
  version: string;
  layout: (LayoutPartition & { id: string; name: string })[];
  files: Record<string, { bytes: number; sha256: string }>;
};

export const MANIFEST: string;
export const BLOCK: number;
export function readImageSet(
  dir: string,
  files?: { readFileSync(file: string, encoding: "utf8"): string },
): ImageSet;
export function fileOf(set: ImageSet, name: string): { path: string; bytes: number; sha256: string };
export function sourceOf(set: ImageSet, split: string): { path: string; bytes: number; sha256: string };
export function hashOf(
  read: (buf: Buffer, at: number) => Promise<number>,
  bytes: number,
  onProgress?: (done: number, total: number) => void,
): Promise<string>;
export function verifyFile(
  set: ImageSet,
  name: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void>;
export function certFromAuth(auth: Uint8Array): Buffer;
export function writeManifest(dir: string, image: string, version: string): Promise<void>;
