// The server's product switches (server/src/features.ts, GET /api/features).
// While paid gaming is off, which is the default and how the app starts until
// the server says otherwise, the app shows nothing about money: no "Get paid"
// step, no levels, no reliability score and no rate or earnings.

import { useEffect, useState } from "react";
import { httpOrigin } from "@swiff/rtc";
import type { HostView } from "./model";

/** Whether the server at `url` (its signaling address) has paid gaming on; false when it cannot say. */
export async function fetchPaidGaming(
  url: string,
  fetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args),
): Promise<boolean> {
  try {
    const res = await fetch(`${httpOrigin(url)}/api/features`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { paidGaming?: unknown };
    return body.paidGaming === true;
  } catch {
    return false;
  }
}

/** Paid gaming at the server the app connects to, read once per address; off until it answers. */
export function usePaidGaming(url: string): boolean {
  const [paid, setPaid] = useState(false);
  useEffect(() => {
    if (!url.trim()) return setPaid(false);
    let live = true;
    void fetchPaidGaming(url).then((on) => {
      if (live) setPaid(on);
    });
    return () => {
      live = false;
    };
  }, [url]);
  return paid;
}

/** `view` with everything about money left out, as the screens already do where the platform reports none. */
export function unpaid(view: HostView): HostView {
  const live = view.live;
  const read = view.rental.read;
  return {
    ...view,
    pc: { ...view.pc, hardwareRate: null },
    standing: null,
    earlyEnd: null,
    rate: null,
    earnings: null,
    payoutSaved: false,
    live: "claim" in live ? { ...live, claim: { ...live.claim, rate: null } } : live,
    rental: read?.lastLive
      ? { ...view.rental, read: { ...read, lastLive: { ...read.lastLive, earned: null } } }
      : view.rental,
  };
}
