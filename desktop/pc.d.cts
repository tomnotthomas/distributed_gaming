// Types for pc.cjs, so the renderer's tests can check its helpers.

export type Display = { width: number; height: number; refreshHz: number | null };
export type Hardware = {
  gpu: string | null;
  cpu: string | null;
  ramGb: number | null;
  display: Display | null;
};
export type SteamGame = { appid: number; name: string };
export type PcRead = { hardware: Hardware; games: SteamGame[] };

type Files = {
  readFileSync(file: string, encoding: "utf8"): string;
  readdirSync(dir: string): string[];
};

export function cpuName(model: string | null | undefined): string | null;
export function gpuName(info: unknown): string | null;
export function wholeGb(bytes: number): number | null;
export function displayOf(display: unknown): Display | null;
export function libraryPaths(vdf: string): string[];
export function manifestGame(acf: string): SteamGame | null;
export const MAX_GAMES: number;
export function steamPathFromReg(output: string): string | null;
export function steamRoots(
  platform: string,
  env: Record<string, string | undefined>,
  home: string,
  steamPath?: string | null,
): string[];
export function readSteamGames(options?: {
  platform?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  steamPath?: string | null;
  files?: Files;
}): SteamGame[];
export function readPc(electron: { app: unknown; screen: unknown }): Promise<PcRead>;
