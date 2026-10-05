// Types for rental-key.cjs, so the renderer and its tests can use its results.

export type SavedKey = { code: string | null; queuedAt: number | null; answer: "yes" | "no" | null };

/** Where Swiff's key stands, as far as the app can know: see rental-key.cjs. */
export type KeyState =
  | { state: "queued"; code: string }
  | { state: "ask" | "confirmed" | "missed" | "timedout" | "nokey" | "blocked"; code: null };

/** What ran before Windows in this start's power-on, from its measured-boot log. */
export type BootTrail = { at: number; shim: boolean; mokManager: number; mokList: boolean };

export function savedOf(raw: unknown): SavedKey | null;
export function keyOf(saved: SavedKey | null, bootAt: number, trail?: BootTrail | null): KeyState | null;
export function bootTrail(dir?: string, files?: typeof import("node:fs")): BootTrail | null;
export function keyStore(
  dir: string,
  files?: typeof import("node:fs"),
): {
  read(): SavedKey | null;
  queued(code: string, at: number): void;
  answer(yes: boolean): void;
  forget(): void;
};
