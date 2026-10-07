// Friend seats at this PC (server/src/platform.ts, seats), over the Host API
// with the machine key:
//
//   list       GET    /api/machines/:id/seats
//   save one   POST   /api/machines/:id/seats   { friend }
//   take back  DELETE /api/machines/:id/seats?seat=<id>
//
// Each seat has its own link, the whole credential for taking it: it is shown
// to the owner to send, and never logged, as the machine key is not.

import { httpOrigin } from "@swiff/rtc";
import type { Machine } from "./report";

/** How long a seat waits for its friend (server/src/platform.ts, SEAT_HOLD_MS). */
export const SEAT_DAYS = 14;
const DAY_MS = 24 * 60 * 60_000;

/** A seat at this PC as the platform sends it to its host. */
export type HostSeat = {
  id: string;
  friend: string;
  /** Its place among this PC's seats, from 1. */
  number: number;
  state: "open" | "taken";
  /** Unix ms until which an open seat waits for its friend. */
  expiresAt: number;
  /** Who took it, by their Steam name when known. */
  takenBy: string | null;
  crewId: string;
  /** The link's token; null when the server cannot sign links. */
  token: string | null;
};

/** The seats at this PC, and the most it may have. */
export type SeatList = { seats: HostSeat[]; max: number };

/**
 * Why a call did not go through: the PC is not known to the platform yet, has
 * no owner on record, has every seat given out, its owner is in too many crews
 * to found one for it, the name was refused, the seat is gone, the machine key
 * was refused, or no answer.
 */
export type SeatError =
  | "unknown-machine"
  | "no-owner"
  | "full"
  | "too-many-crews"
  | "bad-name"
  | "not-found"
  | "bad-key"
  | "failed";

export type SeatResult<T> = { ok: true; value: T } | { ok: false; error: SeatError };

/** What the seats panel asks of the platform. */
export type SeatClient = {
  list(): Promise<SeatResult<SeatList>>;
  make(friend: string): Promise<SeatResult<HostSeat>>;
  revoke(seatId: string): Promise<SeatResult<SeatList>>;
  /** The link a seat's friend opens; null without a token or a readable address. */
  link(seat: HostSeat): string | null;
};

const CODES: readonly SeatError[] = ["unknown-machine", "no-owner", "full", "too-many-crews"];

/** The error a refused answer names. */
async function errorOf(res: Response): Promise<SeatError> {
  if (res.status === 400) return "bad-name";
  // A wrong machine key: waiting never fixes it.
  if (res.status === 401) return "bad-key";
  if (res.status === 404) return "not-found";
  if (res.status === 409) {
    const code = ((await res.json().catch(() => null)) as { code?: unknown } | null)?.code;
    if (CODES.includes(code as SeatError)) return code as SeatError;
  }
  return "failed";
}

/**
 * The seats client for `machine`, whose url is its signaling socket's address,
 * as the reporter takes it. `site` is the web app's address, where seat links
 * point. Nothing it does throws.
 */
export function seatClient(
  machine: Machine,
  site: string | null,
  fetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args),
): SeatClient {
  const route = () =>
    `${httpOrigin(machine.url)}/api/machines/${encodeURIComponent(machine.machineId)}/seats`;
  const auth = { authorization: `Bearer ${machine.machineKey}` };

  async function call<T>(url: string, init: RequestInit, read: (body: unknown) => T): Promise<SeatResult<T>> {
    try {
      const res = await fetch(url, init);
      if (!res.ok) return { ok: false, error: await errorOf(res) };
      return { ok: true, value: read(await res.json()) };
    } catch {
      return { ok: false, error: "failed" };
    }
  }
  const list = (body: unknown) => body as SeatList;

  return {
    list: () => call(route(), { headers: auth }, list),
    make: (friend) =>
      call(
        route(),
        {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ friend }),
        },
        (body) => (body as { seat: HostSeat }).seat,
      ),
    revoke: (seatId) =>
      call(`${route()}?seat=${encodeURIComponent(seatId)}`, { method: "DELETE", headers: auth }, list),
    link: (seat) => seatLink(site, seat),
  };
}

/** The link a seat's friend opens, on the web app at `site`. */
export const seatLink = (site: string | null, seat: Pick<HostSeat, "token">): string | null =>
  site && seat.token ? `${site}/seat/${seat.token}` : null;

/** The message the owner sends a friend with their seat's link. */
export const seatMessage = (link: string, days: number): string =>
  `Saved you a seat at my rig. You can play your own Steam games on my PC, from your Mac, right in the browser. It's yours for ${days} ${days === 1 ? "day" : "days"}: ${link}`;

/** Whole days an open seat still waits, from `now`: at least 1 while it waits at all. */
export const daysLeft = (expiresAt: number, now: number): number =>
  Math.max(1, Math.ceil((expiresAt - now) / DAY_MS));

/** Whether an open seat waited out its time by `now`: it no longer counts against the PC's. */
export const seatExpired = (seat: Pick<HostSeat, "state" | "expiresAt">, now: number): boolean =>
  seat.state === "open" && seat.expiresAt <= now;

/** "Waiting for Jonas · 12 days left", "Jonas didn't take it in time", or "Taken by Jonas". */
export function seatLine(seat: HostSeat, now: number): string {
  if (seat.state === "taken") return `Taken by ${seat.takenBy ?? seat.friend}`;
  if (seatExpired(seat, now)) return `Expired · ${seat.friend} didn't take it in time`;
  const days = daysLeft(seat.expiresAt, now);
  return `Waiting for ${seat.friend} · ${days} ${days === 1 ? "day" : "days"} left`;
}

/** What the panel says when a call failed. */
export function seatErrorLine(error: SeatError, max: number): string {
  switch (error) {
    case "unknown-machine":
      return "Offer this PC once, then save seats for friends.";
    case "no-owner":
      return "This PC has no owner on record yet. Check the machine key in Settings.";
    case "full":
      return `All ${max} seats are given out.`;
    case "too-many-crews":
      return "You're in 50 crews already. Leave one on the website to save a seat.";
    case "bad-name":
      return "Give your friend a name.";
    case "not-found":
      return "That seat is gone already.";
    case "bad-key":
      return "Lanterel refused this PC's machine key. Check it in Settings.";
    case "failed":
      return "Lanterel isn't answering. Try again in a moment.";
  }
}

/**
 * The demo's seats: kept in memory, starting with one friend who took their
 * seat and one still waiting, with links on an example address. Nothing
 * reaches the network.
 */
export function demoSeatClient(now: () => number = Date.now): SeatClient {
  const max = 4;
  const start = now();
  let made = 2;
  let seats: HostSeat[] = [
    {
      id: "demo-seat-1",
      friend: "Jonas",
      number: 1,
      state: "taken",
      expiresAt: start + 9 * DAY_MS,
      takenBy: "jonas_k",
      crewId: "demo-crew",
      token: "demo-seat-1",
    },
    {
      id: "demo-seat-2",
      friend: "Mia",
      number: 2,
      state: "open",
      expiresAt: start + 12 * DAY_MS,
      takenBy: null,
      crewId: "demo-crew",
      token: "demo-seat-2",
    },
  ];
  const renumber = () => (seats = seats.map((s, i) => ({ ...s, number: i + 1 })));
  return {
    list: async () => ({ ok: true, value: { seats, max } }),
    make: async (friend) => {
      if (seats.length >= max) return { ok: false, error: "full" };
      const id = `demo-seat-${++made}`;
      const seat: HostSeat = {
        id,
        friend,
        number: seats.length + 1,
        state: "open",
        expiresAt: now() + SEAT_DAYS * DAY_MS,
        takenBy: null,
        crewId: "demo-crew",
        token: id,
      };
      seats = [...seats, seat];
      return { ok: true, value: seat };
    },
    revoke: async (seatId) => {
      if (!seats.some((s) => s.id === seatId)) return { ok: false, error: "not-found" };
      seats = seats.filter((s) => s.id !== seatId);
      renumber();
      return { ok: true, value: { seats, max } };
    },
    link: (seat) => seatLink("https://lanterel.example", seat),
  };
}
