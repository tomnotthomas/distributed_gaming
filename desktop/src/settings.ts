// The Electron host is not served by the signaling server, so it cannot read
// the address off `location` the way the web app does. It remembers what was
// typed last instead — the tunnel URL changes often enough to matter.

//
// The machine id is not a secret and lives beside it. The machine key is, so it
// goes through preload.cjs to main, which stores it encrypted by the OS.

const URL_KEY = "swiff.signalingUrl";
const ID_KEY = "swiff.machineId";

export const DEFAULT_HOST_ID = "gaming-pc-1";

function load(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage. Losing the value costs one paste.
  }
}

export const loadUrl = () => load(URL_KEY);
export const saveUrl = (url: string) => save(URL_KEY, url);
export const loadMachineId = () => load(ID_KEY) || DEFAULT_HOST_ID;
export const saveMachineId = (id: string) => save(ID_KEY, id);

type HostBridge = {
  loadMachineKey(): Promise<string>;
  saveMachineKey(key: string): Promise<boolean>;
};

/** Absent when the renderer runs outside Electron, e.g. under vite in a browser. */
const bridge = (): HostBridge | undefined => (window as { swiffHost?: HostBridge }).swiffHost;

export async function loadMachineKey(): Promise<string> {
  return (await bridge()?.loadMachineKey().catch(() => "")) ?? "";
}

/** False when the OS offers no encryption and the key was not kept. */
export async function saveMachineKey(key: string): Promise<boolean> {
  return (await bridge()?.saveMachineKey(key).catch(() => false)) ?? false;
}

/** `https://x.trycloudflare.com` and `x.trycloudflare.com` both become wss://. */
export function toSocketUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^wss?:\/\//.test(trimmed)) return trimmed;
  if (/^https:\/\//.test(trimmed)) return trimmed.replace(/^https:/, "wss:");
  if (/^http:\/\//.test(trimmed)) return trimmed.replace(/^http:/, "ws:");
  return `wss://${trimmed}`;
}
