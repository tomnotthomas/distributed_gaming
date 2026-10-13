// Types for network.cjs, so the renderer and the tests can use it.

import type { Wifi } from "./provision.cjs";

/** A saved Wi-Fi profile, as Lanterel OS's join needs it: `key` only when Windows gave it in the clear. */
export type WifiProfile = {
  ssid: string;
  hidden: boolean;
  authentication: string;
  encryption: string;
  oneX: boolean;
  keyType: string | null;
  key: string | null;
};
/** A connected Wi-Fi interface: its network's name, how far Windows says each IP version reaches, its saved profiles. */
export type WifiRead = {
  network: string | null;
  ipv4: string | null;
  ipv6: string | null;
  profiles: WifiProfile[];
};
export type NetworkRead = { wired: boolean | null; wifi: WifiRead[] };

/** What Lanterel OS gets online over (networkOf): never the password. */
export type Network =
  | { kind: "wired" }
  | { kind: "wifi"; ssid: string; security: Wifi["security"] }
  | { kind: "none" }
  | { kind: "enterprise"; ssid: string }
  | { kind: "offline"; ssid: string }
  | { kind: "unsupported"; ssid: string }
  | { kind: "unread" };

export function networkScript(withKey: boolean): string;
export function profileOf(xml: unknown): WifiProfile | null;
export function parseNetwork(stdout: string): NetworkRead | null;
export function securityOf(
  profile: Pick<WifiProfile, "authentication" | "encryption" | "oneX" | "keyType">,
): Wifi["security"] | "enterprise" | null;
export function networkOf(read: NetworkRead | null): Network;
export function networkToHand(
  read: NetworkRead | null,
  agreed: string | null,
): Extract<Network, { kind: "wired" | "wifi" }>;
export function wifiToHand(read: NetworkRead | null, agreed: string | null): Wifi | null;
export function readNetwork(options?: {
  withKey?: boolean;
  platform?: string;
  env?: Record<string, string | undefined>;
  run?: unknown;
}): Promise<NetworkRead | null>;
