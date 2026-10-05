// Types for measured-boot.cjs.

export type TcgEvent = { pcr: number; type: number; data: Buffer };

/** The EFI programs one power-on started, and what that says about Swiff's shim. */
export type Trail = {
  apps: string[];
  shim: boolean;
  mokManager: number;
  loader: boolean;
  windowsAfterShim: boolean;
};

export const EV: Record<
  "NO_ACTION" | "IPL" | "VARIABLE_DRIVER_CONFIG" | "BOOT_SERVICES_APPLICATION" | "VARIABLE_AUTHORITY",
  number
>;
export const MEASURED_BOOT: string;
export function parseLog(bytes: Uint8Array): TcgEvent[];
export function variableOf(data: Buffer): { name: string; data: Buffer } | null;
export function imageOf(data: Buffer): string | null;
export function dbTrusts(events: TcgEvent[], name: string): boolean | null;
export function trailOf(events: TcgEvent[]): Trail;
export function lastLog(
  dir?: string,
  files?: typeof import("node:fs"),
): { at: number; events: TcgEvent[] } | null;
