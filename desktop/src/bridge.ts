// The calls the preloads expose, typed. Absent when the renderer runs outside
// Electron (under vite in a browser, or in a test), so every caller has a
// fallback for "no bridge".

import type { PcRead, SteamGame } from "../pc.cjs";
import type { StreamerCommand, StreamerEvent, StreamerInit } from "./handoff";
import type { Glance, TrayAction } from "./model";

/** The app window's calls (preload.cjs). */
export type HostBridge = {
  loadMachineKey(): Promise<string>;
  saveMachineKey(key: string): Promise<boolean>;
  readPc(): Promise<PcRead>;
  onGamesChanged(listener: (games: SteamGame[]) => void): () => void;
  secondsSinceInput(): Promise<number>;
  setGlance(glance: Glance): void;
  onTrayAction(listener: (action: TrayAction) => void): () => void;
  sessionLogon(): Promise<void>;
  sessionLaunch(init: StreamerInit): Promise<void>;
  sessionSend(command: StreamerCommand): Promise<void>;
  sessionEnd(): Promise<void>;
  onSessionEvent(listener: (event: StreamerEvent) => void): () => void;
};

/** The tray glance's calls (tray-preload.cjs): its snapshot, and one named action back. */
export type TrayBridge = {
  onGlance(listener: (glance: Glance) => void): () => void;
  trayAction(action: TrayAction | "open"): void;
};

export const bridge = (): HostBridge | undefined => (window as { swiffHost?: HostBridge }).swiffHost;

export const trayBridge = (): TrayBridge | undefined => (window as { swiffTray?: TrayBridge }).swiffTray;
