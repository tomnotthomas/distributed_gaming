// What may host in Swiff OS, from the platform: whether Swiff lets NVIDIA cards
// host there (GET /api/hosting). Swiff can switch it off for everyone at once
// without an app update; the server then refuses an NVIDIA machine itself, so
// this read only lets the Rental mode screen say so before the owner installs
// anything.

import { useEffect, useState } from "react";
import { refusedAddress, toSocketUrl } from "./settings";

/** How often the switch is read again while the app is open. */
export const HOSTING_EVERY_MS = 5 * 60_000;

/** The route on the signaling server's own HTTPS origin, or null where the server is not set or not encrypted. */
export function hostingUrl(url: string): string | null {
  const socket = toSocketUrl(url);
  if (!socket || refusedAddress(socket)) return null;
  const origin = new URL(socket);
  origin.protocol = origin.protocol === "wss:" ? "https:" : "http:";
  return `${origin.origin}/api/hosting`;
}

/** Whether NVIDIA cards may host in Swiff OS. Throws when it cannot be read. */
export async function fetchNvidiaHosting(
  url: string,
  fetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args),
): Promise<boolean> {
  const route = hostingUrl(url);
  if (!route) throw new Error("hosting: no server");
  const res = await fetch(route, { cache: "no-store" });
  if (!res.ok) throw new Error(`hosting: ${res.status}`);
  const body = (await res.json()) as { nvidiaRental?: unknown } | null;
  if (typeof body?.nvidiaRental !== "boolean") throw new Error("hosting: unexpected answer");
  return body.nvidiaRental;
}

/** The switch, read once the server is set and every HOSTING_EVERY_MS after; null until read. */
export function useNvidiaHosting(url: string): boolean | null {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    setOn(null);
    if (!hostingUrl(url)) return;
    let current = true;
    const read = () =>
      void fetchNvidiaHosting(url)
        .then((next) => current && setOn(next))
        .catch(() => {});
    read();
    const id = window.setInterval(read, HOSTING_EVERY_MS);
    return () => {
      current = false;
      window.clearInterval(id);
    };
  }, [url]);
  return on;
}
