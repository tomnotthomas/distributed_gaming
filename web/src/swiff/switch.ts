// Asking to play next from the full-screen viewer, and the crew's vote on it
// (server/src/switches.ts):
//
//   POST /api/crew-live/:id/switch ──► everyone in the session votes ──► yes: the player saves, then the PC switches
//
// The viewer and the player's own screen read the vote every POLL_MS while
// they are open: it lasts a minute, and a second's lag is fine for a tally.

import { useCallback, useEffect, useRef, useState } from "react";

/** How often an open viewer or player screen reads the vote. */
export const POLL_MS = 2_000;

/** The vote as one taking part sees it (server/src/switches.ts, SwitchView). */
export type SwitchView = {
  id: string;
  gameId: number;
  proposer: string | null;
  player: string | null;
  /** This viewer asked. */
  mine: boolean;
  /** This viewer is the player. */
  playing: boolean;
  voters: number;
  yes: number;
  no: number;
  vote: "yes" | "no" | null;
  canVote: boolean;
  endsAt: number;
  outcome: "open" | "yes" | "no";
  switchAt: number | null;
  moreLeft: number;
  /** The server's clock as it answered. */
  now: number;
};

type Answer = { ok: true; view: SwitchView | null } | { ok: false; status: number | null };

async function send(path: string, init: RequestInit, get: typeof fetch): Promise<Answer> {
  try {
    const res = await get(path, {
      ...init,
      ...(init.body ? { headers: { "content-type": "application/json" } } : {}),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = (await res.json()) as { switch?: SwitchView | null };
    return { ok: true, view: body.switch ?? null };
  } catch {
    return { ok: false, status: null };
  }
}

const base = (sessionId: string) => `/api/crew-live/${encodeURIComponent(sessionId)}`;

/** The session's vote now, null for none. */
export const fetchSwitch = (sessionId: string, get: typeof fetch = fetch) =>
  send(`${base(sessionId)}/switch`, {}, get);

/** Ask the crew to play `gameId` next. Refused 409 while the crew is deciding already. */
export const askToPlay = (sessionId: string, gameId: number, get: typeof fetch = fetch) =>
  send(`${base(sessionId)}/switch`, { method: "POST", body: JSON.stringify({ gameId }) }, get);

/** Vote yes or no. */
export const voteSwitch = (sessionId: string, yes: boolean, get: typeof fetch = fetch) =>
  send(`${base(sessionId)}/vote`, { method: "POST", body: JSON.stringify({ yes }) }, get);

/** As the player, once the crew said yes: switch now, or two more minutes to save. */
export const handOver = (sessionId: string, ask: "now" | "more", get: typeof fetch = fetch) =>
  send(`${base(sessionId)}/handover`, { method: "POST", body: JSON.stringify({ ask }) }, get);

/** Seconds from `now` to `at`, never below zero. */
export const secondsLeft = (at: number, now: number) => Math.max(0, Math.ceil((at - now) / 1000));

/** Seconds as the countdown shows them: "2:48", "0:42". */
export function clockOf(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The session's vote, read every POLL_MS while `sessionId` is set and kept as
 * last read once it is not, with a clock that ticks every second on the
 * server's time; `set` takes an answer the page got from acting on it.
 */
export function useSwitch(
  sessionId: string | null,
  get: typeof fetch = fetch,
): { view: SwitchView | null; now: number; set: (answer: Answer) => void } {
  const [view, setView] = useState<SwitchView | null>(null);
  // How far the server's clock is ahead of this page's.
  const skew = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const read = useRef(0);

  const set = useCallback((answer: Answer) => {
    if (!answer.ok) return;
    if (answer.view) skew.current = answer.view.now - Date.now();
    setView(answer.view);
  }, []);

  useEffect(() => {
    // Once the session is no longer followed, its last vote stays: the viewer
    // the crew chose is told it is their turn after the session ends.
    if (!sessionId) return;
    let live = true;
    const poll = () => {
      const mine = ++read.current;
      void fetchSwitch(sessionId, get).then((answer) => {
        if (live && mine === read.current) set(answer);
      });
    };
    poll();
    const every = setInterval(poll, POLL_MS);
    const tick = setInterval(() => setNow(Date.now() + skew.current), 1_000);
    return () => {
      live = false;
      clearInterval(every);
      clearInterval(tick);
    };
  }, [sessionId, get, set]);

  return { view, now: Math.max(now, Date.now() + skew.current), set };
}
