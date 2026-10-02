// The calls preload.cjs exposes, typed. Absent when the renderer runs outside
// Electron (under vite in a browser, or in a test), so every caller has a
// fallback for "no bridge".

import type { PcRead } from "../pc.cjs";
import type { Glance, TrayAction } from "./model";

export type HostBridge = {
  loadMachineKey(): Promise<string>;
  saveMachineKey(key: string): Promise<boolean>;
  readPc(): Promise<PcRead>;
  secondsSinceInput(): Promise<number>;
  setGlance(glance: Glance): void;
  onGlance(listener: (glance: Glance) => void): () => void;
  trayAction(action: TrayAction | "open"): void;
  onTrayAction(listener: (action: TrayAction) => void): () => void;
};

export const bridge = (): HostBridge | undefined => (window as { swiffHost?: HostBridge }).swiffHost;
