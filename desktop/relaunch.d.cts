// Types for relaunch.cjs, so its tests can use it.

/** When the app asked Windows to open it after the restart. */
export type SavedRelaunch = { at: number };

export const AFTER_RESTART: string;
export const RUN_ONCE: string;
export const VALUE: string;
export function relaunchCommand(at: { exe: string; appPath?: string | null; carry?: string[] }): string;
export function savedOf(raw: unknown): SavedRelaunch | null;
export function relaunchAtStart(saved: SavedRelaunch | null, bootAt: number): "keep" | "clear" | null;
export function afterRestart(flag: boolean, at: "keep" | "clear" | null): boolean;
export function relaunchStore(
  dir: string,
  run: (file: string, args: string[]) => Promise<unknown>,
  files?: typeof import("node:fs"),
): {
  read(): SavedRelaunch | null;
  arm(command: string, at: number): Promise<void>;
  clear(): Promise<void>;
};
