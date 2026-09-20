// The Electron host is not served by the signaling server, so it cannot read
// the address off `location` the way the web app does. It remembers what was
// typed last instead — the tunnel URL changes often enough to matter.

const KEY = "swiff.signalingUrl";

export const DEFAULT_HOST_ID = "gaming-pc-1";

export function loadUrl(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveUrl(url: string) {
  try {
    localStorage.setItem(KEY, url);
  } catch {
    // Private mode or blocked storage. Losing the value costs one paste.
  }
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
