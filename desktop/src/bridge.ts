// The calls the preloads expose, typed. Absent when the renderer runs outside
// Electron (under vite in a browser, or in a test), so every caller has a
// fallback for "no bridge".

import type { PcRead } from "../pc.cjs";
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
  secondsSinceInput(): Promise<number>;
  setGlance(glance: Glance): void;
  onTrayAction(listener: (action: TrayAction) => void): () => void;
};

/** The tray glance's calls (tray-preload.cjs): its snapshot, and one named action back. */
export type TrayBridge = {
  onGlance(listener: (glance: Glance) => void): () => void;
  trayAction(action: TrayAction | "open"): void;
};

export const bridge = (): HostBridge | undefined => (window as { swiffHost?: HostBridge }).swiffHost;

export const trayBridge = (): TrayBridge | undefined => (window as { swiffTray?: TrayBridge }).swiffTray;
