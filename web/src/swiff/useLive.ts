// Keeps a signed-in renter's wall and open game page on the real hosts.
//
// The wall's counts and the open game's machines are read once the page has
// timed its round trip to the server, then again whenever the event stream
// GET /api/events says availability changed (a machine was offered, taken,
// freed or taken back). Those come in bursts, so a read waits until
// MIN_GAP_MS after the last. While the stream is down the page asks every
// SLOW_POLL_MS instead; EventSource reconnects by itself. Every BACKSTOP_MS it
// asks regardless, since an offer that simply runs out sends no event. A read
// the server refuses as over budget (429) is tried again once Retry-After has
// passed, and until then the last answer stays up; a wall read in parts keeps
// the parts already answered, and the next read of the same question, a retry
// or a refresh, asks only for the rest.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Prefs } from "./derive";
import {
  askOf,
  fetchAvailability,
  fetchMachines,
  measureRtt,
  type Answer,
  type GameAvailability,
  type GameMachines,
} from "./live";

/** Reads after a change wait at least this long after the last one. */
export const MIN_GAP_MS = 3_000;
/** While the stream is down, ask this often. */
export const SLOW_POLL_MS = 30_000;
/** Ask this often even while the stream is up: an offer running out sends no event. */
export const BACKSTOP_MS = 120_000;
/** The round trip assumed while it cannot be measured (the server did not answer the ping). */
const UNMEASURED_RTT_MS = 50;

/** The part of EventSource this hook uses, so tests can stand in for it. */
export type EventStream = Pick<EventSource, "addEventListener" | "close">;

const browserEventSource =
  typeof EventSource === "undefined" ? null : (url: string): EventStream => new EventSource(url);

export type LiveOptions = {
  /** Signed in and not the demo: the only time there is anything to read. */
  enabled: boolean;
  /** The games on the wall. */
  appids: number[];
  /** The game page open, if any. */
  appid: number | null;
  /** Tonight's length: ready means free for all of it. */
  minutes: number;
  prefs: Prefs;
  fetch?: typeof fetch;
  /** Opens the event stream; null polls only. Defaults to the browser's EventSource where there is one. */
  eventSource?: ((url: string) => EventStream) | null;
};

/** What has been read, and when (Unix ms), to tell its clock times by. */
export type Live = {
  /** `question` says which session length and settings the counts were for (questionOf). */
  wall: { at: number; question: string; games: Map<number, GameAvailability> } | null;
  game: { at: number; machines: GameMachines } | null;
  /** The renter's round trip to the server in ms, as timed against GET /api/ping; null until measured. */
  rttMs: number | null;
};

/** The session length and settings a read asks about, as one comparable string. */
export const questionOf = (minutes: number, prefs: Prefs) =>
  `${minutes}|${prefs.quality}|${prefs.devices.join(",")}`;

export function useLive({
  enabled,
  appids,
  appid,
  minutes,
  prefs,
  fetch: get = fetch,
  eventSource = browserEventSource,
}: LiveOptions): Live {
  const [rtt, setRtt] = useState<number | null>(null);
  const [wall, setWall] = useState<Live["wall"]>(null);
  const [game, setGame] = useState<Live["game"]>(null);

  // One key per question, so a new wall or a new session asks again and an
  // unchanged one does not.
  const wallIds = useMemo(() => [...new Set(appids)].sort((a, b) => a - b), [appids]);
  const wallKey = wallIds.join(",");
  const askKey = questionOf(minutes, prefs);

  // The latest question, for reads that a timer or the stream starts.
  const latest = useRef({ wallIds, appid, minutes, prefs, rtt, get, eventSource });
  latest.current = { wallIds, appid, minutes, prefs, rtt, get, eventSource };

  /** Which read is current, so an answer to an older question is dropped. */
  const wallRead = useRef(0);
  const gameRead = useRef(0);
  const wallRetry = useRef<ReturnType<typeof setTimeout>>();
  const gameRetry = useRef<ReturnType<typeof setTimeout>>();
  const lastRead = useRef(0);

  /** Ask `read` again after `retryAfterMs` when the server said so; a plain failure waits for the next change or poll. */
  const retryLater = (timer: typeof wallRetry, answer: Answer<unknown>, again: () => void) => {
    if (answer.ok || answer.retryAfterMs === null) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(again, answer.retryAfterMs);
  };

  /** The parts of a wall read the server stopped short of, for the question they answer. */
  const partial = useRef<{ key: string; games: GameAvailability[] } | null>(null);

  /** Read the wall, going on from the parts already read for the same question rather than from the first. */
  const readWall = useCallback(() => {
    const { wallIds, minutes, prefs, rtt, get } = latest.current;
    if (rtt === null || !wallIds.length) return;
    const read = ++wallRead.current;
    const question = questionOf(minutes, prefs);
    const key = `${rtt}|${question}|${wallIds.join(",")}`;
    clearTimeout(wallRetry.current);
    lastRead.current = Date.now();
    const kept = partial.current?.key === key ? partial.current.games : [];
    void fetchAvailability(wallIds, minutes, askOf(rtt, prefs), get, kept).then((answer) => {
      if (read !== wallRead.current) return;
      if (answer.ok) {
        partial.current = null;
        setWall({ at: Date.now(), question, games: new Map(answer.value.map((g) => [g.appid, g])) });
      } else {
        partial.current = { key, games: answer.read };
        retryLater(wallRetry, answer, readWall);
      }
    });
  }, []);

  const readGame = useCallback(() => {
    const { appid, minutes, prefs, rtt, get } = latest.current;
    if (rtt === null || appid === null) return;
    const read = ++gameRead.current;
    clearTimeout(gameRetry.current);
    lastRead.current = Date.now();
    void fetchMachines(appid, minutes, askOf(rtt, prefs), get).then((answer) => {
      if (read !== gameRead.current) return;
      if (answer.ok) setGame({ at: Date.now(), machines: answer.value });
      else retryLater(gameRetry, answer, readGame);
    });
  }, []);

  // Signed in: time the round trip once. Signed out: forget everything read.
  useEffect(() => {
    if (!enabled) {
      setRtt(null);
      setWall(null);
      setGame(null);
      return;
    }
    let current = true;
    // Pings stop once signed out or gone, so no timing outlives the page.
    const get: typeof fetch = (input, init) =>
      current ? latest.current.get(input, init) : Promise.reject(new Error("stopped"));
    void measureRtt(get).then((ms) => {
      if (current) setRtt(ms ?? UNMEASURED_RTT_MS);
    });
    return () => {
      current = false;
      wallRead.current += 1;
      gameRead.current += 1;
      partial.current = null;
      clearTimeout(wallRetry.current);
      clearTimeout(gameRetry.current);
    };
  }, [enabled]);

  useEffect(() => {
    if (enabled && rtt !== null) readWall();
  }, [enabled, rtt, wallKey, askKey, readWall]);

  useEffect(() => {
    if (!enabled || rtt === null) return;
    if (appid === null) {
      gameRead.current += 1;
      setGame(null);
      return;
    }
    readGame();
  }, [enabled, rtt, appid, askKey, readGame]);

  // The event stream, the slow poll while it is down, and the backstop.
  useEffect(() => {
    if (!enabled || rtt === null) return;
    let pending: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    /** Read both again, once MIN_GAP_MS has passed since the last read. */
    const refresh = () => {
      if (pending !== undefined) return;
      const wait = Math.max(0, lastRead.current + MIN_GAP_MS - Date.now());
      pending = setTimeout(() => {
        pending = undefined;
        readWall();
        readGame();
      }, wait);
    };
    const startPolling = () => {
      if (poll === undefined) poll = setInterval(refresh, SLOW_POLL_MS);
    };
    const stopPolling = () => {
      clearInterval(poll);
      poll = undefined;
    };

    const backstop = setInterval(refresh, BACKSTOP_MS);
    const { eventSource } = latest.current;
    let stream: EventStream | null = null;
    if (!eventSource) startPolling();
    else {
      stream = eventSource("/api/events");
      let dropped = false;
      stream.addEventListener("availability", refresh);
      // Back after a drop: whatever changed meanwhile was missed, so ask again.
      stream.addEventListener("open", () => {
        stopPolling();
        if (dropped) refresh();
        dropped = false;
      });
      // Dropped: EventSource retries by itself, and the poll covers the gap. One
      // the server refused (signed out, too many streams) is never retried, so
      // the poll carries on alone.
      stream.addEventListener("error", () => {
        dropped = true;
        startPolling();
      });
    }
    return () => {
      clearTimeout(pending);
      stopPolling();
      clearInterval(backstop);
      stream?.close();
    };
  }, [enabled, rtt, readWall, readGame]);

  return { wall, game, rttMs: rtt };
}
