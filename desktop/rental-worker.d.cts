// Types for rental-worker.cjs, so the installer's tests can drive it with a stand-in for Windows.

import type { PlanOp } from "./rental.cjs";

export type WindowsDisk = {
  bytes: number;
  sector: number;
  read(offset: number, length: number): Buffer;
  write(writes: { offset: number; bytes: Buffer }[]): void;
  close(): void;
};
export type Windows = {
  powershell(lines: string[]): Promise<string>;
  firmware(
    requests: ({ get: string; guid: string } | { set: string; guid: string; data: Buffer | null })[],
  ): Promise<Record<string, Buffer | null>>;
  openDisk(number: number): Promise<WindowsDisk>;
  stateDir: string;
};

export const SWIFF_TYPES: Set<string>;
export const WINDOWS: Windows;
export function checkOp(op: unknown): void;
export function createWorker(options: {
  imageDir: string;
  win?: Windows;
  files?: typeof import("node:fs");
}): Promise<{
  apply(
    op: PlanOp,
    progress?: (p: { what: string; done: number; total: number }) => void,
  ): Promise<Record<string, unknown>>;
  state(): Record<string, unknown>;
}>;
export function diskPath(number: number): string;
export function diskOf(fd: number, bytes: number, sector: number): WindowsDisk;
export function serve(pipe: string, token: string, imageDir: string): Promise<void>;
