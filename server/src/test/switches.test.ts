// The crew's vote on who plays next (switches.ts): who votes, when it is
// decided, and the player's save time before the PC switches.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  MAX_MORE,
  MORE_MS,
  NO_SHOWN_MS,
  SAVE_MS,
  SWITCH_RETRY_MS,
  Switches,
  VOTE_MS,
  type SwitchVote,
} from "../switches.js";

const PLAYER = { id: "max", name: "Max" };
const KEMAL = { id: "kemal", name: "Kemal" };

let now: number;
let decided: SwitchVote[];
let switched: SwitchVote[];
/** How many of the next session ends fail. */
let failing: number;
/** Timers the switches set, as [when, run]: run by `advance`. */
let timers: { at: number; run: () => void; live: boolean }[];
let switches: Switches;

/** Move the clock on, running every timer due by then. */
function advance(ms: number) {
  now += ms;
  for (const timer of timers.filter((t) => t.live && t.at <= now)) {
    timer.live = false;
    timer.run();
  }
}

/** Kemal asks to play Deadlock with `watching` watching. */
function ask(watching = ["kemal", "lena", "jonas"]) {
  const asked = switches.propose({
    sessionId: "s1",
    crewId: "crew",
    player: PLAYER,
    proposer: KEMAL,
    gameId: 1422450,
    watching,
  });
  assert.ok(asked.ok);
  return asked.vote;
}

describe("switches", () => {
  beforeEach(() => {
    now = 1_000_000;
    decided = [];
    switched = [];
    failing = 0;
    timers = [];
    switches = new Switches({
      now: () => now,
      onDecided: (vote) => decided.push(vote),
      onSwitch: (vote) => {
        switched.push(vote);
        if (failing > 0) {
          failing--;
          return Promise.reject(new Error("the database is away"));
        }
      },
      setTimer: (run, ms) => {
        const timer = { at: now + ms, run, live: true };
        timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
    });
  });

  it("has the player, everyone watching and the one who asked vote, counting the asker as yes", () => {
    const vote = ask();
    const view = switches.view(vote, "lena");
    assert.equal(view.voters, 4);
    assert.equal(view.yes, 1);
    assert.equal(view.no, 0);
    assert.equal(view.canVote, true);
    assert.equal(view.vote, null);
    assert.equal(view.mine, false);
    assert.equal(switches.view(vote, "kemal").mine, true);
    assert.equal(switches.view(vote, "kemal").vote, "yes");
    assert.equal(view.endsAt, now + VOTE_MS);
    assert.equal(view.proposer, "Kemal");
  });

  it("says yes once more than half say yes, and gives the player their save time", () => {
    ask();
    assert.equal((switches.vote("s1", "lena", true) as SwitchVote).outcome, "open");
    const vote = switches.vote("s1", "jonas", true) as SwitchVote;
    assert.equal(vote.outcome, "yes");
    assert.equal(vote.switchAt, now + SAVE_MS);
    assert.deepEqual(decided, [vote]);
    advance(SAVE_MS - 1);
    assert.deepEqual(switched, []);
    advance(1);
    assert.deepEqual(switched, [vote]);
  });

  it("says yes at once when the player does", () => {
    ask();
    assert.equal((switches.vote("s1", "max", true) as SwitchVote).outcome, "yes");
  });

  it("says no once half say no, and lets someone else ask then", () => {
    ask();
    switches.vote("s1", "lena", false);
    const vote = switches.vote("s1", "max", false) as SwitchVote;
    assert.equal(vote.outcome, "no");
    assert.deepEqual(decided, []);
    const lena = () =>
      switches.propose({
        sessionId: "s1",
        crewId: "crew",
        player: PLAYER,
        proposer: { id: "lena", name: "Lena" },
        gameId: 440,
        watching: [],
      });
    const again = lena();
    assert.ok(again.ok);
    assert.equal(again.vote.proposerName, "Lena");
    assert.equal(switches.of("s1")?.outcome, "open");
  });

  it("says no when the time is up with only half saying yes", () => {
    ask();
    switches.vote("s1", "lena", true);
    advance(VOTE_MS);
    assert.equal(switches.of("s1")?.outcome, "no");
    assert.deepEqual(decided, []);
  });

  it("says no and does not switch when only the one who asked says yes by the time it is up", () => {
    ask(["kemal"]);
    advance(VOTE_MS);
    assert.equal(switches.of("s1")?.outcome, "no");
    advance(SAVE_MS);
    assert.deepEqual(decided, []);
    assert.deepEqual(switched, []);
  });

  it("says no when the time is up with more no than yes", () => {
    ask(["kemal", "lena", "jonas", "sami"]);
    switches.vote("s1", "lena", false);
    advance(VOTE_MS);
    assert.equal(switches.of("s1")?.outcome, "no");
    advance(NO_SHOWN_MS);
    assert.equal(switches.of("s1"), null);
  });

  it("lets only those in the session then vote, and nobody after it is decided", () => {
    ask();
    assert.equal(switches.vote("s1", "stranger", true), "not-voter");
    assert.equal(switches.vote("s2", "lena", true), "none");
    switches.vote("s1", "max", true);
    assert.equal(switches.vote("s1", "lena", false), "closed");
  });

  it("refuses a second ask while one is open or the crew said yes", () => {
    ask();
    const again = () =>
      switches.propose({
        sessionId: "s1",
        crewId: "crew",
        player: PLAYER,
        proposer: { id: "lena", name: "Lena" },
        gameId: 440,
        watching: [],
      });
    assert.deepEqual(again(), { ok: false, reason: "open" });
    switches.vote("s1", "max", true);
    assert.deepEqual(again(), { ok: false, reason: "switching" });
  });

  it("lets the player switch now, or take two more minutes a limited number of times", () => {
    ask();
    switches.vote("s1", "max", true);
    assert.equal(switches.handOver("s1", "lena", "more"), null);
    for (let i = 0; i < MAX_MORE; i++) assert.ok(switches.handOver("s1", "max", "more"));
    assert.equal(switches.handOver("s1", "max", "more"), null);
    assert.equal(switches.of("s1")?.switchAt, now + SAVE_MS + MAX_MORE * MORE_MS);
    advance(SAVE_MS);
    assert.deepEqual(switched, []);
    switches.handOver("s1", "max", "now");
    advance(0);
    assert.equal(switched.length, 1);
  });

  it("keeps the handover and tries ending the session again while that fails, then forgets it", async () => {
    const settled = () => new Promise((done) => setImmediate(done));
    ask();
    switches.vote("s1", "max", true);
    failing = 1;
    advance(SAVE_MS);
    await settled();
    assert.equal(switched.length, 1);
    assert.equal(switches.of("s1")?.outcome, "yes");
    // Switching already: the player can no longer stretch or cut it, so it never ends twice at once.
    assert.equal(switches.handOver("s1", "max", "more"), null);
    assert.equal(switches.handOver("s1", "max", "now"), null);
    advance(SWITCH_RETRY_MS - 1);
    assert.equal(switched.length, 1);
    advance(1);
    await settled();
    assert.equal(switched.length, 2);
    assert.equal(switches.of("s1"), null);
    advance(SWITCH_RETRY_MS);
    assert.equal(switched.length, 2);
  });

  it("turns the yes to no, and never switches, when the one who asked cannot go first in the line", () => {
    switches = new Switches({
      now: () => now,
      onDecided: () => false,
      onSwitch: (vote) => switched.push(vote),
      setTimer: (run, ms) => {
        const timer = { at: now + ms, run, live: true };
        timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
    });
    ask();
    const vote = switches.vote("s1", "max", true) as SwitchVote;
    assert.equal(vote.outcome, "no");
    assert.equal(vote.switchAt, null);
    assert.equal(switches.handOver("s1", "max", "now"), null);
    advance(SAVE_MS);
    assert.deepEqual(switched, []);
  });

  it("waits for the line before switching, and never switches when going first fails later", async () => {
    const settled = () => new Promise((done) => setImmediate(done));
    let answer!: (ok: boolean) => void;
    switches = new Switches({
      now: () => now,
      onDecided: () => new Promise<boolean>((done) => (answer = done)),
      onSwitch: (vote) => switched.push(vote),
      setTimer: (run, ms) => {
        const timer = { at: now + ms, run, live: true };
        timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
    });
    ask();
    switches.vote("s1", "max", true);
    // Saved at once, while the line is not known yet: the switch waits for it.
    assert.ok(switches.handOver("s1", "max", "now"));
    advance(0);
    await settled();
    assert.deepEqual(switched, []);
    answer(false);
    await settled();
    assert.deepEqual(switched, []);
    assert.equal(switches.of("s1")?.outcome, "no");
    advance(SAVE_MS);
    assert.deepEqual(switched, []);

    // Asked again, and this time the line takes them: the switch goes ahead once it does.
    now += NO_SHOWN_MS;
    ask();
    switches.vote("s1", "max", true);
    switches.handOver("s1", "max", "now");
    advance(0);
    await settled();
    assert.deepEqual(switched, []);
    answer(true);
    await settled();
    assert.equal(switched.length, 1);
  });

  it("forgets a session that ended, timer and all", () => {
    ask();
    switches.vote("s1", "max", true);
    switches.ended("s1");
    advance(SAVE_MS);
    assert.deepEqual(switched, []);
    assert.equal(switches.of("s1"), null);
  });
});
