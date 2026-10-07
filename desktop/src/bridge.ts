// The calls the preloads expose, typed. Absent when the renderer runs outside
// Electron (under vite in a browser, or in a test), so every caller has a
// fallback for "no bridge".

import type { PcRead, SteamGame } from "../pc.cjs";
import type { ImageProgress } from "../image-download.cjs";
import type { RunEvent, RunOutcome } from "../rental-exec.cjs";
import type { RentalPlan, RentalRead } from "../rental.cjs";
import type { SteamRead } from "../steam.cjs";
import type { WindowError } from "./mainErrors";
import type { Glance, TrayAction } from "./model";

/** The app window's calls (preload.cjs). */
export type HostBridge = {
  loadMachineKey(): Promise<string>;
  saveMachineKey(key: string): Promise<boolean>;
  readPc(): Promise<PcRead>;
  readSteam(): Promise<SteamRead>;
  /** Resolves with why the installer could not be opened, or null once it is open. */
  installSteam(): Promise<string | null>;
  onGamesChanged(listener: (games: SteamGame[]) => void): () => void;
  /** Null where rental mode cannot be read (off Windows). */
  readRental(): Promise<RentalRead | null>;
  /** Download Lanterel OS's image set (image-download.cjs); null when one is there already or under way. */
  downloadImage(): Promise<
    { ok: true; version: string } | { ok: false; error: string; retry: boolean } | null
  >;
  onImageProgress(listener: (progress: ImageProgress) => void): () => void;
  /** The steps, as main will run them; null when there is no plan to show. */
  planRental(ask: {
    kind: RentalPlan["kind"];
    target?: string | null;
    /** Remove Swiff OS: start with Swiff's key (true), or without it (false); main decides when absent. */
    key?: boolean;
  }): Promise<RentalPlan | null>;
  /** Run the plan main last showed; null when there is none to run. */
  runRental(): Promise<RunOutcome | null>;
  /** Restart now, after a run that ended at its restart: false when there is nothing to restart for. */
  restartRental(): Promise<boolean>;
  /** Whether the blue screen took the key's code, in the owner's words. */
  answerRentalKey(yes: boolean): Promise<boolean>;
  /** The owner saved their BitLocker recovery key: kept as their word alone, never the key. */
  saveRecoveryKey(): Promise<boolean>;
  /** Windows' BitLocker page: false when it did not open. */
  openBitLocker(): Promise<boolean>;
  /** The owner has seen how Remove Swiff OS ended: its record goes. */
  seenRemoval(): Promise<boolean>;
  /** Send details to Swiff: when it was kept, or null when it could not be. */
  reportRental(report: {
    step: string;
    error: string;
    checks: { id: string; value: string }[];
  }): Promise<number | null>;
  onRentalEvent(listener: (event: RunEvent) => void): () => void;
  secondsSinceInput(): Promise<number>;
  setGlance(glance: Glance): void;
  onTrayAction(listener: (action: TrayAction) => void): () => void;
  /** An error nothing caught in this window, for main to report (mainErrors.ts). */
  reportError?(report: WindowError): void;
  /** The Lanterel server's error-reports project, or null when it has none, for main (errorProject.ts). */
  setErrorProject?(origin: string, project?: { key: string; host: string } | null): void;
};

/** The tray glance's calls (tray-preload.cjs): its snapshot, and one named action back. */
export type TrayBridge = {
  onGlance(listener: (glance: Glance) => void): () => void;
  trayAction(action: TrayAction | "open"): void;
  /** An error nothing caught in the glance, for main to report (mainErrors.ts). */
  reportError?(report: WindowError): void;
};

/** The app window's preload calls, or undefined outside Electron. */
export const bridge = (): HostBridge | undefined => (window as { swiffHost?: HostBridge }).swiffHost;

/** The tray glance's preload calls, or undefined outside its window. */
export const trayBridge = (): TrayBridge | undefined => (window as { swiffTray?: TrayBridge }).swiffTray;
