// Whether Swiff can run a game, without the network: every Steam, Valve and
// AreWeAntiCheatYet answer here is one recorded on 5 Oct 2026
// (fixtures/playable.json, trimmed to the fields the server reads), served
// through a stubbed fetch, so each rule is pinned on a real game and the wall
// is filtered from a real chart.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { popularGames, resetCatalog } from "../catalog.js";
import type { Database } from "../db.js";
import {
  antiCheatStatuses,
  CHECK_TTL_MS,
  FAILURE_WINDOW_MS,
  fetchSteamOsRating,
  judge,
  LAUNCH_FAILURE_MS,
  MAX_AGE_MS,
  Playability,
  steamOsRating,
  steamSources,
  type Evidence,
  type Sources,
} from "../playable.js";
import {
  curatedCloud,
  curatedRequirements,
  fetchAppDetails,
  recommendsBeyondTable,
} from "../requirements.js";
import { migrate } from "../schema.js";
import { testDatabase } from "./db.js";
import recordedJson from "./fixtures/playable.json" with { type: "json" };

const recorded = recordedJson as any;
const realFetch = globalThis.fetch;

/** The appids a GetItems request asked for. */
const askedFor = (url: URL): number[] =>
  JSON.parse(url.searchParams.get("input_json")!).ids.map((i: any) => i.appid);

/** Every URL fetched, answered from the recordings; anything not recorded is a 404. */
function serveRecorded(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: URL | string) => {
    urls.push(String(input));
    const url = new URL(String(input));
    let body: unknown;
    if (url.pathname === "/api/appdetails") {
      const appid = url.searchParams.get("appids")!;
      body = appid in recorded.appdetails ? { [appid]: recorded.appdetails[appid] } : undefined;
    } else if (url.pathname.endsWith("/ajaxgetdeckappcompatibilityreport")) {
      body = recorded.deck[url.searchParams.get("nAppID")!];
    } else if (url.pathname.includes("/GetMostPlayedGames/")) {
      body = recorded.charts;
    } else if (url.pathname.includes("/GetItems/")) {
      const ids = askedFor(url);
      const items = recorded.items.response.store_items.filter((item: any) => ids.includes(item.appid));
      body = { response: { store_items: items } };
    } else if (url.hostname === "raw.githubusercontent.com") {
      body = recorded.antiCheat;
    }
    return body === undefined
      ? new Response("{}", { status: 404 })
      : new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return urls;
}

/** AreWeAntiCheatYet's list as recorded: only the games used here, so short of the real list's length. */
const antiCheat = () => antiCheatStatuses(recorded.antiCheat);

/** The real sources over the recordings, but for the recorded anti-cheat list, which is cut to these games. */
const recordedSources: Sources = { ...steamSources, antiCheat: async () => antiCheat() };

/** One game's evidence, read through the real fetchers from the recordings, with any part replaced. */
async function evidenceOf(appid: number, replaced: Partial<Evidence> = {}): Promise<Evidence> {
  return {
    details: await fetchAppDetails(appid),
    steamos: await fetchSteamOsRating(appid),
    antiCheat: antiCheat().get(appid) ?? null,
    cloud: curatedCloud().get(appid) ?? null,
    curatedRequirements: curatedRequirements().has(appid),
    ...replaced,
  };
}

const verdictOf = async (appid: number, replaced: Partial<Evidence> = {}) =>
  judge(await evidenceOf(appid, replaced));

beforeEach(() => {
  serveRecorded();
  resetCatalog();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the rule", () => {
  it("finds a game every source answered for, and none objects to, playable", async () => {
    // The Witcher 3, Counter-Strike 2, Left 4 Dead 2, Dead by Daylight.
    for (const appid of [292030, 730, 550, 381210]) {
      assert.deepEqual(await verdictOf(appid), { verdict: "playable", reasons: [] }, String(appid));
    }
  });

  it("leaves out a game with a native Mac build", async () => {
    // Stardew Valley: nothing else against it.
    assert.deepEqual(await verdictOf(413150), { verdict: "not-playable", reasons: ["native-mac"] });
    // Dota 2, Valheim, Slay the Spire 2, Cyberpunk 2077 and Baldur's Gate 3 too.
    for (const appid of [570, 892970, 2868840, 1091500, 1086940]) {
      assert.ok((await verdictOf(appid)).reasons.includes("native-mac"), String(appid));
    }
  });

  it("refuses Denuvo", async () => {
    // Monster Hunter Wilds: "Denuvo Anti-tamper" in its DRM notice, and nothing else against it.
    assert.deepEqual(await verdictOf(2246340), { verdict: "not-playable", reasons: ["denuvo"] });
  });

  it("refuses a game that asks for a third-party account at start", async () => {
    // Red Dead Redemption 2: a Rockstar Games account.
    assert.deepEqual(await verdictOf(1174180), { verdict: "not-playable", reasons: ["third-party-account"] });
  });

  it("refuses an anti-cheat that is Denied or Broken on Linux", async () => {
    // Apex Legends: Denied, an EA account, and unsupported on SteamOS.
    assert.deepEqual(await verdictOf(1172470), {
      verdict: "not-playable",
      reasons: ["third-party-account", "anti-cheat-denied", "steamos-unsupported"],
    });
    // PUBG: Broken.
    assert.deepEqual(await verdictOf(578080), {
      verdict: "not-playable",
      reasons: ["anti-cheat-broken", "steamos-unsupported"],
    });
    // Marvel Rivals' anti-cheat is Running, which is no objection.
    assert.equal(antiCheat().get(2767030), "Running");
    assert.equal((await verdictOf(2767030)).verdict, "playable");
  });

  it("refuses a game Valve rates unsupported on SteamOS", async () => {
    // WARDOGS: nothing else against it.
    assert.deepEqual(await verdictOf(1867240), { verdict: "not-playable", reasons: ["steamos-unsupported"] });
  });

  it("refuses an app that is not a game", async () => {
    // FiveM is listed as advertising.
    assert.deepEqual(await verdictOf(2676230), { verdict: "not-playable", reasons: ["not-a-game"] });
  });

  it("refuses a game whose recommended GPU is newer than any host's", async () => {
    // The Witcher 3's recorded requirements, with the recommended card swapped for a newer one.
    const witcher = (await fetchAppDetails(292030))!;
    const recommended = String((witcher.pc_requirements as any).recommended).replace(
      /(<strong>Graphics:<\/strong>)[^<]*/,
      "$1 NVIDIA GeForce RTX 5070 or AMD Radeon RX 9070",
    );
    assert.notEqual(recommended, (witcher.pc_requirements as any).recommended);
    const details = { ...witcher, pc_requirements: { ...(witcher.pc_requirements as object), recommended } };
    assert.deepEqual(await verdictOf(292030, { details }), {
      verdict: "not-playable",
      reasons: ["gpu-beyond-hosts"],
    });
    // Requirements curated in the overrides file only name cards hosts have.
    assert.equal((await verdictOf(292030, { details, curatedRequirements: true })).verdict, "playable");
  });

  it("refuses a game whose publisher objects to cloud play, by the curated list", async () => {
    assert.deepEqual(await verdictOf(292030, { cloud: "deny" }), {
      verdict: "not-playable",
      reasons: ["cloud-denied"],
    });
    // An allowance is evidence, not a pass: it overrules nothing.
    assert.equal(curatedCloud().get(730), "allow");
    assert.deepEqual(await verdictOf(2246340, { cloud: "allow" }), {
      verdict: "not-playable",
      reasons: ["denuvo"],
    });
  });

  it("leaves a game Valve has not rated unknown, and one the store does not know", async () => {
    // Deadlock: Valve's own, its anti-cheat Supported, but not yet rated.
    assert.deepEqual(await verdictOf(1422450), { verdict: "unknown", reasons: ["steamos-unrated"] });
    assert.deepEqual(await verdictOf(999999999), {
      verdict: "unknown",
      reasons: ["not-on-store", "steamos-unrated"],
    });
    // A known objection still wins over a gap.
    assert.deepEqual(await verdictOf(999999999, { antiCheat: "Denied" }), {
      verdict: "not-playable",
      reasons: ["anti-cheat-denied"],
    });
  });
});

describe("reading the sources", () => {
  it("takes Valve's SteamOS rating, its Deck rating where there is none, and null for no report", () => {
    assert.equal(steamOsRating(recorded.deck["292030"]), 2);
    assert.equal(steamOsRating({ success: 1, results: { resolved_category: 3 } }), 3);
    assert.equal(steamOsRating(recorded.deck["999999999"]), null);
    assert.throws(() => steamOsRating(null));
    assert.throws(() => steamOsRating({ success: 2 }));
  });

  it("reads AreWeAntiCheatYet by Steam appid, and refuses a list cut short", async () => {
    assert.equal(antiCheat().get(578080), "Broken");
    assert.equal(antiCheat().get(1172470), "Denied");
    assert.throws(() => antiCheatStatuses({ games: [] }));
    await assert.rejects(steamSources.antiCheat());
  });

  it("treats a store answer with nothing about the app as no answer, not as no such app", async () => {
    globalThis.fetch = (async () => new Response("null")) as unknown as typeof fetch;
    await assert.rejects(fetchAppDetails(292030), /no answer/);
  });

  it("sees a recommended card newer than the GPU table, and only then", () => {
    const tiers = (graphics: string) => ({ recommended: `<strong>Graphics:</strong> ${graphics}<br>` });
    assert.equal(recommendsBeyondTable(tiers("NVIDIA GeForce RTX 5080")), true);
    assert.equal(recommendsBeyondTable(tiers("RTX 5070 or Radeon RX 9070 XT")), true);
    assert.equal(recommendsBeyondTable(tiers("RTX 5070 or RTX 3080")), false);
    assert.equal(recommendsBeyondTable(tiers("NVIDIA GeForce RTX 4090")), false);
    assert.equal(recommendsBeyondTable(tiers("A DirectX 12 card with 8 GB")), false);
    assert.equal(recommendsBeyondTable({ minimum: "<strong>Graphics:</strong> RTX 5090<br>" }), true);
    assert.equal(recommendsBeyondTable([]), false);
  });
});

describe("the wall", () => {
  let db: Database;
  beforeEach(async () => {
    db = await testDatabase();
    await migrate(db);
  });
  afterEach(() => db.close());

  it("shows only what Swiff can run of Steam's chart", async () => {
    const playability = new Playability(db, { sources: recordedSources, pauseMs: 0 });
    const chart: number[] = recorded.charts.response.ranks.map((r: any) => r.appid);
    playability.want(chart, { first: true });
    await playability.drained();

    const wall = (await popularGames(24, (appid) => playability.playable(appid))).map((g) => g.name);
    assert.deepEqual(wall, [
      "Counter-Strike 2",
      "The Witcher 3: Wild Hunt — Remastered",
      "Marvel Rivals",
      "Aniimo",
      "How to Fish",
      "Left 4 Dead 2",
      "Limbus Company",
      "Dead by Daylight",
      "The Outlast Trials",
      "Team Fortress 2",
    ]);
    // Of the chart as shown on 5 Oct: what cannot run on Swiff OS, and what has a Mac build.
    const unfiltered = (await popularGames(40)).map((g) => g.name);
    for (const left of [
      "PUBG: BATTLEGROUNDS",
      "Apex Legends™",
      "Grand Theft Auto V Legacy",
      "Tom Clancy's Rainbow Six Siege",
      "WARDOGS",
      "Dota 2",
      "Valheim",
      "Slay the Spire 2",
      "War Thunder",
      "The Binding of Isaac: Rebirth",
      "Geometry Dash",
      "Stardew Valley",
    ]) {
      assert.ok(unfiltered.includes(left), left);
      assert.ok(!wall.includes(left), left);
    }
  });

  it("shows nothing it has not checked", async () => {
    const playability = new Playability(db, { sources: recordedSources, pauseMs: 0 });
    assert.deepEqual(await popularGames(24, (appid) => playability.playable(appid)), []);
    assert.deepEqual(playability.verdict(730), { verdict: "unknown", reasons: ["not-checked"] });
  });
});

describe("checking", () => {
  let db: Database;
  let now: number;
  let asked: number[];
  let failing: boolean;
  /** The recordings, counting each store request and failing them all while `failing`. */
  const counted: Sources = {
    ...recordedSources,
    details: async (appid) => {
      asked.push(appid);
      if (failing) throw new Error("429");
      return recordedSources.details(appid);
    },
  };
  const open = () => new Playability(db, { sources: counted, now: () => now, pauseMs: 0, backoffMs: 0 });

  beforeEach(async () => {
    db = await testDatabase();
    await migrate(db);
    now = Date.UTC(2026, 9, 5, 12);
    asked = [];
    failing = false;
  });
  afterEach(() => db.close());

  it("stores each verdict with its reasons, for the next server to load", async () => {
    const first = open();
    first.want([292030, 413150]);
    await first.drained();
    const { rows } = await db.query("SELECT * FROM game_playability ORDER BY appid");
    assert.deepEqual(rows, [
      { appid: 292030, verdict: "playable", reasons: "[]", checked_at: now },
      { appid: 413150, verdict: "not-playable", reasons: '["native-mac"]', checked_at: now },
    ]);

    const next = open();
    await next.load();
    assert.equal(next.playable(292030), true);
    assert.deepEqual(next.verdict(413150), { verdict: "not-playable", reasons: ["native-mac"] });
  });

  it("checks the games asked for first ahead of the rest, each once a day", async () => {
    const playability = open();
    playability.want([413150, 292030]);
    playability.want([730], { first: true });
    await playability.drained();
    assert.deepEqual(asked, [413150, 730, 292030]);

    playability.want([730, 292030]);
    await playability.drained();
    assert.equal(asked.length, 3);
    now += CHECK_TTL_MS;
    playability.want([730]);
    await playability.drained();
    assert.deepEqual(asked, [413150, 730, 292030, 730]);
  });

  it("keeps the verdict it has when a check fails, until it is too old to trust", async () => {
    const playability = open();
    playability.want([292030]);
    await playability.drained();

    now += CHECK_TTL_MS;
    failing = true;
    playability.want([292030]);
    await playability.drained();
    assert.equal(asked.length, 2);
    assert.equal(playability.playable(292030), true);
    assert.equal(
      (await db.query("SELECT checked_at FROM game_playability")).rows[0]!.checked_at,
      now - CHECK_TTL_MS,
    );

    now += MAX_AGE_MS - CHECK_TTL_MS;
    assert.deepEqual(playability.verdict(292030), { verdict: "unknown", reasons: ["not-checked"] });
  });

  it("waits between store requests", async () => {
    const at: number[] = [];
    const playability = new Playability(db, {
      sources: {
        ...recordedSources,
        details: async (appid) => (at.push(Date.now()), recordedSources.details(appid)),
        steamos: async (appid) => (at.push(Date.now()), recordedSources.steamos(appid)),
      },
      pauseMs: 30,
    });
    playability.want([292030, 730]);
    await playability.drained();
    assert.equal(at.length, 4);
    for (let i = 1; i < at.length; i++) assert.ok(at[i]! - at[i - 1]! >= 25, `${at[i]! - at[i - 1]!} ms`);
  });
});

describe("launches that keep failing", () => {
  let db: Database;
  let now: number;
  let made = 0;
  beforeEach(async () => {
    db = await testDatabase();
    await migrate(db);
    now = Date.UTC(2026, 9, 5, 12);
  });
  afterEach(() => db.close());

  /** A session of `appid` on `machine` that ended `playedMs` after the renter started it, `ago` before now. */
  async function session(
    appid: number,
    machine: string,
    { playedMs = 60_000, reason = "renter", ago = 60_000, started = true } = {},
  ) {
    const id = `s-${++made}`;
    const ended = now - ago;
    await db.query(
      "INSERT INTO machines (id, status, last_seen_at) VALUES ($1, 'available', $2) ON CONFLICT DO NOTHING",
      [machine, now],
    );
    await db.query(
      `INSERT INTO bookings (id, game_id, minutes, status, created_at, last_seen_at)
       VALUES ($1, $2, 60, 'ended', $3, $3)`,
      [id, appid, ended - playedMs],
    );
    await db.query(
      `INSERT INTO sessions (id, booking_id, machine_id, started_at, ended_at, expires_at, end_reason)
       VALUES ($1, $1, $2, $3, $4, $5, $6)`,
      [id, machine, started ? ended - playedMs : null, ended, ended + 3_600_000, reason],
    );
  }

  /** A playability that has found The Witcher 3 playable, reading launch failures at `now`. */
  async function checked() {
    const playability = new Playability(db, { sources: recordedSources, now: () => now, pauseMs: 0 });
    playability.want([292030]);
    await playability.drained();
    await playability.loadFailures();
    return playability;
  }

  it("demotes a game whose launches keep failing on more than one machine", async () => {
    await session(292030, "pc-1");
    await session(292030, "pc-2", { reason: "host_end" });
    await session(292030, "pc-1", { playedMs: LAUNCH_FAILURE_MS - 1 });
    await session(292030, "pc-3", { playedMs: 3_600_000, reason: "time_up" });
    const playability = await checked();
    assert.deepEqual(playability.verdict(292030), { verdict: "not-playable", reasons: ["launch-failures"] });
    // The verdict stored stays Steam's: launch failures are read again each time.
    assert.equal((await db.query("SELECT verdict FROM game_playability")).rows[0]!.verdict, "playable");
  });

  it("lets it back once those failures age out of the window", async () => {
    for (const machine of ["pc-1", "pc-2", "pc-1"]) await session(292030, machine);
    const playability = await checked();
    assert.equal(playability.playable(292030), false);
    now += FAILURE_WINDOW_MS;
    // Checked again meanwhile, as every verdict is daily.
    playability.want([292030]);
    await playability.drained();
    await playability.loadFailures();
    assert.equal(playability.playable(292030), true);
  });

  it("does not demote for one machine's failures, a few among many, or what is not a failed launch", async () => {
    // Three quick ends, all on one PC: that PC's trouble, not the game's.
    for (let i = 0; i < 3; i++) await session(292030, "pc-1");
    // Three quick ends on two PCs, of seven sessions started.
    await session(730, "pc-1");
    await session(730, "pc-2");
    await session(730, "pc-2");
    for (let i = 0; i < 4; i++) await session(730, "pc-3", { playedMs: 3_600_000, reason: "time_up" });
    // Played past the launch, ended by the machine going away, or never started.
    for (const machine of ["pc-1", "pc-2", "pc-3"]) {
      await session(550, machine, { playedMs: LAUNCH_FAILURE_MS });
      await session(381210, machine, { reason: "host_offline" });
      await session(2767030, machine, { reason: "grace_expired", started: false });
    }
    const playability = new Playability(db, { sources: recordedSources, now: () => now, pauseMs: 0 });
    playability.want([292030, 730, 550, 381210, 2767030]);
    await playability.drained();
    await playability.loadFailures();
    for (const appid of [292030, 730, 550, 381210, 2767030]) {
      assert.equal(playability.playable(appid), true, String(appid));
    }
  });

  it("adds launch failures to a game's other objections", async () => {
    for (const machine of ["pc-1", "pc-2", "pc-3"]) await session(413150, machine);
    const playability = new Playability(db, { sources: recordedSources, now: () => now, pauseMs: 0 });
    playability.want([413150]);
    await playability.drained();
    await playability.loadFailures();
    assert.deepEqual(playability.verdict(413150), {
      verdict: "not-playable",
      reasons: ["native-mac", "launch-failures"],
    });
    // Nothing checked yet: the failures alone decide.
    for (const machine of ["pc-1", "pc-2", "pc-3"]) await session(1234, machine);
    await playability.loadFailures();
    assert.deepEqual(playability.verdict(1234), { verdict: "not-playable", reasons: ["launch-failures"] });
  });
});
