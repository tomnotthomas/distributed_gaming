// Types for image-set.cjs, so the installer's tests can use it.

import type { LayoutPartition } from "./rental.cjs";

export type ImageSet = {
  dir: string;
  version: string;
  layout: (LayoutPartition & { id: string; name: string })[];
  files: Record<string, { bytes: number; sha256: string }>;
};

/** A key the app trusts to sign image sets, and the SHA-256 of the certificate its sets carry. */
export type Trust = { publicKey: string; certSha256: string };

export const MANIFEST: string;
export const SIGNATURE: string;
export const BLOCK: number;
export function trustOf(options: { dev: boolean }, files?: typeof import("node:fs")): Trust[];
export function readSigned(
  dir: string,
  files?: typeof import("node:fs"),
): { manifest: Buffer; signature: Buffer };
export function imageSetOf(manifest: Buffer, signature: Buffer, trust: Trust[]): Omit<ImageSet, "dir">;
export function readImageSet(
  dir: string,
  options: { trust: Trust[]; files?: typeof import("node:fs") },
): ImageSet;
export function fileOf(set: ImageSet, name: string): { path: string; bytes: number; sha256: string };
export function sourceOf(set: ImageSet, split: string): { path: string; bytes: number; sha256: string };
export function hashOf(
  read: (buf: Buffer, at: number) => Promise<number>,
  bytes: number,
  onProgress?: (done: number, total: number) => void,
): Promise<string>;
export function copyChecked(
  from: string,
  to: string,
  file: { bytes: number; sha256: string },
  onProgress?: (done: number, total: number) => void,
  files?: typeof import("node:fs"),
): Promise<void>;
export function certFromAuth(auth: Uint8Array): Buffer;
export function signManifest(dir: string, key: string): void;
export function trustEntry(key: string, cert: string): Trust;
export function writeManifest(dir: string, image: string, version: string): Promise<void>;
