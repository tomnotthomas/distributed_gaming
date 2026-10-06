// Watching a crewmate play: who asked to watch which session, and who watches.
//
//   POST /api/crew/live/:id/watch ──► ask ──► asking ──► player: yes ──► watching ──► player: stop
//                                                  │                         └──► session over / not crew any more
//                                                  └──► player: no, or no answer in ASK_MS
//
// Only a crewmate of the player may ask (platform.ts, watchable), and only the
// player's yes lets them watch: a player who shares with their crew has said
// yes to everyone in it, asking or still to ask. Watching costs nothing: no
// booking, no machine, and the session's clock is the player's alone.
//
// The state lives in this process, next to the rooms it serves (index.ts),
// and is gone with it: a viewer whose server restarts asks again. Nothing of
// what is said or shown is ever kept: the server only introduces the player's
// page to the viewer's, and the picture, the sound and the voices go between
// them (or through the TURN relay), never through here.

import { randomBytes } from "node:crypto";
import { MAX_WATCHERS } from "./protocol.js";

/** How long a player has to answer a viewer asking, before it counts as no. */
export const ASK_MS = 60_000;
/** How long a viewer whose page left (a reload, a dropped socket) keeps its place, to come back on the same ticket. */
export const AWAY_MS = 30_000;
/**
 * How long a viewer turned down, unanswered or stopped waits before asking the
 * same session again. One who left by themselves may ask again at once.
 */
export const COOLDOWN_MS = 60_000;

/** Why a watch ended: what the viewer's socket is told (protocol.ts DeniedMessage). */
export type WatchEnd =
  | "watch-declined"
  | "watch-unanswered"
  | "watch-stopped"
  | "watch-ended"
  | "watch-left"
  | "not-crew";

export type Watch = {
  id: string;
  sessionId: string;
  /** The room the session is played in. */
  room: string;
  /** The viewer's Steam id. Never sent to the player. */
  viewerId: string;
  /** The viewer's Steam persona, when it could be read. */
  name: string | null;
  /** The player's, as their crew knows them. */
  playerName: string | null;
  state: "asking" | "watching";
  askedAt: number;
  /** Since when the viewer's page has not been in the room (not yet come, or left), Unix ms; null while it is. */
  awaySince: number | null;
  /** The ticket's expiry, Unix s: how long an end must be remembered to refuse it. */
  exp: number;
};

export type AskResult =
  | { ok: true; watch: Watch }
  | { ok: false; reason: "full" }
  | { ok: false; reason: "cooldown"; retryAfterMs: number };

export type WatchesOptions = {
  now?: () => number;
  askMs?: number;
  awayMs?: number;
  cooldownMs?: number;
  maxWatchers?: number;
};

type SessionWatches = { sharing: boolean; watches: Map<string, Watch> };

export class Watches {
  readonly #now: () => number;
  readonly #askMs: number;
  readonly #awayMs: number;
  readonly #cooldownMs: number;
  readonly #max: number;
  readonly #sessions = new Map<string, SessionWatches>();
  readonly #byId = new Map<string, Watch>();
  /** Watches that ended, by id, with why and until when (Unix ms) a ticket for one could still be shown. */
  readonly #over = new Map<string, { reason: WatchEnd; until: number }>();
  /** `${sessionId}:${viewerId}` → until when (Unix ms) that viewer may not ask that session again. */
  readonly #cooldown = new Map<string, number>();

  constructor(opts: WatchesOptions = {}) {
    this.#now = opts.now ?? Date.now;
    this.#askMs = opts.askMs ?? ASK_MS;
    this.#awayMs = opts.awayMs ?? AWAY_MS;
    this.#cooldownMs = opts.cooldownMs ?? COOLDOWN_MS;
    this.#max = opts.maxWatchers ?? MAX_WATCHERS;
  }

  /**
   * `viewerId` asks to watch session `sessionId` in `room`; the caller has
   * checked they may (platform.ts, watchable). Asked again while their watch
   * is on, it is the same watch. A session whose player shares with their
   * crew is watched at once. `exp` is the session's deadline (Unix s).
   */
  ask(
    {
      sessionId,
      room,
      playerName,
      exp,
    }: { sessionId: string; room: string; playerName: string | null; exp: number },
    viewer: { id: string; name: string | null },
  ): AskResult {
    const viewerId = viewer.id;
    const now = this.#now();
    const session = this.#session(sessionId);
    for (const watch of session.watches.values()) {
      if (watch.viewerId === viewerId) return { ok: true, watch };
    }
    const until = this.#cooldown.get(`${sessionId}:${viewerId}`) ?? 0;
    if (until > now) return { ok: false, reason: "cooldown", retryAfterMs: until - now };
    if (session.watches.size >= this.#max) return { ok: false, reason: "full" };
    const watch: Watch = {
      id: randomBytes(12).toString("base64url"),
      sessionId,
      room,
      viewerId,
      name: viewer.name,
      playerName,
      state: session.sharing ? "watching" : "asking",
      askedAt: now,
      // Not here until the viewer's page takes its seat with the ticket.
      awaySince: now,
      exp,
    };
    session.watches.set(watch.id, watch);
    this.#byId.set(watch.id, watch);
    return { ok: true, watch };
  }

  /** The watch with this id while it is on; null once it is over, or never was. */
  get(watchId: string): Watch | null {
    return this.#byId.get(watchId) ?? null;
  }

  /** Why the watch with this id ended, while a ticket for it could still be shown; null otherwise. */
  over(watchId: string): WatchEnd | null {
    return this.#over.get(watchId)?.reason ?? null;
  }

  /** Every watch on a session, in the order they asked. */
  list(sessionId: string): Watch[] {
    return [...(this.#sessions.get(sessionId)?.watches.values() ?? [])];
  }

  /** Every watch on, on every session. */
  all(): Watch[] {
    return [...this.#byId.values()];
  }

  /** Whether the player of `sessionId` shares with their crew. */
  sharing(sessionId: string): boolean {
    return this.#sessions.get(sessionId)?.sharing ?? false;
  }

  /**
   * The player opens their screen to their crew, or closes it. Opening lets
   * everyone asking watch at once; closing stops nobody already watching.
   * Returns the watches it let in.
   */
  share(sessionId: string, open: boolean): Watch[] {
    const session = this.#session(sessionId);
    session.sharing = open;
    if (!open) {
      this.#forget(sessionId);
      return [];
    }
    const admitted: Watch[] = [];
    for (const watch of session.watches.values()) {
      if (watch.state === "asking") {
        watch.state = "watching";
        admitted.push(watch);
      }
    }
    return admitted;
  }

  /**
   * The player's answer to a viewer asking: yes, they watch; no, the watch
   * ends. Null, changing nothing, unless `watchId` is asking on `sessionId`.
   */
  answer(sessionId: string, watchId: string, accept: boolean): Watch | null {
    const watch = this.#byId.get(watchId);
    if (!watch || watch.sessionId !== sessionId || watch.state !== "asking") return null;
    if (!accept) return this.end(watchId, "watch-declined");
    watch.state = "watching";
    return watch;
  }

  /** End a watch, for `reason`. Returns it, or null when it was not on. */
  end(watchId: string, reason: WatchEnd): Watch | null {
    const watch = this.#byId.get(watchId);
    if (!watch) return null;
    this.#byId.delete(watchId);
    this.#sessions.get(watch.sessionId)?.watches.delete(watchId);
    this.#forget(watch.sessionId);
    const now = this.#now();
    this.#over.set(watchId, { reason, until: Math.max(now, watch.exp * 1000) });
    if (reason === "watch-declined" || reason === "watch-unanswered" || reason === "watch-stopped") {
      this.#cooldown.set(`${watch.sessionId}:${watch.viewerId}`, now + this.#cooldownMs);
    }
    return watch;
  }

  /** End every watch on a session that is over. Returns them. */
  endSession(sessionId: string): Watch[] {
    const ended = this.list(sessionId).map((watch) => this.end(watch.id, "watch-ended")!);
    this.#sessions.delete(sessionId);
    return ended;
  }

  /** The viewer's page left the room at `at`; back clears it. */
  away(watchId: string, at = this.#now()): void {
    const watch = this.#byId.get(watchId);
    if (watch && watch.awaySince === null) watch.awaySince = at;
  }

  back(watchId: string): void {
    const watch = this.#byId.get(watchId);
    if (watch) watch.awaySince = null;
  }

  /**
   * What time has ended: a viewer asking past ASK_MS (unanswered), and one whose
   * page has been away past AWAY_MS (it left). Also forgets ends and
   * cooldowns no ticket or ask could still meet. Returns the watches it ended.
   */
  expire(): { watch: Watch; reason: WatchEnd }[] {
    const now = this.#now();
    const ended: { watch: Watch; reason: WatchEnd }[] = [];
    for (const watch of this.all()) {
      let reason: WatchEnd | null = null;
      if (watch.state === "asking" && now - watch.askedAt >= this.#askMs) reason = "watch-unanswered";
      else if (watch.awaySince !== null && now - watch.awaySince >= this.#awayMs) reason = "watch-left";
      if (reason) ended.push({ watch: this.end(watch.id, reason)!, reason });
    }
    for (const [id, { until }] of this.#over) if (until <= now) this.#over.delete(id);
    for (const [key, until] of this.#cooldown) if (until <= now) this.#cooldown.delete(key);
    return ended;
  }

  #session(sessionId: string): SessionWatches {
    let session = this.#sessions.get(sessionId);
    if (!session) {
      session = { sharing: false, watches: new Map() };
      this.#sessions.set(sessionId, session);
    }
    return session;
  }

  /** Drop a session's entry once nobody watches it and it is not shared. */
  #forget(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (session && !session.sharing && !session.watches.size) this.#sessions.delete(sessionId);
  }
}
