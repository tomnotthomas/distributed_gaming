// Watching a crewmate play, from the browser: what the crew is playing now,
// asking to watch, and the view-only watch itself.
//
//   GET /api/crew-live ──► "Mara is playing Elden Ring on Glasshouse" ──► Ask to watch
//   POST /api/crew-live/:id/watch ──► watch ticket ──► @swiff/rtc startWatchSession
//
// The crew band reads the list when the wall's event stream says something
// changed (useLive's crewTick), at most every MIN_GAP_MS, and every
// BACKSTOP_MS regardless. The watch ticket is a bearer credential: it is held
// in memory for the watch alone and never stored.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  startWatchSession,
  type ViewerVoice,
  type VoicePerson,
  type WatchSession,
  type WatchSessionEvent,
} from "@swiff/rtc";

/** A session a crewmate is playing now (server/src/api.ts, GET /api/crew-live). */
export type CrewLiveEntry = {
  sessionId: string;
  /** The player's Steam persona, as their crew knows it. */
  player: string | null;
  /** The Steam appid played. */
  gameId: number;
  /** The machine's name. */
  machine: string | null;
  startedAt: number | null;
  /** The player shares with the crew: watching needs no yes. */
  sharing: boolean;
  /** How many watch now. */
  watching: number;
  /** This player's own watch on it, if any. */
  mine: { state: "asking" | "watching" } | null;
};

/** Reads after a change wait at least this long after the last. */
export const MIN_GAP_MS = 3_000;
/** Read this often even with no change heard. */
export const BACKSTOP_MS = 60_000;

/** The crew's live sessions, or null when they cannot be read now. */
export async function fetchCrewLive(get: typeof fetch = fetch): Promise<CrewLiveEntry[] | null> {
  try {
    const res = await get("/api/crew-live");
    if (!res.ok) return null;
    const body = (await res.json()) as { live?: CrewLiveEntry[] };
    return Array.isArray(body.live) ? body.live : null;
  } catch {
    return null;
  }
}

export type WatchGrant = {
  watchId: string;
  state: "asking" | "watching";
  player: string | null;
  signalingUrl: string;
  ticket: string;
};

/** Why asking to watch did not go through. */
export type AskRefusal = "gone" | "full" | "cooldown" | "failed";

/** Ask to watch a crewmate's session: a watch ticket, or why not. */
export async function askToWatch(
  sessionId: string,
  get: typeof fetch = fetch,
): Promise<{ ok: true; grant: WatchGrant } | { ok: false; reason: AskRefusal }> {
  try {
    const res = await get(`/api/crew-live/${encodeURIComponent(sessionId)}/watch`, { method: "POST" });
    if (res.ok) return { ok: true, grant: (await res.json()) as WatchGrant };
    if (res.status === 404) return { ok: false, reason: "gone" };
    if (res.status === 409) return { ok: false, reason: "full" };
    if (res.status === 429) return { ok: false, reason: "cooldown" };
    return { ok: false, reason: "failed" };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** What the crew is playing now, kept current while `enabled`. */
export function useCrewLive({
  enabled,
  tick,
  fetch: get = fetch,
}: {
  enabled: boolean;
  /** Changes when the wall heard something may have changed. */
  tick: number;
  fetch?: typeof fetch;
}): { live: CrewLiveEntry[]; reload: () => void } {
  const [live, setLive] = useState<CrewLiveEntry[]>([]);
  const lastRead = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout>>();
  const read = useRef(0);

  const reload = useCallback(() => {
    if (!enabled || pending.current !== undefined) return;
    const wait = Math.max(0, lastRead.current + MIN_GAP_MS - Date.now());
    pending.current = setTimeout(() => {
      pending.current = undefined;
      lastRead.current = Date.now();
      const mine = ++read.current;
      void fetchCrewLive(get).then((next) => {
        if (next && mine === read.current) setLive(next);
      });
    }, wait);
  }, [enabled, get]);

  useEffect(() => {
    if (!enabled) {
      setLive([]);
      return;
    }
    reload();
  }, [enabled, tick, reload]);

  useEffect(() => {
    if (!enabled) return;
    const backstop = setInterval(reload, BACKSTOP_MS);
    return () => {
      clearInterval(backstop);
      clearTimeout(pending.current);
      pending.current = undefined;
    };
  }, [enabled, reload]);

  return { live, reload };
}

/** Where a watch stands, as the watch screen shows it. */
export type WatchState = {
  /** Asking for the ticket, waiting on the player's yes, watching, or over. */
  phase: "asking-server" | "asking" | "watching" | "over";
  player: string | null;
  /** The player's page is in the room. */
  playerHere: boolean;
  /** A picture has arrived. */
  framed: boolean;
  /** The browser refused sound: the picture plays muted until the viewer turns it on. */
  muted: boolean;
  /** Why it is over, when it is. */
  ended: AskRefusal | WatchEnd | "left" | null;
  roster: VoicePerson[];
  voice: ViewerVoice;
  /** People this viewer muted for themselves. */
  hushed: string[];
};

/** Why the server ended a watch. */
export type WatchEnd =
  | "watch-declined"
  | "watch-unanswered"
  | "watch-stopped"
  | "watch-ended"
  | "watch-left"
  | "watch-replaced"
  | "not-crew"
  | "bad-watch-ticket";

const NO_VOICE: ViewerVoice = {
  inVoice: false,
  muted: false,
  mode: "open",
  talking: false,
  micRefused: false,
  mutedByPlayer: false,
};

export type Watching = {
  state: WatchState;
  session: WatchSession | null;
  muteForMe: (id: string, muted: boolean) => void;
};

/**
 * Ask to watch `sessionId` and play it into `video` once the player says yes.
 * Ends the watch when the component goes, or `sessionId` changes.
 */
export function useWatching(
  sessionId: string | null,
  video: HTMLVideoElement | null,
  opts: { fetch?: typeof fetch; start?: typeof startWatchSession } = {},
): Watching {
  const [state, setState] = useState<WatchState>(() => initial(null));
  const [session, setSession] = useState<WatchSession | null>(null);
  const get = opts.fetch ?? fetch;
  const start = opts.start ?? startWatchSession;
  const deps = useRef({ get, start });
  deps.current = { get, start };

  useEffect(() => {
    if (!sessionId || !video) return;
    let gone = false;
    let current: WatchSession | null = null;
    setState(initial(null));
    const set = (next: Partial<WatchState>) => !gone && setState((s) => ({ ...s, ...next }));

    void askToWatch(sessionId, deps.current.get).then((asked) => {
      if (gone) return;
      if (!asked.ok) return set({ phase: "over", ended: asked.reason });
      const { grant } = asked;
      set({ phase: grant.state, player: grant.player });
      current = deps.current.start({ url: grant.signalingUrl, ticket: grant.ticket, video });
      setSession(current);
      current.on((event: WatchSessionEvent) => {
        switch (event.type) {
          case "watching":
            set({ phase: event.state, player: event.player ?? null, playerHere: event.playerHere });
            break;
          case "first-frame":
            set({ framed: true });
            break;
          case "peer-connection":
            if (!event.pc) set({ framed: false });
            break;
          case "autoplay-muted":
            set({ muted: true });
            break;
          case "roster":
            set({ roster: event.people });
            break;
          case "voice":
            set({ voice: event.voice });
            break;
          case "denied":
            set({ phase: "over", ended: event.reason as WatchEnd });
            break;
        }
      });
    });
    return () => {
      gone = true;
      current?.end();
      setSession(null);
    };
  }, [sessionId, video]);

  const muteForMe = useCallback(
    (id: string, muted: boolean) => {
      session?.muteForMe(id, muted);
      setState((s) => ({
        ...s,
        hushed: muted ? [...new Set([...s.hushed, id])] : s.hushed.filter((h) => h !== id),
      }));
    },
    [session],
  );

  return { state, session, muteForMe };
}

const initial = (player: string | null): WatchState => ({
  phase: "asking-server",
  player,
  playerHere: true,
  framed: false,
  muted: false,
  ended: null,
  roster: [],
  voice: NO_VOICE,
  hushed: [],
});

/** What a watch that is over says, for the player named. */
export function endedLine(ended: WatchState["ended"], player: string): string {
  switch (ended) {
    case "watch-declined":
      return `${player} would rather play alone right now.`;
    case "watch-unanswered":
      return `${player} didn't answer. They may be in the middle of something.`;
    case "watch-stopped":
      return `${player} stopped sharing with you.`;
    case "watch-ended":
    case "gone":
      return `${player}'s session is over.`;
    case "not-crew":
      return `You're no longer in a crew with ${player}.`;
    case "full":
      return `As many friends as can are watching ${player} already.`;
    case "cooldown":
      return `You asked ${player} a moment ago. Give it a minute.`;
    case "watch-replaced":
      return "You're watching in another tab.";
    default:
      return "Watching didn't work out. Try again from the wall.";
  }
}
