// The calls the preloads expose, typed. Absent when the renderer runs outside
// Electron (under vite in a browser, or in a test), so every caller has a
// fallback for "no bridge".

import type { PcRead, SteamGame } from "../pc.cjs";
import type { NvidiaError } from "../nvidia.cjs";
import type { RentalPlan, RentalRead } from "../rental.cjs";
import type { SteamRead } from "../steam.cjs";
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
  /** A preview of the steps; null when there is no plan to show. */
  planRental(ask: { kind: RentalPlan["kind"]; target?: string | null }): Promise<RentalPlan | null>;
  /** NVIDIA's licence for Swiff OS's driver, from Ubuntu; null while NVIDIA rental is off. */
  nvidiaLicence(): Promise<{ ok: true; text: string } | { ok: false; error: NvidiaError } | null>;
  /** Download NVIDIA's driver onto the games drive; null when it may not (not accepted, no card, no drive). */
  installNvidia(accepted: {
    licence: boolean;
    terms: boolean;
  }): Promise<{ ok: true } | { ok: false; error: NvidiaError } | null>;
  cancelNvidia(): Promise<void>;
  onNvidiaProgress(listener: (progress: { done: number; total: number }) => void): () => void;
  removeNvidia(): Promise<{ ok: boolean } | null>;
  secondsSinceInput(): Promise<number>;
  setGlance(glance: Glance): void;
  onTrayAction(listener: (action: TrayAction) => void): () => void;
};

/** The tray glance's calls (tray-preload.cjs): its snapshot, and one named action back. */
export type TrayBridge = {
  onGlance(listener: (glance: Glance) => void): () => void;
  trayAction(action: TrayAction | "open"): void;
};

/** The app window's preload calls, or undefined outside Electron. */
export const bridge = (): HostBridge | undefined => (window as { swiffHost?: HostBridge }).swiffHost;

/** The tray glance's preload calls, or undefined outside its window. */
export const trayBridge = (): TrayBridge | undefined => (window as { swiffTray?: TrayBridge }).swiffTray;
