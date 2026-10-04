// What renters ask for, from the platform: per game, the players who booked it
// in the last hour and those waiting for it now (GET /api/machines/:id/demand,
// with this PC's machine key). The owner reads it to choose what to install.

import { useEffect, useState } from "react";
import { connectionReady, type Connection, type DemandRow, type Game } from "./model";
import { refusedAddress, toSocketUrl } from "./settings";

/** How often the demand is read again while the app is open. */
export const DEMAND_EVERY_MS = 60_000;

type Settings = Pick<Connection, "url" | "machineId" | "machineKey">;

/** One game's demand as the platform sends it: a name where its catalogue has one. */
export type DemandGame = { appid: number; name: string | null; looking: number; waiting: number };

/**
 * The demand route on the signaling server's own HTTPS origin, or null where
 * the app would not send the key there: not set up, or not encrypted.
 */
export function demandUrl({ url, machineId }: Pick<Settings, "url" | "machineId">): string | null {
  const socket = toSocketUrl(url);
  if (!socket || refusedAddress(socket) || !machineId.trim()) return null;
  const origin = new URL(socket);
  origin.protocol = origin.protocol === "wss:" ? "https:" : "http:";
  return `${origin.origin}/api/machines/${encodeURIComponent(machineId.trim())}/demand`;
}

const whole = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/** The games in the platform's answer; anything malformed is left out. */
export function demandGames(body: unknown): DemandGame[] {
  const games = (body as { games?: unknown } | null)?.games;
  if (!Array.isArray(games)) throw new Error("demand: unexpected answer");
  return games
    .filter((g): g is DemandGame => whole(g?.appid) && g.appid > 0 && whole(g.looking) && whole(g.waiting))
    .map(({ appid, name, looking, waiting }) => ({
      appid,
      name: typeof name === "string" && name.trim() ? name.trim() : null,
      looking,
      waiting,
    }));
}

/** Demand as rows, each named by the platform, else by this PC's Steam, else by its appid. */
export const demandRows = (games: DemandGame[], installed: Game[]): DemandRow[] =>
  games.map(({ appid, name, looking, waiting }) => ({
    appid,
    name: name ?? installed.find((g) => g.appid === appid)?.name ?? `Steam app ${appid}`,
    looking,
    waiting,
  }));

/** Read the demand once. Throws when it cannot be read. */
export async function fetchDemand(
  settings: Settings,
  fetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args),
): Promise<DemandGame[]> {
  const url = demandUrl(settings);
  if (!url || !connectionReady(settings)) throw new Error("demand: not connected");
  const res = await fetch(url, { headers: { authorization: `Bearer ${settings.machineKey.trim()}` } });
  if (!res.ok) throw new Error(`demand: ${res.status}`);
  return demandGames(await res.json());
}

/**
 * The demand, read once the connection is set and every DEMAND_EVERY_MS
 * after; null until it has been read. A read that fails keeps the last one.
 */
export function useDemand({ url, machineId, machineKey }: Settings): DemandGame[] | null {
  const [demand, setDemand] = useState<DemandGame[] | null>(null);
  useEffect(() => {
    setDemand(null);
    const settings = { url, machineId, machineKey };
    if (!demandUrl(settings) || !connectionReady(settings)) return;
    let current = true;
    const read = () =>
      void fetchDemand(settings)
        .then((games) => current && setDemand(games))
        .catch(() => {});
    read();
    const id = window.setInterval(read, DEMAND_EVERY_MS);
    return () => {
      current = false;
      window.clearInterval(id);
    };
  }, [url, machineId, machineKey]);
  return demand;
}
