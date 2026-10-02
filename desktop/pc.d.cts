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
export type ArtRequest = { appid: number; kind: "hero" | "header" };
export function findSteamRoot(options?: {
  platform?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  steamPath?: string | null;
  files?: Files;
}): string | null;
export function artRequest(url: string): ArtRequest | null;
export function artCandidates(
  root: string,
  request: ArtRequest,
  files?: { readdirSync(dir: string): string[] },
): string[];
export function readSteamArt(
  url: string,
  root: string | null,
  files?: { readdirSync(dir: string): string[]; promises: { readFile(file: string): Promise<unknown> } },
): Promise<unknown>;
export function steamRootOnce(): Promise<string | null>;
export function readPc(electron: { app: unknown; screen: unknown }): Promise<PcRead>;
