// Types for recovery-key.cjs, so the renderer and its tests can use its results.

/** That the owner saved their BitLocker recovery key, for which drives, and when: never the key. */
export type SavedRecovery = { at: number; drives: string[] };

/** The drives BitLocker protects now, and whether the owner saved each one's recovery key. */
export type Recovery = { drives: string[]; saved: boolean; at: number | null };

export const ACCOUNT_URL: string;
export const BITLOCKER_PANEL: { file: string; args: string[] };
export function savedOf(raw: unknown): SavedRecovery | null;
export function recoveryOf(saved: SavedRecovery | null, drives: string[]): Recovery;
export function recoveryStore(
  dir: string,
  files?: typeof import("node:fs"),
): { read(): SavedRecovery | null; saved(drives: string[], at: number): void };
