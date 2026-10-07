// A friend seat (server/src/platform.ts, seats): the seat a host keeps at their
// gaming PC for a friend, and the page its link opens (/seat/<token>). The
// link is the whole credential for taking the seat, so it is treated as a crew
// link is (invite.ts): never sent to analytics or the console, kept out of the
// address bar and the Steam sign-in round trip once this tab remembers it, and
// left in the path only with storage blocked.

import { STEAM_LOGIN_URL } from "./steam";

/** How a PC with a seat is now: free to play, being played on, or away. */
export type SeatPcState = "ready" | "busy" | "offline";

/**
 * A seat as the friend opening its link sees it: whose PC (`host`, their Steam
 * persona when known), the friend it is for, its place among the PC's seats
 * (`number` of `of`), the PC, and whether it waits for its friend (`open`, until
 * `expiresAt`), is the viewer's (`yours`, in crew `crewId`), someone else's
 * (`taken`), ran out (`expired`), or is at the viewer's own PC (`host`).
 */
export type Seat = {
  host: string | null;
  friend: string;
  number: number;
  of: number;
  state: "open" | "yours" | "taken" | "expired" | "host";
  expiresAt: number;
  pc: { name: string | null; gpu: string | null; state: SeatPcState; rentalMode: boolean };
  crewId: string | null;
};

/** Why taking a seat was refused: someone else has it, it ran out, it is at the viewer's own PC, or they are in too many crews. */
export type SeatRefusal = "taken" | "expired" | "own" | "full";

/** Where seat links point: /seat/<token>. */
export const SEAT_PATH = "/seat";

/** Where this tab keeps the token of the seat it is signing in for. */
const PENDING_KEY = "swiff.seat";
/** Set while this tab is away at Steam to take that seat: only then does coming back take it. */
const TAKING_KEY = "swiff.seatTake";

/** The token in a seat path, "" for /seat itself, or null for any other path. */
export function seatTokenAt(pathname: string): string | null {
  const match = /^\/seat(?:\/([\w-]+))?\/*$/.exec(pathname);
  return match ? (match[1] ?? "") : null;
}

/** Remember the seat this tab is signing in for; false when storage is blocked. */
export function rememberSeat(token: string): boolean {
  try {
    sessionStorage.setItem(PENDING_KEY, token);
    return true;
  } catch {
    return false;
  }
}

/** The seat this tab was signing in for, or "" when there is none. */
export function rememberedSeat(): string {
  try {
    return sessionStorage.getItem(PENDING_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Note that this tab is going to Steam to take the seat it remembers; false when storage is blocked. */
export function meanToTake(): boolean {
  try {
    sessionStorage.setItem(TAKING_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

/** Whether this tab went to Steam to take the seat, which counts once: reading it clears it. */
export function cameBackToTake(): boolean {
  try {
    const set = sessionStorage.getItem(TAKING_KEY) === "1";
    sessionStorage.removeItem(TAKING_KEY);
    return set;
  } catch {
    return false;
  }
}

/** Forget the seat this tab was signing in for, once it is taken. */
export function forgetSeat(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
    sessionStorage.removeItem(TAKING_KEY);
  } catch {
    // Blocked storage held nothing.
  }
}

/** Steam sign-in that comes back to the seat: to plain /seat when this tab remembers it, so the token never rides through Steam. */
export function signInForSeat(token: string): string {
  const to = rememberSeat(token) ? SEAT_PATH : `${SEAT_PATH}/${token}`;
  return `${STEAM_LOGIN_URL}?to=${encodeURIComponent(to)}`;
}

/** The seat a token opens; "invalid" when the server says it opens nothing, null when it gave no answer. */
export async function openSeat(token: string, get: typeof fetch = fetch): Promise<Seat | "invalid" | null> {
  try {
    const response = await get(`/api/seats/${encodeURIComponent(token)}`);
    if (response.status === 404) return "invalid";
    return response.ok ? ((await response.json()) as { seat: Seat }).seat : null;
  } catch {
    return null;
  }
}

/**
 * Take the seat as the signed-in player: the crew it put them in and the seat,
 * "invalid" when the link opens nothing, why it was refused, or null when the
 * server gave no answer.
 */
export async function takeSeat(
  token: string,
  get: typeof fetch = fetch,
): Promise<{ crewId: string; seat: Seat } | "invalid" | { refused: SeatRefusal } | null> {
  try {
    const response = await get(`/api/seats/${encodeURIComponent(token)}/take`, { method: "POST" });
    if (response.status === 404) return "invalid";
    if (response.status === 409) {
      const { code } = (await response.json()) as { code?: string };
      const refused: SeatRefusal =
        code === "too-many-crews" ? "full" : code === "expired" || code === "own" ? code : "taken";
      return { refused };
    }
    return response.ok ? ((await response.json()) as { crewId: string; seat: Seat }) : null;
  } catch {
    return null;
  }
}

/** Whole days left before an open seat runs out, at least 1 while it has any time left. */
export const daysLeft = (expiresAt: number, now = Date.now()) =>
  Math.max(1, Math.ceil((expiresAt - now) / (24 * 60 * 60_000)));
