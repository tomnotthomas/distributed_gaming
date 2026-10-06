// Types for rental-removal.cjs, so the renderer and its tests can use its results.

import type { InstallRecord, RentalFacts } from "./rental.cjs";
import type { BootTrail } from "./rental-key.cjs";

/** What Remove Swiff OS must leave: no partition with these ids, a drive its size again, BitLocker on again. */
export type RemovalExpect = {
  ids: string[];
  room: { letter: string; size: number } | null;
  bitlocker: string[];
};

export type SavedRemoval =
  { phase: "key"; at: number; code: string | null } | { phase: "disk"; at: number; expect: RemovalExpect };

/** One thing the start after the removal shows. */
export type RemovalCheck = { id: string; label: string; ok: boolean; value: string };

/** Where Remove Swiff OS stands: see rental-removal.cjs. */
export type Removal =
  | { state: "queued"; code: string | null }
  | { state: "finish" }
  | { state: "restart" }
  | { state: "checked"; ok: boolean | null; checks: RemovalCheck[]; at: number };

export const SLACK: number;
export function expectOf(install: InstallRecord, bitlocker?: string[]): RemovalExpect;
export function savedOf(raw: unknown): SavedRemoval | null;
export function checksOf(
  expect: RemovalExpect,
  facts: RentalFacts,
  trail: Pick<BootTrail, "shim"> | null,
): RemovalCheck[];
export function removalOf(
  saved: SavedRemoval | null,
  bootAt: number,
  facts?: RentalFacts | null,
  trail?: Pick<BootTrail, "shim"> | null,
): Removal | null;
export type RemovalStore = {
  read(): SavedRemoval | null;
  keyQueued(code: string, at: number): void;
  removed(expect: RemovalExpect, at: number): void;
  forget(): void;
};
export function removalStore(
  dir: string,
  crypt: { seal(text: string): Buffer; open(sealed: Buffer): string } | null,
  files?: typeof import("node:fs"),
): RemovalStore;
export function removalStep(
  store: RemovalStore,
  plan: { kind: string; phase?: string; mok?: { code: string } },
  id: string,
  at: number,
  expect?: RemovalExpect | null,
): void;
