// Types for rental-key.cjs, so the renderer and its tests can use its results.

export type SavedKey = { code: string | null; queuedAt: number | null; answer: "yes" | "no" | null };

/** Where Swiff's key stands, as far as the app can know: see rental-key.cjs. */
export type KeyState =
  { state: "queued"; code: string } | { state: "ask" | "confirmed" | "missed" | "nokey"; code: null };

/** What ran before Windows in this start's power-on, from its measured-boot log (measured-boot.cjs). */
export type BootTrail = { at: number } & import("./measured-boot.cjs").Trail;

export function savedOf(raw: unknown): SavedKey | null;
export function keyOf(saved: SavedKey | null, bootAt: number, trail?: BootTrail | null): KeyState | null;
/** Whether the owner may answer the blue screen's question now (state ask, or nothing saved). */
export function canAnswer(key: KeyState | null): boolean;
export function bootTrail(dir?: string, files?: typeof import("node:fs")): BootTrail | null;
export type KeyStore = {
  read(): SavedKey | null;
  queued(code: string, at: number): void;
  answer(yes: boolean): void;
  forget(): void;
};
export function keyStore(
  dir: string,
  crypt: { seal(text: string): Buffer; open(sealed: Buffer): string } | null,
  files?: typeof import("node:fs"),
): KeyStore;
export function keyStep(store: KeyStore, plan: { mok?: { code: string } }, id: string, at: number): void;
