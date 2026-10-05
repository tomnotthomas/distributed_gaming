// Types for probe.cjs, so the renderer's tests can check its parsing.

import type { Probed } from "./pc.cjs";

export const CODECS: Record<"h264" | "hevc" | "av1", string>;
export const PROBE_SCRIPT: string;
export function encodeCommand(script: string): string;
export function parseProbe(stdout: string): Probed | null;
export function readWindowsProbe(options?: {
  platform?: string;
  env?: Record<string, string | undefined>;
  run?: (
    file: string,
    args: string[],
    options: { timeout: number; windowsHide: boolean },
    callback: (error: Error | null, stdout: string) => void,
  ) => unknown;
}): Promise<Probed | null>;
