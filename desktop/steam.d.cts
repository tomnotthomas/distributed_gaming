// Types for steam.cjs, so the renderer and its tests can use its results and helpers.

type Files = {
  readFileSync(file: string, encoding: "utf8"): string;
  readdirSync(dir: string): string[];
  existsSync(file: string): boolean;
};

/** What Steam is doing with a game it has not finished installing. */
export type InstallPhase = "queued" | "downloading" | "finishing" | "paused";
/** A game Steam is installing: its bytes done of all it needs for the phase it is in, 0 of 0 until Steam knows. */
export type SteamInstall = { appid: number; name: string; phase: InstallPhase; done: number; total: number };
export type SteamStatus = { installed: boolean; path: string | null; running: boolean; signedIn: boolean };
export type SteamRead = SteamStatus & { installs: SteamInstall[] };

export const STEAM_INSTALLER_URL: string;
export const MAX_INSTALLER_BYTES: number;
export function manifestInstall(acf: string): SteamInstall | null;
export function readInstalls(options?: {
  platform?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  steamPath?: string | null;
  files?: Omit<Files, "existsSync">;
}): SteamInstall[];
export function activeProcessFromReg(output: string): { running: boolean; signedIn: boolean };
type StatusOptions = {
  platform?: string;
  query?: (args: string[]) => Promise<string | null>;
  files?: Files;
  env?: Record<string, string | undefined>;
  home?: string;
  steamPath?: string | null;
};
export function readSteamStatus(options?: StatusOptions): Promise<SteamStatus>;
export function readSteam(options?: StatusOptions): Promise<SteamRead>;
export function isValveSignature(output: string): boolean;
export function signedByValve(
  file: string,
  options?: {
    platform?: string;
    run?: (cmd: string, args: string[], options: object) => Promise<{ stdout: string }>;
  },
): Promise<boolean>;
type InstallerOptions = {
  fetch?: (url: string, init: { redirect: "error" }) => Promise<Response>;
  verify?: (file: string) => Promise<boolean>;
  files?: {
    mkdirSync(dir: string, options: { recursive: true }): unknown;
    writeFileSync(file: string, data: Uint8Array): void;
    rmSync(file: string, options: { force: true }): void;
  };
};
export function downloadSteamInstaller(dir: string, options?: InstallerOptions): Promise<string>;
export function openSteamInstaller(
  options: InstallerOptions & { dir: string; open: (file: string) => Promise<string>; platform?: string },
): Promise<string | null>;
