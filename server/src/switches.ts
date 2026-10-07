// Asking to play next, from the full-screen viewer: a crewmate watching wants
// to play another game, and everyone in the session votes on whether the
// player hands the crew's PC over.
//
//   POST /api/crew-live/:id/switch ──► open ──► most say yes (or the player does) ──► yes ──► save time ──► switch
//                                        │                                                    └──► player: saved / +2 minutes
//                                        └──► most say no, or no majority in VOTE_MS ──► no
//
// Who votes is fixed when it is asked: the player, everyone watching then, and
// whoever asks, who counts as yes. A yes puts the one who asked first in the
// crew's line with their game (platform.ts, queueFirst) and gives the player
// SAVE_MS to save, which they may cut short or stretch by MORE_MS up to
// MAX_MORE times; then the session ends (platform.ts, endLiveSession), and
// the PC is free for the one who asked to start their game.
//
// The state lives in this process, as watches do (watch.ts), and is gone with
// it: a vote under way when the server restarts is simply not there any more.

import { randomBytes } from "node:crypto";

/** How long the crew has to vote. */
export const VOTE_MS = 60_000;
/** How long the player has to save once the crew said yes. */
export const SAVE_MS = 180_000;
/** How much more time to save one "+2 minutes" gives. */
export const MORE_MS = 120_000;
/** How often the player may ask for more time. */
export const MAX_MORE = 2;
/** How long a vote that said no stays to be seen, before another may be asked. */
export const NO_SHOWN_MS = 8_000;

export type SwitchOutcome = "open" | "yes" | "no";

export type SwitchVote = {
  id: string;
  sessionId: string;
  /** The crew the session plays for, whose line the one who asked joins. */
  crewId: string | null;
  playerId: string;
  playerName: string | null;
  proposerId: string;
  proposerName: string | null;
  /** The Steam appid the one who asked wants to play. */
  gameId: number;
  /** Everyone who votes, the player and the one who asked included. */
  voters: string[];
  votes: Map<string, boolean>;
  startedAt: number;
  /** When the vote closes, Unix ms. */
  endsAt: number;
  outcome: SwitchOutcome;
  decidedAt: number | null;
  /** When the PC goes to the one who asked, Unix ms, once the crew said yes. */
  switchAt: number | null;
  /** How often the player asked for more time. */
  more: number;
};

/** A vote as one taking part sees it (`viewer`, their Steam id): never anyone's Steam id. */
export type SwitchView = {
  id: string;
  gameId: number;
  proposer: string | null;
  player: string | null;
  /** The viewer asked. */
  mine: boolean;
  /** The viewer is the player. */
  playing: boolean;
  voters: number;
  yes: number;
  no: number;
  /** The viewer's own vote; null while they have not voted, or do not vote. */
  vote: "yes" | "no" | null;
  canVote: boolean;
  endsAt: number;
  outcome: SwitchOutcome;
  switchAt: number | null;
  moreLeft: number;
  /** The server's clock as it answered, so a page counts down from it whatever its own says. */
  now: number;
};

export type ProposeResult = { ok: true; vote: SwitchVote } | { ok: false; reason: "open" | "switching" };

export type SwitchesOptions = {
  now?: () => number;
  voteMs?: number;
  saveMs?: number;
  moreMs?: number;
  /** The crew said yes: the one who asked goes first in its line. */
  onDecided?: (vote: SwitchVote) => void;
  /** The save time is up: the session ends. */
  onSwitch?: (vote: SwitchVote) => void;
  /** Timers, for tests. */
  setTimer?: (run: () => void, ms: number) => () => void;
};

const defaultTimer = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export class Switches {
  readonly #now: () => number;
  readonly #voteMs: number;
  readonly #saveMs: number;
  readonly #moreMs: number;
  readonly #onDecided: (vote: SwitchVote) => void;
  readonly #onSwitch: (vote: SwitchVote) => void;
  readonly #setTimer: (run: () => void, ms: number) => () => void;
  readonly #votes = new Map<string, SwitchVote>();
  readonly #timers = new Map<string, () => void>();

  constructor(opts: SwitchesOptions = {}) {
    this.#now = opts.now ?? Date.now;
    this.#voteMs = opts.voteMs ?? VOTE_MS;
    this.#saveMs = opts.saveMs ?? SAVE_MS;
    this.#moreMs = opts.moreMs ?? MORE_MS;
    this.#onDecided = opts.onDecided ?? (() => {});
    this.#onSwitch = opts.onSwitch ?? (() => {});
    this.#setTimer = opts.setTimer ?? defaultTimer;
  }

  /**
   * `proposer` asks to play `gameId` next on session `sessionId`; the caller
   * has checked they may watch it. `watching` are the Steam ids watching it
   * now. Refused while a vote is open ("open") or the crew already said yes
   * ("switching").
   */
  propose({
    sessionId,
    crewId,
    player,
    proposer,
    gameId,
    watching,
  }: {
    sessionId: string;
    crewId: string | null;
    player: { id: string; name: string | null };
    proposer: { id: string; name: string | null };
    gameId: number;
    watching: string[];
  }): ProposeResult {
    const was = this.of(sessionId);
    if (was?.outcome === "open") return { ok: false, reason: "open" };
    if (was?.outcome === "yes") return { ok: false, reason: "switching" };
    const now = this.#now();
    const vote: SwitchVote = {
      id: randomBytes(9).toString("base64url"),
      sessionId,
      crewId,
      playerId: player.id,
      playerName: player.name,
      proposerId: proposer.id,
      proposerName: proposer.name,
      gameId,
      voters: [...new Set([player.id, ...watching, proposer.id])],
      votes: new Map([[proposer.id, true]]),
      startedAt: now,
      endsAt: now + this.#voteMs,
      outcome: "open",
      decidedAt: null,
      switchAt: null,
      more: 0,
    };
    this.#votes.set(sessionId, vote);
    this.#settle(vote);
    return { ok: true, vote };
  }

  /** The session's vote as it stands now; null when there is none, or one that said no a while ago. */
  of(sessionId: string): SwitchVote | null {
    const vote = this.#votes.get(sessionId);
    if (!vote) return null;
    this.#settle(vote);
    if (vote.outcome === "no" && this.#now() >= vote.decidedAt! + NO_SHOWN_MS) {
      this.#votes.delete(sessionId);
      return null;
    }
    return vote;
  }

  /** `voterId` votes yes or no; their vote counts once and can change while it is open. */
  vote(sessionId: string, voterId: string, yes: boolean): SwitchVote | "none" | "not-voter" | "closed" {
    const vote = this.of(sessionId);
    if (!vote) return "none";
    if (!vote.voters.includes(voterId)) return "not-voter";
    if (vote.outcome !== "open") return "closed";
    vote.votes.set(voterId, yes);
    this.#settle(vote);
    return vote;
  }

  /**
   * The player, once the crew said yes: saved, switch now (`now`), or two
   * more minutes (`more`), up to MAX_MORE times. Null unless that is the case.
   */
  handOver(sessionId: string, playerId: string, ask: "now" | "more"): SwitchVote | null {
    const vote = this.of(sessionId);
    if (!vote || vote.playerId !== playerId || vote.outcome !== "yes") return null;
    if (ask === "more") {
      if (vote.more >= MAX_MORE) return null;
      vote.more += 1;
      vote.switchAt = vote.switchAt! + this.#moreMs;
    } else {
      vote.switchAt = this.#now();
    }
    this.#schedule(vote);
    return vote;
  }

  /** The session is over: its vote and timer go with it. */
  ended(sessionId: string): void {
    this.#timers.get(sessionId)?.();
    this.#timers.delete(sessionId);
    this.#votes.delete(sessionId);
  }

  /** The vote as `viewerId` sees it. */
  view(vote: SwitchVote, viewerId: string): SwitchView {
    const counted = [...vote.votes.values()];
    const mine = vote.votes.get(viewerId);
    return {
      id: vote.id,
      gameId: vote.gameId,
      proposer: vote.proposerName,
      player: vote.playerName,
      mine: vote.proposerId === viewerId,
      playing: vote.playerId === viewerId,
      voters: vote.voters.length,
      yes: counted.filter(Boolean).length,
      no: counted.filter((v) => !v).length,
      vote: mine === undefined ? null : mine ? "yes" : "no",
      canVote: vote.outcome === "open" && vote.voters.includes(viewerId),
      endsAt: vote.endsAt,
      outcome: vote.outcome,
      switchAt: vote.switchAt,
      moreLeft: MAX_MORE - vote.more,
      now: this.#now(),
    };
  }

  /**
   * Decide an open vote once it can be: the player's yes, or a yes from more
   * than half of the voters, says yes; no from at least half, or the time
   * running out before that, says no.
   */
  #settle(vote: SwitchVote): void {
    if (vote.outcome !== "open") return;
    const counted = [...vote.votes.values()];
    const yes = counted.filter(Boolean).length;
    const no = counted.length - yes;
    const n = vote.voters.length;
    const now = this.#now();
    let outcome: SwitchOutcome = "open";
    if (vote.votes.get(vote.playerId) === true || yes * 2 > n) outcome = "yes";
    else if (no * 2 >= n || now >= vote.endsAt) outcome = "no";
    if (outcome === "open") return;
    // Decided when it was: a vote whose time ran out unread closes at its end.
    vote.decidedAt = Math.min(now, vote.endsAt);
    vote.outcome = outcome;
    if (outcome === "yes") {
      vote.switchAt = now + this.#saveMs;
      this.#schedule(vote);
      this.#onDecided(vote);
    }
  }

  /** Have the session end once the save time is up. */
  #schedule(vote: SwitchVote): void {
    this.#timers.get(vote.sessionId)?.();
    this.#timers.set(
      vote.sessionId,
      this.#setTimer(
        () => {
          this.#timers.delete(vote.sessionId);
          if (this.#votes.get(vote.sessionId) === vote) this.#onSwitch(vote);
        },
        Math.max(0, vote.switchAt! - this.#now()),
      ),
    );
  }
}
