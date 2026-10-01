// The booking lifecycle and machine liveness, against a real SQLite database
// in memory and a clock the tests move by hand.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  LIVENESS_MS,
  Platform,
  QOS_GRACE_MS,
  QUEUE_TIMEOUT_MS,
  RESERVATION_MS,
  TIME_UP_GRACE_MS,
  type MachineSpec,
} from "../platform.js";
import { REPORT } from "./report.js";

let now: number;
let platform: Platform;

beforeEach(() => {
  now = Date.UTC(2026, 8, 30, 12);
  platform = new Platform({ now: () => now });
});

/** Offer a machine that has every test game and the hardware for it. */
const offer = (machineId: string, spec: MachineSpec = {}) =>
  platform.setAvailability(machineId, true, { ...REPORT, ...spec });

const advance = (ms: number) => {
  now += ms;
  platform.tick();
};

/** Keep a machine alive across `ms`, beating every 5 s as the host app does. */
const beatFor = (machineId: string, ms: number) => {
  for (let t = 0; t < ms; t += 5_000) {
    advance(Math.min(5_000, ms - t));
    platform.heartbeat(machineId);
  }
};

describe("booking lifecycle", () => {
  it("goes queued -> matched -> claimed -> playing -> ended", () => {
    const booking = platform.book(730, 30);
    assert.equal(booking.status, "queued");

    offer("pc-1", { price: 120 });
    const matched = platform.booking(booking.bookingId)!;
    assert.equal(matched.status, "matched");
    assert.equal(matched.machine?.id, "pc-1");
    assert.equal(matched.claimBy, now + RESERVATION_MS);
    assert.equal(platform.heartbeat("pc-1").status, "reserved");

    const claim = platform.claim(booking.bookingId);
    assert.ok(claim.ok);
    assert.equal(claim.roomId, "pc-1");
    assert.equal(claim.minutes, 30);
    assert.equal(platform.booking(booking.bookingId)!.status, "claimed");
    const machine = platform.heartbeat("pc-1");
    assert.equal(machine.status, "in_session");
    assert.equal(machine.session?.id, claim.sessionId);

    assert.ok(platform.startSession("pc-1", claim.sessionId));
    assert.equal(platform.booking(booking.bookingId)!.status, "playing");

    beatFor("pc-1", 20 * 60_000);
    assert.ok(platform.endSession("pc-1", claim.sessionId));
    assert.equal(platform.booking(booking.bookingId)!.status, "ended");
    assert.equal(platform.heartbeat("pc-1").status, "available");
  });

  it("matches a booking at once when a machine is already free", () => {
    offer("pc-1");
    const booking = platform.book(730, 30);
    assert.equal(booking.status, "matched");
    assert.equal(booking.machine?.id, "pc-1");
  });

  it("refuses a claim once the reservation has lapsed and the renter is gone, and frees the machine", () => {
    offer("pc-1");
    const { bookingId } = platform.book(730, 30);

    beatFor("pc-1", QUEUE_TIMEOUT_MS);
    const claim = platform.claim(bookingId);
    assert.deepEqual(claim, { ok: false, reason: "not-claimable", status: "expired" });
    assert.equal(platform.booking(bookingId)!.status, "expired");
    assert.equal(platform.heartbeat("pc-1").status, "available");
  });

  it("refuses a claim that is too early, a second claim, and an unknown booking", () => {
    const { bookingId } = platform.book(730, 30);
    assert.deepEqual(platform.claim(bookingId), { ok: false, reason: "not-claimable", status: "queued" });

    offer("pc-1");
    assert.ok(platform.claim(bookingId).ok);
    assert.deepEqual(platform.claim(bookingId), { ok: false, reason: "not-claimable", status: "claimed" });
    assert.deepEqual(platform.claim("nope"), { ok: false, reason: "not-found" });
  });

  it("gives a machine to at most one booking, and the next one waits in order", () => {
    offer("pc-1");
    const first = platform.book(730, 30);
    const second = platform.book(570, 30);
    assert.equal(first.status, "matched");
    assert.equal(second.status, "queued");

    const claim = platform.claim(first.bookingId);
    assert.ok(claim.ok);
    assert.equal(platform.booking(second.bookingId)!.status, "queued");

    platform.endSession("pc-1", claim.sessionId);
    assert.equal(platform.booking(second.bookingId)!.status, "matched");
  });

  it("does not match a machine that is not free for the whole booking", () => {
    offer("pc-1", { availableUntil: now + 20 * 60_000 });
    const long = platform.book(730, 30);
    const short = platform.book(570, 15);
    assert.equal(platform.booking(long.bookingId)!.status, "queued");
    assert.equal(platform.booking(short.bookingId)!.machine?.id, "pc-1");
  });

  it("prices only the time actually played", () => {
    offer("pc-1", { price: 120 }); // cents per hour
    const { bookingId } = platform.book(730, 60);
    const claim = platform.claim(bookingId);
    assert.ok(claim.ok);
    beatFor("pc-1", 5 * 60_000); // the renter takes five minutes to arrive
    platform.startSession("pc-1", claim.sessionId);
    beatFor("pc-1", 30 * 60_000);
    platform.endSession("pc-1", claim.sessionId);
    assert.equal(platform.booking(bookingId)!.price, 60);
  });

  it("ends a session the host never ends when its ticket runs out", () => {
    offer("pc-1");
    const { bookingId } = platform.book(730, 10);
    const claim = platform.claim(bookingId);
    assert.ok(claim.ok);

    beatFor("pc-1", 10 * 60_000);
    assert.equal(platform.booking(bookingId)!.status, "ended");
    assert.equal(platform.heartbeat("pc-1").status, "available");
    assert.equal(platform.startSession("pc-1", claim.sessionId), false);
  });

  it("only lets a machine start and end its own sessions", () => {
    offer("pc-1");
    platform.setAvailability("pc-2", false);
    const { bookingId } = platform.book(730, 30);
    const claim = platform.claim(bookingId);
    assert.ok(claim.ok);
    assert.equal(platform.sessionMachine(claim.sessionId), "pc-1");
    assert.equal(platform.startSession("pc-2", claim.sessionId), false);
    assert.equal(platform.endSession("pc-2", claim.sessionId), false);
    assert.equal(platform.booking(bookingId)!.status, "claimed");
  });
});

describe("queue timeout", () => {
  it("drops a queued booking the renter stopped checking on, and never matches it", () => {
    const { bookingId } = platform.book(730, 30);
    advance(QUEUE_TIMEOUT_MS);
    offer("pc-1");
    assert.equal(platform.heartbeat("pc-1").status, "available");
    assert.equal(platform.booking(bookingId)!.status, "expired");
    assert.deepEqual(platform.claim(bookingId), { ok: false, reason: "not-claimable", status: "expired" });
  });

  it("keeps a queued booking whose renter comes back within the timeout", () => {
    const { bookingId } = platform.book(730, 30);
    advance(QUEUE_TIMEOUT_MS - 1_000); // the laptop slept
    assert.equal(platform.booking(bookingId)!.status, "queued");
    advance(QUEUE_TIMEOUT_MS - 1_000); // the same renter, polling again, keeps it alive
    assert.equal(platform.booking(bookingId)!.status, "queued");

    offer("pc-1");
    assert.equal(platform.booking(bookingId)!.status, "matched");
  });

  it("keeps the booking of a renter who was away while its reservation lapsed", () => {
    offer("pc-1");
    const first = platform.claim(platform.book(730, 30).bookingId);
    assert.ok(first.ok);
    const { bookingId } = platform.book(730, 30); // the renter's laptop sleeps
    const behind = platform.book(570, 30);

    beatFor("pc-1", 10_000);
    platform.endSession("pc-1", first.sessionId); // pc-1 frees while they are away
    assert.equal(platform.booking(behind.bookingId)!.status, "queued");
    beatFor("pc-1", RESERVATION_MS); // and the reservation lapses unclaimed

    const back = platform.booking(bookingId)!; // back inside 2 minutes
    assert.equal(back.status, "matched");
    assert.equal(back.machine?.id, "pc-1");
    assert.equal(platform.booking(behind.bookingId)!.status, "queued");
    assert.ok(platform.claim(bookingId).ok);
  });

  it("expires the booking of a renter who saw the match and let it lapse, and serves the next", () => {
    offer("pc-1");
    const first = platform.claim(platform.book(730, 30).bookingId);
    assert.ok(first.ok);
    const { bookingId } = platform.book(730, 30);
    const behind = platform.book(570, 30);

    beatFor("pc-1", 10_000);
    platform.endSession("pc-1", first.sessionId);
    assert.equal(platform.booking(bookingId)!.status, "matched"); // the renter is there and sees it
    assert.equal(platform.booking(behind.bookingId)!.status, "queued");
    beatFor("pc-1", RESERVATION_MS); // and never claims

    assert.equal(platform.booking(bookingId)!.status, "expired");
    const next = platform.booking(behind.bookingId)!;
    assert.equal(next.status, "matched");
    assert.equal(next.machine?.id, "pc-1");
  });
});

describe("join ticket revocation", () => {
  const claimed = () => {
    offer("pc-1");
    const { bookingId } = platform.book(730, 30);
    const claim = platform.claim(bookingId);
    assert.ok(claim.ok);
    platform.recordTicket(claim.sessionId, "ticket-1");
    assert.equal(platform.ticketRevoked("ticket-1"), false);
    return claim;
  };

  it("revokes the ticket when the host ends the session", () => {
    const claim = claimed();
    platform.endSession("pc-1", claim.sessionId);
    assert.equal(platform.ticketRevoked("ticket-1"), true);
  });

  it("revokes the ticket when the owner takes the machine back", () => {
    claimed();
    platform.setAvailability("pc-1", false);
    assert.equal(platform.ticketRevoked("ticket-1"), true);
  });

  it("revokes the ticket when the machine goes silent", () => {
    claimed();
    advance(LIVENESS_MS);
    assert.equal(platform.ticketRevoked("ticket-1"), true);
  });

  it("revokes the ticket when the session runs past its time", () => {
    claimed();
    beatFor("pc-1", 30 * 60_000);
    assert.equal(platform.ticketRevoked("ticket-1"), true);
  });

  it("leaves a ticket minted by hand, with no session, alone", () => {
    assert.equal(platform.ticketRevoked("hand-minted"), false);
  });

  it("waits out another connection's write lock on the file instead of failing the check", async () => {
    const { spawn } = await import("node:child_process");
    await withDatabaseFile(async (path) => {
      platform = new Platform({ path, now: () => now });
      claimed();
      // Another process ends the session, holding the lock a moment first.
      const writer = spawn(
        process.execPath,
        [
          "-e",
          `const db = new (require("node:sqlite").DatabaseSync)(process.argv[1]);
           db.exec("BEGIN EXCLUSIVE");
           db.exec("UPDATE sessions SET ended_at = 1");
           console.log("locked");
           setTimeout(() => { db.exec("COMMIT"); db.close(); }, 300);`,
          path,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      await new Promise((resolve) => writer.stdout.once("data", resolve));
      assert.equal(platform.ticketRevoked("ticket-1"), true);
      await new Promise((resolve) => writer.once("exit", resolve));
      platform.close();
    });
  });
});

describe("session end notice", () => {
  let ended: string[];

  beforeEach(() => {
    ended = [];
    platform = new Platform({ now: () => now, onSessionEnded: (machineId) => ended.push(machineId) });
  });

  const claimed = () => {
    offer("pc-1");
    const claim = platform.claim(platform.book(730, 30).bookingId);
    assert.ok(claim.ok);
    assert.deepEqual(ended, []);
    return claim;
  };

  it("tells the server when the booked time runs out", () => {
    claimed();
    beatFor("pc-1", 30 * 60_000);
    assert.deepEqual(ended, ["pc-1"]);
  });

  it("tells the server when the machine goes silent", () => {
    claimed();
    advance(LIVENESS_MS);
    assert.deepEqual(ended, ["pc-1"]);
  });

  it("tells the server when the owner takes the machine back", () => {
    claimed();
    platform.setAvailability("pc-1", false);
    assert.deepEqual(ended, ["pc-1"]);
  });

  it("tells the server when the host ends the session", () => {
    const claim = claimed();
    platform.endSession("pc-1", claim.sessionId);
    assert.deepEqual(ended, ["pc-1"]);
  });

  it("tells the server only once the end is committed", () => {
    // Reading the platform from inside the notice would open a second
    // transaction if the first were still open, and throw.
    const seen: (string | undefined)[] = [];
    platform = new Platform({
      now: () => now,
      onSessionEnded: () => seen.push(platform.booking(bookingId)?.status),
    });
    offer("pc-1");
    const { bookingId } = platform.book(730, 30);
    assert.ok(platform.claim(bookingId).ok);
    platform.setAvailability("pc-1", false);
    assert.deepEqual(seen, ["ended"]);
  });

  it("keeps the session ended, and the sweep going, when the notice fails", () => {
    platform = new Platform({
      now: () => now,
      onSessionEnded: () => {
        throw new Error("eviction failed");
      },
    });
    offer("pc-1");
    const first = platform.book(730, 10);
    assert.ok(platform.claim(first.bookingId).ok);

    beatFor("pc-1", 10 * 60_000);
    assert.equal(platform.booking(first.bookingId)!.status, "ended");
    assert.equal(platform.book(570, 10).machine?.id, "pc-1");
  });
});

describe("machine liveness", () => {
  it("stops offering a machine within seconds of its heartbeats stopping", () => {
    offer("pc-1");
    beatFor("pc-1", 60_000);
    assert.equal(platform.heartbeat("pc-1").status, "available");

    advance(LIVENESS_MS);
    const booking = platform.book(730, 30);
    assert.equal(booking.status, "queued");
  });

  it("keeps offering a machine whose heartbeats keep coming", () => {
    offer("pc-1");
    beatFor("pc-1", 10 * 60_000);
    assert.equal(platform.book(730, 30).status, "matched");
  });

  it("hands a reserved booking to another machine when its machine goes silent", () => {
    offer("pc-1");
    const { bookingId } = platform.book(730, 30);
    assert.equal(platform.booking(bookingId)!.machine?.id, "pc-1");

    offer("pc-2");
    beatFor("pc-2", LIVENESS_MS); // pc-1 says nothing
    const moved = platform.booking(bookingId)!;
    assert.equal(moved.status, "matched");
    assert.equal(moved.machine?.id, "pc-2");
  });

  it("ends the session of a machine that goes silent mid-game", () => {
    offer("pc-1");
    const { bookingId } = platform.book(730, 30);
    const claim = platform.claim(bookingId);
    assert.ok(claim.ok);
    platform.startSession("pc-1", claim.sessionId);

    advance(LIVENESS_MS);
    assert.equal(platform.booking(bookingId)!.status, "ended");
  });

  it("offers a dropped machine again when its heartbeats resume", () => {
    offer("pc-1");
    advance(LIVENESS_MS);
    assert.equal(platform.book(730, 30).status, "queued");

    const machine = platform.heartbeat("pc-1");
    assert.equal(machine.status, "reserved");
  });

  it("takes a machine back at once, ending what it was doing", () => {
    offer("pc-1");
    const { bookingId } = platform.book(730, 30);
    const claim = platform.claim(bookingId);
    assert.ok(claim.ok);

    assert.equal(platform.setAvailability("pc-1", false).status, "idle");
    assert.equal(platform.booking(bookingId)!.status, "ended");
    assert.equal(platform.book(570, 30).status, "queued");
  });

  it("keeps its state in the database file across restarts", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "swiff-platform-"));
    try {
      const path = join(dir, "swiff.db");
      const first = new Platform({ path, now: () => now });
      first.setAvailability("pc-1", true, REPORT);
      const { bookingId } = first.book(730, 30);
      first.close();

      const second = new Platform({ path, now: () => now });
      assert.equal(second.booking(bookingId)!.status, "matched");
      second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Run `work` with a fresh SQLite file path, removed afterwards. */
async function withDatabaseFile(work: (path: string) => void | Promise<void>): Promise<void> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "swiff-platform-"));
  try {
    await work(join(dir, "swiff.db"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("host profiles", () => {
  it("stores the report and reads it back, with the GPU's score from the table", () => {
    offer("pc-1");
    assert.deepEqual(platform.machineProfile("pc-1"), {
      id: "pc-1",
      name: REPORT.name,
      hardware: { ...REPORT.hardware, gpuScore: 230 },
      games: [...REPORT.games].sort((a, b) => a - b),
      controls: REPORT.controls,
      net: REPORT.net,
    });
    assert.equal(platform.heartbeat("pc-1").gpu, REPORT.hardware.gpu);
  });

  it("scores a GPU the table does not know as 0", () => {
    offer("pc-1", { hardware: { ...REPORT.hardware, gpu: "Mystery Card 9000" } });
    assert.equal(platform.machineProfile("pc-1")!.hardware!.gpuScore, 0);
  });

  it("replaces the games list when a heartbeat carries one, and keeps it when it does not", () => {
    offer("pc-1");
    platform.heartbeat("pc-1", { games: [440] });
    assert.deepEqual(platform.machineProfile("pc-1")!.games, [440]);

    platform.heartbeat("pc-1", { net: { rttMs: 30, jitterMs: 4, upMbps: 20 } });
    const profile = platform.machineProfile("pc-1")!;
    assert.deepEqual(profile.games, [440]);
    assert.deepEqual(profile.net, { rttMs: 30, jitterMs: 4, upMbps: 20 });
    assert.deepEqual(profile.hardware?.gpu, REPORT.hardware.gpu);
  });

  it("knows nothing about a machine that has not reported", () => {
    assert.equal(platform.machineProfile("pc-9"), null);
    platform.heartbeat("pc-1");
    assert.deepEqual(platform.machineProfile("pc-1"), {
      id: "pc-1",
      name: null,
      hardware: null,
      games: [],
      controls: [],
      net: null,
    });
  });

  it("adds the report columns to a database file made before them", async () => {
    await withDatabaseFile(async (path) => {
      const { DatabaseSync } = await import("node:sqlite");
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE machines (
        id TEXT PRIMARY KEY, owner_id TEXT, gpu TEXT, cpu TEXT, price INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL, available_until INTEGER, last_seen_at INTEGER NOT NULL)`);
      old.exec(`INSERT INTO machines (id, gpu, status, last_seen_at) VALUES ('pc-1', 'RTX 3060', 'idle', 0)`);
      old.close();

      const reopened = new Platform({ path, now: () => now });
      reopened.setAvailability("pc-1", true, REPORT);
      assert.equal(reopened.machineProfile("pc-1")!.hardware!.gpuScore, 230);
      assert.equal(reopened.book(730, 30).status, "matched");
      reopened.close();
    });
  });
});

describe("matching on the game and the hardware", () => {
  it("skips a machine without the game installed", () => {
    offer("pc-1", { games: [570] });
    const booking = platform.book(730, 30);
    assert.equal(booking.status, "queued");

    platform.heartbeat("pc-1", { games: [570, 730] });
    assert.equal(platform.booking(booking.bookingId)!.status, "matched");
  });

  it("skips a machine below the game's minimum GPU, RAM or VRAM", () => {
    const low = [
      { ...REPORT.hardware, gpu: "Intel UHD Graphics 630" },
      { ...REPORT.hardware, ramMb: 4_096 },
      { ...REPORT.hardware, vramMb: 512 },
    ];
    low.forEach((hardware, i) => offer(`low-${i}`, { hardware, price: 10 }));
    // Counter-Strike 2 asks for a GTX 1050, 8 GB of RAM and 1 GB of VRAM.
    const { bookingId, status } = platform.book(730, 30);
    assert.equal(status, "queued");

    offer("pc-1", { price: 500 });
    assert.equal(platform.booking(bookingId)!.machine?.id, "pc-1");
  });

  it("skips a machine that has never reported its hardware or games", () => {
    platform.setAvailability("pc-1", true);
    assert.equal(platform.book(730, 30).status, "queued");
  });

  it("still picks the cheapest of the machines that qualify", () => {
    offer("pc-1", { price: 300 });
    offer("pc-2", { price: 100 });
    offer("pc-3", { price: 50, games: [570] });
    assert.equal(platform.book(730, 30).machine?.id, "pc-2");
  });

  it("matches a booking to a machine of the right game when another game is waiting first", () => {
    offer("pc-1", { games: [570] });
    const first = platform.book(730, 30);
    const second = platform.book(570, 30);
    assert.equal(platform.booking(first.bookingId)!.status, "queued");
    assert.equal(platform.booking(second.bookingId)!.machine?.id, "pc-1");
  });

  it("never matches a renter to their own machine", async () => {
    await withDatabaseFile(async (path) => {
      const setup = new Platform({ path, now: () => now });
      setup.setAvailability("pc-1", true, REPORT);
      setup.close();
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(path);
      db.exec("UPDATE machines SET owner_id = 'steam:1' WHERE id = 'pc-1'");
      db.close();

      const reopened = new Platform({ path, now: () => now });
      assert.equal(reopened.book(730, 30, "steam:1").status, "queued");
      assert.equal(reopened.book(730, 30, "steam:2").machine?.id, "pc-1");
      reopened.close();
    });
  });
});

describe("claim notice and host sessions", () => {
  it("tells the server which machine was claimed, with the session, game and minutes", () => {
    const claims: unknown[] = [];
    platform = new Platform({
      now: () => now,
      onSessionClaimed: (machineId, claim) => claims.push({ machineId, ...claim }),
    });
    offer("pc-1");
    const { bookingId } = platform.book(730, 45);
    assert.deepEqual(claims, [], "not told on a match");
    const claim = platform.claim(bookingId);
    assert.ok(claim.ok);
    assert.deepEqual(claims, [{ machineId: "pc-1", sessionId: claim.sessionId, gameId: 730, minutes: 45 }]);
    assert.ok(!platform.claim(bookingId).ok);
    assert.equal(claims.length, 1, "a refused claim tells nothing");
  });

  it("names the session claimed on a machine only while it runs", () => {
    offer("pc-1");
    assert.equal(platform.claimedSession("pc-1"), null);
    const claim = platform.claim(platform.book(730, 30).bookingId);
    assert.ok(claim.ok);
    assert.deepEqual(platform.claimedSession("pc-1"), {
      sessionId: claim.sessionId,
      gameId: 730,
      minutes: 30,
    });
    assert.equal(platform.claimedSession("pc-2"), null);
    platform.endSession("pc-1", claim.sessionId);
    assert.equal(platform.claimedSession("pc-1"), null);
  });

  it("removes the host session together with the session it serves, and tells the server its id", () => {
    const ended: [string, string][] = [];
    platform = new Platform({
      now: () => now,
      onSessionEnded: (machineId, id) => ended.push([machineId, id]),
    });
    offer("pc-1");
    const claim = platform.claim(platform.book(730, 30).bookingId);
    assert.ok(claim.ok);
    const store = platform.keySessions;
    assert.ok(store.add("pc-1", { sessionId: claim.sessionId, grantId: "g1" }));
    assert.ok(!store.add("pc-1", { sessionId: claim.sessionId, grantId: "g2" }), "one per machine");
    assert.deepEqual(store.get("pc-1"), { sessionId: claim.sessionId, grantId: "g1" });

    advance(LIVENESS_MS); // the machine goes silent and its session ends
    assert.equal(store.get("pc-1"), null);
    assert.deepEqual(ended, [["pc-1", claim.sessionId]]);
  });

  it("ends a host session on its own, leaving the session running", () => {
    offer("pc-1");
    const claim = platform.claim(platform.book(730, 30).bookingId);
    assert.ok(claim.ok);
    const store = platform.keySessions;
    store.add("pc-1", { sessionId: claim.sessionId, grantId: "g1" });
    assert.equal(store.remove("pc-1"), claim.sessionId);
    assert.equal(store.remove("pc-1"), null);
    assert.equal(platform.claimedSession("pc-1")?.sessionId, claim.sessionId);
  });

  it("keeps host sessions in the database file across restarts", async () => {
    await withDatabaseFile((path) => {
      const first = new Platform({ path, now: () => now });
      first.setAvailability("pc-1", true, REPORT);
      const claim = first.claim(first.book(730, 30).bookingId);
      assert.ok(claim.ok);
      first.keySessions.add("pc-1", { sessionId: claim.sessionId, grantId: "g1" });
      first.close();

      const second = new Platform({ path, now: () => now });
      assert.deepEqual(second.keySessions.get("pc-1"), { sessionId: claim.sessionId, grantId: "g1" });
      second.close();
    });
  });
});

describe("session end reasons", () => {
  /** A claimed 30-minute session on pc-1 with join ticket "ticket-1", started unless told otherwise. */
  const session = (start = true) => {
    offer("pc-1");
    const claim = platform.claim(platform.book(730, 30).bookingId);
    assert.ok(claim.ok);
    platform.recordTicket(claim.sessionId, "ticket-1");
    if (start) assert.ok(platform.startSession("pc-1", claim.sessionId));
    return claim.sessionId;
  };

  it("is renter when the renter leaves with the session's own ticket", () => {
    const id = session();
    beatFor("pc-1", 60_000);
    assert.equal(platform.leaveSession(id, "ticket-1"), "ok");
    assert.equal(platform.sessionEndReason(id), "renter");
    assert.equal(platform.heartbeat("pc-1").status, "available");
    assert.equal(platform.ticketRevoked("ticket-1"), true);
  });

  it("lets only the session's own ticket leave it, and only while it runs", () => {
    const id = session();
    assert.equal(platform.leaveSession(id, "ticket-2"), "wrong-ticket");
    assert.equal(platform.leaveSession("no-such-session", "ticket-1"), "not-found");
    assert.equal(platform.sessionEndReason(id), null);
    platform.setAvailability("pc-1", false);
    assert.equal(platform.leaveSession(id, "ticket-1"), "over");
    assert.equal(platform.sessionEndReason(id), "owner_kill");
  });

  it("is host_end when the host ends a session before its expiry, whatever the host meant", () => {
    const id = session();
    beatFor("pc-1", 60_000);
    platform.endSession("pc-1", id);
    assert.equal(platform.sessionEndReason(id), "host_end");
  });

  it("is host_end when the host backdates its end to look like it ran its time", () => {
    const id = session();
    beatFor("pc-1", 60_000);
    platform.endSession("pc-1", id, now + 30 * 60_000);
    assert.equal(platform.sessionEndReason(id), "host_end");
  });

  it("is time_up when the host ends it within the grace before its expiry", () => {
    const id = session();
    now += 30 * 60_000 - 5_000; // no tick: the host's timer runs slightly ahead of the server's
    platform.endSession("pc-1", id);
    assert.equal(platform.sessionEndReason(id), "time_up");
  });

  it("is host_end when the host ends it just outside the grace before its expiry", () => {
    const id = session();
    now += 30 * 60_000 - TIME_UP_GRACE_MS - 1_000;
    platform.endSession("pc-1", id);
    assert.equal(platform.sessionEndReason(id), "host_end");
  });

  it("is time_up when the host ends it once the server sees it past its expiry", () => {
    const id = session();
    now += 30 * 60_000; // no tick: the host's end arrives before the backstop
    platform.endSession("pc-1", id);
    assert.equal(platform.sessionEndReason(id), "time_up");
  });

  it("is owner_kill when the owner takes the machine back", () => {
    const id = session();
    platform.setAvailability("pc-1", false);
    assert.equal(platform.sessionEndReason(id), "owner_kill");
  });

  it("is host_offline when the machine goes silent", () => {
    const id = session();
    advance(LIVENESS_MS);
    assert.equal(platform.sessionEndReason(id), "host_offline");
  });

  it("is time_up when a started session runs past its time unended", () => {
    const id = session();
    beatFor("pc-1", 30 * 60_000);
    assert.equal(platform.sessionEndReason(id), "time_up");
  });

  it("is grace_expired when the renter claimed and never arrived", () => {
    const id = session(false);
    beatFor("pc-1", 30 * 60_000);
    assert.equal(platform.sessionEndReason(id), "grace_expired");
  });

  it("is null while the session runs", () => {
    assert.equal(platform.sessionEndReason(session()), null);
  });
});

describe("machine uptime", () => {
  const uptime = () => {
    const { stats } = platform.stability("pc-1");
    return { offeredMs: Math.round(stats.offeredHours * 3_600_000), coverage: stats.heartbeatCoverage };
  };

  it("counts every heartbeat-covered moment while offered", () => {
    offer("pc-1");
    beatFor("pc-1", 10 * 60_000);
    assert.deepEqual(uptime(), { offeredMs: 10 * 60_000, coverage: 1 });
    assert.equal(platform.stability("pc-1").stats.dropsPerHour, 0);
  });

  it("counts a liveness drop, and the time offline as offered but unseen", () => {
    offer("pc-1");
    beatFor("pc-1", 60_000);
    advance(LIVENESS_MS); // dropped: seen until now, then nothing
    advance(45_000);
    // Still offline: the time since the drop counts without a check-in.
    assert.deepEqual(uptime(), { offeredMs: 120_000, coverage: 75 / 120 });
    platform.heartbeat("pc-1");
    assert.deepEqual(uptime(), { offeredMs: 120_000, coverage: 75 / 120 });
    assert.equal(platform.stability("pc-1").stats.dropsPerHour, 1 / (120 / 3600));
  });

  it("does not count a drop when the host shuts down after its offer ended", () => {
    offer("pc-1", { availableUntil: now + 62_000 });
    beatFor("pc-1", 60_000);
    advance(LIVENESS_MS + 60_000);
    assert.equal(platform.stability("pc-1").stats.dropsPerHour, 0);
    assert.deepEqual(uptime(), { offeredMs: 62_000, coverage: 1 });
  });

  it("counts a drop when the host goes silent well before its offer ends", () => {
    offer("pc-1", { availableUntil: now + 10 * 60_000 });
    beatFor("pc-1", 60_000);
    advance(LIVENESS_MS + 60_000);
    const { stats } = platform.stability("pc-1");
    assert.equal(Math.round(stats.dropsPerHour * stats.offeredHours), 1);
  });

  it("keeps the whole UTC day the seven-day window starts in", () => {
    offer("pc-1");
    beatFor("pc-1", 60 * 60_000);
    platform.setAvailability("pc-1", false);
    advance(7 * 24 * 3_600_000 - 30 * 60_000);
    platform.heartbeat("pc-1");
    assert.deepEqual(uptime(), { offeredMs: 60 * 60_000, coverage: 1 });
  });

  it("does not count time the machine was taken back", () => {
    offer("pc-1");
    beatFor("pc-1", 60_000);
    platform.setAvailability("pc-1", false);
    advance(60 * 60_000);
    platform.heartbeat("pc-1");
    offer("pc-1");
    beatFor("pc-1", 10_000);
    assert.deepEqual(uptime(), { offeredMs: 70_000, coverage: 1 });
  });

  it("stops counting at the end of the offer", () => {
    offer("pc-1", { availableUntil: now + 30_000 });
    beatFor("pc-1", 60_000);
    assert.deepEqual(uptime(), { offeredMs: 30_000, coverage: 1 });
  });

  it("splits time across UTC midnight into each day's row", () => {
    now = Date.UTC(2026, 8, 30, 23, 59, 50);
    offer("pc-1");
    beatFor("pc-1", 20_000);
    assert.deepEqual(uptime(), { offeredMs: 20_000, coverage: 1 });
  });

  it("forgets days older than the seven-day window", () => {
    offer("pc-1");
    beatFor("pc-1", 10_000);
    platform.setAvailability("pc-1", false);
    advance(8 * 24 * 3_600_000);
    assert.deepEqual(uptime(), { offeredMs: 0, coverage: 1 });
  });
});

describe("renter QoS", () => {
  const REPORT_GOOD = { fps: 60, bitrate: 20e6, rttMs: 12, packetLoss: 0.001 };

  /** A claimed session on pc-1 whose join ticket is "ticket-1". */
  const claimed = () => {
    offer("pc-1");
    const claim = platform.claim(platform.book(730, 30).bookingId);
    assert.ok(claim.ok);
    platform.recordTicket(claim.sessionId, "ticket-1");
    return claim.sessionId;
  };

  it("keeps a summary of the session's reports", () => {
    const id = claimed();
    assert.equal(platform.sessionQos(id), null);
    assert.equal(platform.recordQos(id, "ticket-1", REPORT_GOOD), "ok");
    assert.equal(platform.recordQos(id, "ticket-1", { ...REPORT_GOOD, fps: 30, packetLoss: 0.003 }), "ok");
    assert.deepEqual(platform.sessionQos(id), {
      reports: 2,
      fps: 45,
      bitrate: 20e6,
      rttMs: 12,
      packetLoss: 0.002,
    });
  });

  it("takes reports only with the session's own ticket", () => {
    const id = claimed();
    assert.equal(platform.recordQos(id, "ticket-2", REPORT_GOOD), "wrong-ticket");
    assert.equal(platform.recordQos("no-such-session", "ticket-1", REPORT_GOOD), "not-found");
    assert.equal(platform.sessionQos(id), null);
  });

  it("refuses every report for a session handed out with no ticket", () => {
    offer("pc-1");
    const claim = platform.claim(platform.book(730, 30).bookingId);
    assert.ok(claim.ok);
    assert.equal(platform.recordQos(claim.sessionId, "", REPORT_GOOD), "wrong-ticket");
  });

  it("takes a last report shortly after the session ends, and none later", () => {
    const id = claimed();
    platform.endSession("pc-1", id);
    now += QOS_GRACE_MS;
    assert.equal(platform.recordQos(id, "ticket-1", REPORT_GOOD), "ok");
    now += 1;
    assert.equal(platform.recordQos(id, "ticket-1", REPORT_GOOD), "over");
  });
});

describe("machine stability", () => {
  /** A two-hour session on pc-1, left by the renter, reporting `packetLoss`. */
  const play = (packetLoss: number) => {
    const claim = platform.claim(platform.book(730, 180).bookingId);
    assert.ok(claim.ok);
    platform.recordTicket(claim.sessionId, `ticket-${claim.sessionId}`);
    assert.ok(platform.startSession("pc-1", claim.sessionId));
    beatFor("pc-1", 2 * 3_600_000);
    platform.recordQos(claim.sessionId, `ticket-${claim.sessionId}`, {
      fps: 60,
      bitrate: 20e6,
      rttMs: 12,
      packetLoss,
    });
    assert.equal(platform.leaveSession(claim.sessionId, `ticket-${claim.sessionId}`), "ok");
  };

  it("is New for a machine never heard from", () => {
    assert.equal(platform.stability("pc-9").stability, "new");
  });

  it("is New until five sessions and ten offered hours, then reads the week", () => {
    offer("pc-1");
    for (let i = 0; i < 4; i++) play(0.002);
    assert.equal(platform.stability("pc-1").stability, "new");
    play(0.002);
    const { stats, stability } = platform.stability("pc-1");
    assert.deepEqual(stats, {
      heartbeatCoverage: 1,
      dropsPerHour: 0,
      sessionCompletion: 1,
      packetLoss: 0.002,
      sessions: 5,
      offeredHours: 10,
    });
    assert.equal(stability, "steady");
  });

  it("is Shaky for a machine whose renters lose too many packets", () => {
    offer("pc-1");
    for (let i = 0; i < 5; i++) play(0.05);
    assert.equal(platform.stability("pc-1").stability, "shaky");
  });

  it("only counts the last seven days of sessions", () => {
    offer("pc-1");
    for (let i = 0; i < 5; i++) play(0.05);
    platform.setAvailability("pc-1", false);
    advance(8 * 24 * 3_600_000);
    const { stats } = platform.stability("pc-1");
    assert.equal(stats.sessions, 0);
    assert.equal(stats.offeredHours, 0);
  });

  it("adds the end reason and QoS columns to a database file made before them", async () => {
    await withDatabaseFile(async (path) => {
      const { DatabaseSync } = await import("node:sqlite");
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE sessions (
        id TEXT PRIMARY KEY, booking_id TEXT NOT NULL UNIQUE, machine_id TEXT NOT NULL,
        started_at INTEGER, ended_at INTEGER, expires_at INTEGER NOT NULL, price INTEGER,
        ticket_id TEXT UNIQUE)`);
      old.close();

      const reopened = new Platform({ path, now: () => now });
      reopened.setAvailability("pc-1", true, REPORT);
      const claim = reopened.claim(reopened.book(730, 30).bookingId);
      assert.ok(claim.ok);
      reopened.endSession("pc-1", claim.sessionId);
      assert.equal(reopened.sessionEndReason(claim.sessionId), "host_end");
      reopened.close();
    });
  });
});

describe("deadline timer", () => {
  let changed: string[];

  beforeEach(() => {
    // Only setTimeout is faked: the platform's own timer is the only thing
    // that can move these bookings, and nothing here calls tick().
    mock.timers.enable({ apis: ["setTimeout"] });
    changed = [];
    platform = new Platform({ now: () => now, onBookingChanged: (id) => changed.push(id) });
  });

  afterEach(() => {
    platform.close();
    mock.timers.reset();
  });

  /** Let `ms` pass on both the clock and the timers, without calling tick(). */
  const pass = (ms: number) => {
    now += ms;
    mock.timers.tick(ms);
  };

  it("arms no timer while nothing waits on time", () => {
    assert.equal(platform.nextDeadline(), null);
    platform.book(730, 30);
    assert.equal(platform.nextDeadline(), now + QUEUE_TIMEOUT_MS);
  });

  it("lapses a reservation at its deadline, not a moment before", () => {
    platform.hostConnected("pc-1");
    offer("pc-1");
    const { bookingId, claimBy } = platform.book(730, 30);
    assert.equal(claimBy, now + RESERVATION_MS);
    assert.equal(platform.nextDeadline(), claimBy);
    changed = [];

    pass(RESERVATION_MS - 1);
    assert.equal(platform.viewBooking(bookingId)!.status, "matched");
    assert.deepEqual(changed, []);

    pass(1);
    assert.equal(platform.viewBooking(bookingId)!.status, "expired");
    assert.deepEqual(changed, [bookingId]);
  });

  it("ends a session at its booked time", () => {
    platform.hostConnected("pc-1");
    offer("pc-1");
    const claim = platform.claim(platform.book(730, 30).bookingId);
    assert.ok(claim.ok);
    pass(30 * 60_000 - 1);
    assert.equal(platform.claimedSession("pc-1")?.sessionId, claim.sessionId);
    pass(1);
    assert.equal(platform.claimedSession("pc-1"), null);
  });

  it("drops a machine with no socket once its heartbeat is LIVENESS_MS old", () => {
    offer("pc-1");
    const { bookingId } = platform.book(730, 30);
    pass(LIVENESS_MS - 1);
    assert.equal(platform.viewBooking(bookingId)!.status, "matched");
    pass(1);
    assert.equal(platform.viewBooking(bookingId)!.status, "queued", "back in the queue for another machine");
  });

  it("drops a queued booking nobody checks on after QUEUE_TIMEOUT_MS", () => {
    const { bookingId } = platform.book(730, 30);
    pass(QUEUE_TIMEOUT_MS - 1);
    assert.equal(platform.viewBooking(bookingId)!.status, "queued");
    pass(1);
    assert.equal(platform.viewBooking(bookingId)!.status, "expired");
    assert.equal(platform.nextDeadline(), null);
  });

  it("re-arms for an earlier deadline a change brings in", () => {
    const { bookingId } = platform.book(730, 30);
    offer("pc-1"); // matched now: the reservation lapses before the queue timeout would
    assert.equal(platform.nextDeadline(), now + LIVENESS_MS);
    pass(LIVENESS_MS);
    assert.equal(platform.viewBooking(bookingId)!.status, "queued");
  });
});

describe("presence", () => {
  it("keeps a machine whose socket is open offered with no heartbeat", () => {
    platform.hostConnected("pc-1");
    offer("pc-1");
    advance(10 * LIVENESS_MS);
    const booking = platform.book(730, 30);
    assert.equal(booking.status, "matched");
    assert.equal(booking.machine?.id, "pc-1");
  });

  it("takes a machine offline the moment its socket drops, handing its booking back", () => {
    platform.hostConnected("pc-1");
    offer("pc-1");
    const { bookingId } = platform.book(730, 30);
    platform.hostDisconnected("pc-1", true);
    assert.equal(platform.booking(bookingId)!.status, "queued");
    assert.equal(platform.heartbeat("pc-1").status, "reserved", "a heartbeat offers it again");
  });

  it("keeps a claimed session through a dropped socket for the liveness window, no longer", () => {
    platform.hostConnected("pc-1");
    offer("pc-1");
    const claim = platform.claim(platform.book(730, 30).bookingId);
    assert.ok(claim.ok);
    platform.hostDisconnected("pc-1", true);
    advance(LIVENESS_MS - 1);
    assert.equal(platform.claimedSession("pc-1")?.sessionId, claim.sessionId);
    advance(1);
    assert.equal(platform.claimedSession("pc-1"), null);
  });

  it("gives a machine handed over to its streamer the liveness window", () => {
    platform.hostConnected("pc-1");
    offer("pc-1");
    const claim = platform.claim(platform.book(730, 30).bookingId);
    assert.ok(claim.ok);
    advance(10 * LIVENESS_MS);
    platform.hostDisconnected("pc-1", false);
    advance(LIVENESS_MS - 1);
    assert.equal(platform.claimedSession("pc-1")?.sessionId, claim.sessionId);
    platform.hostConnected("pc-1"); // the streamer registers
    advance(10 * LIVENESS_MS);
    assert.equal(platform.claimedSession("pc-1")?.sessionId, claim.sessionId);
  });

  it("brings a machine dropped as offline back when its socket reconnects", () => {
    offer("pc-1");
    advance(LIVENESS_MS);
    assert.equal(platform.book(730, 30).status, "queued");
    platform.hostConnected("pc-1");
    assert.equal(platform.heartbeat("pc-1").status, "reserved");
  });

  it("stores nothing for a socket from a machine never heard from", () => {
    platform.hostConnected("pc-9");
    platform.hostDisconnected("pc-9", true);
    assert.equal(platform.machineProfile("pc-9"), null);
  });

  it("gives every machine on offer and every queued booking a fresh deadline after a restart", async () => {
    await withDatabaseFile((path) => {
      const first = new Platform({ path, now: () => now });
      first.hostConnected("pc-1");
      first.setAvailability("pc-1", true, REPORT);
      const queued = first.book(1, 30); // a game no machine has
      now += 10 * QUEUE_TIMEOUT_MS;
      first.close();

      const second = new Platform({ path, now: () => now });
      assert.equal(second.nextDeadline(), now + LIVENESS_MS);
      assert.equal(second.viewBooking(queued.bookingId)!.status, "queued");
      second.close();
    });
  });

  it("drops a machine that never comes back after a restart as of its last contact", async () => {
    await withDatabaseFile(async (path) => {
      const lastContact = now;
      const first = new Platform({ path, now: () => now });
      first.setAvailability("pc-1", true, REPORT);
      const claim = first.claim(first.book(730, 120).bookingId);
      assert.ok(claim.ok);
      const { sessionId } = claim;
      first.close();

      now = lastContact + 60 * 60_000;
      const second = new Platform({ path, now: () => now });
      now += LIVENESS_MS - 1;
      second.tick();
      assert.equal(second.sessionEndReason(sessionId), null);
      now += 1;
      second.tick();
      assert.equal(second.sessionEndReason(sessionId), "host_offline");
      const { stats } = second.stability("pc-1");
      assert.equal(Math.round(stats.offeredHours * stats.heartbeatCoverage * 3_600_000), LIVENESS_MS);
      second.close();

      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(path);
      const { ended_at } = db.prepare("SELECT ended_at FROM sessions WHERE id = ?").get(sessionId) as {
        ended_at: number;
      };
      db.close();
      assert.equal(ended_at, lastContact);
    });
  });

  it("counts the time a machine on offer was gone across a restart as unseen when it reconnects", async () => {
    await withDatabaseFile((path) => {
      const first = new Platform({ path, now: () => now });
      first.setAvailability("pc-1", true, REPORT);
      first.close();

      now += 10 * 60_000;
      const second = new Platform({ path, now: () => now });
      second.hostConnected("pc-1");
      const { stats } = second.stability("pc-1");
      assert.equal(Math.round(stats.offeredHours * 3_600_000), 10 * 60_000);
      assert.equal(Math.round(stats.offeredHours * stats.heartbeatCoverage * 3_600_000), LIVENESS_MS);
      second.close();
    });
  });

  it("ends a game on a present machine that never comes back after a restart as of its last ping round", async () => {
    await withDatabaseFile(async (path) => {
      const first = new Platform({ path, now: () => now });
      first.hostConnected("pc-1");
      first.setAvailability("pc-1", true, { ...REPORT, price: 120 });
      const { bookingId } = first.book(730, 180);
      const claim = first.claim(bookingId);
      assert.ok(claim.ok);
      const { sessionId } = claim;
      first.startSession("pc-1", sessionId);
      const startedAt = now;
      // Two hours of play with nothing touching the database but the ping rounds.
      for (let t = 0; t < 2 * 60 * 60_000; t += 25_000) {
        now += 25_000;
        first.hostsAlive(["pc-1"]);
      }
      const lastPing = now;
      now += 20_000; // the server dies before the next round
      first.close();

      now += 60 * 60_000;
      const second = new Platform({ path, now: () => now });
      now += LIVENESS_MS;
      second.tick();
      assert.equal(second.sessionEndReason(sessionId), "host_offline");
      assert.equal(second.booking(bookingId)!.price, Math.round((120 * (lastPing - startedAt)) / 3_600_000));
      const { stats } = second.stability("pc-1");
      const seenMs = Math.round(stats.offeredHours * stats.heartbeatCoverage * 3_600_000);
      assert.equal(seenMs, lastPing - startedAt + LIVENESS_MS);
      second.close();

      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(path);
      const { ended_at } = db.prepare("SELECT ended_at FROM sessions WHERE id = ?").get(sessionId) as {
        ended_at: number;
      };
      db.close();
      assert.equal(ended_at, lastPing);
    });
  });
});

describe("presence and uptime", () => {
  const uptime = () => {
    const { stats } = platform.stability("pc-1");
    return { offeredMs: Math.round(stats.offeredHours * 3_600_000), coverage: stats.heartbeatCoverage };
  };

  it("counts the time a socket is open as seen, with no heartbeat", () => {
    platform.hostConnected("pc-1");
    offer("pc-1");
    advance(10 * 60_000);
    assert.deepEqual(uptime(), { offeredMs: 10 * 60_000, coverage: 1 });
    now += 60_000; // no tick in between: still seen
    assert.deepEqual(uptime(), { offeredMs: 11 * 60_000, coverage: 1 });
  });

  it("counts a dropped socket as a liveness drop, and the time since as unseen", () => {
    platform.hostConnected("pc-1");
    offer("pc-1");
    advance(60_000);
    platform.hostDisconnected("pc-1", true);
    advance(45_000);
    // Seen for the liveness window after its last contact, as after a heartbeat.
    assert.deepEqual(uptime(), { offeredMs: 105_000, coverage: 75 / 105 });
    assert.equal(platform.stability("pc-1").stats.dropsPerHour, 1 / (105 / 3600));
  });

  it("counts no drop for a room the server handed over", () => {
    platform.hostConnected("pc-1");
    offer("pc-1");
    advance(60_000);
    platform.hostDisconnected("pc-1", false);
    platform.hostConnected("pc-1");
    advance(60_000);
    assert.equal(platform.stability("pc-1").stats.dropsPerHour, 0);
    assert.deepEqual(uptime(), { offeredMs: 120_000, coverage: 1 });
  });
});

describe("a host disconnect the database fails", () => {
  afterEach(() => mock.timers.reset());

  it("still drops the presence, and the retried tick takes the machine offline", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    await withDatabaseFile((path) => {
      mock.timers.enable({ apis: ["setTimeout"] });
      const db = new Platform({ path, now: () => now });
      db.hostConnected("pc-1");
      db.setAvailability("pc-1", true, REPORT);
      const { bookingId } = db.book(730, 30);
      assert.equal(db.viewBooking(bookingId)!.status, "matched");
      now += 2 * LIVENESS_MS; // no tick: the machine has not been touched since

      // Every write to machine_uptime fails from here.
      const other = new DatabaseSync(path);
      other.exec("ALTER TABLE machine_uptime RENAME TO machine_uptime_away");
      assert.throws(() => db.hostDisconnected("pc-1", true));
      assert.equal(db.viewBooking(bookingId)!.status, "matched", "rolled back");
      other.exec("ALTER TABLE machine_uptime_away RENAME TO machine_uptime");
      other.close();

      mock.timers.tick(1_000);
      assert.equal(db.viewBooking(bookingId)!.status, "queued", "offline, so the booking is handed back");
      db.close();
    });
  });
});

describe("renters and owners", () => {
  const RENTER = "76561198000000001";
  const OWNER = "76561198000000003";

  beforeEach(() => {
    platform = new Platform({ now: () => now, owners: new Map([["pc-own", OWNER]]) });
  });

  it("never matches a booking to a machine its renter owns", () => {
    platform.setAvailability("pc-own", true, { ...REPORT, price: 10 });
    const own = platform.book(730, 30, OWNER);
    assert.equal(own.status, "queued");

    beatFor("pc-own", 30_000);
    platform.book(730, 30, OWNER); // touching the queue again changes nothing
    assert.equal(platform.booking(own.bookingId, OWNER)!.status, "queued");

    // The same machine goes to the next renter in line instead.
    assert.equal(platform.book(730, 30, RENTER).machine?.id, "pc-own");
    platform.setAvailability("pc-1", true, { ...REPORT, price: 99 });
    assert.equal(platform.booking(own.bookingId, OWNER)!.machine?.id, "pc-1");
  });

  it("takes the owner from the configuration each time the machine checks in", async () => {
    await withDatabaseFile((path) => {
      const before = new Platform({ path, now: () => now });
      before.setAvailability("pc-1", true, REPORT);
      before.close();

      // Restarted with pc-1's owner configured: the stored machine learns it.
      const after = new Platform({ path, now: () => now, owners: new Map([["pc-1", OWNER]]) });
      after.heartbeat("pc-1");
      assert.equal(after.book(730, 30, OWNER).status, "queued");
      assert.equal(after.book(730, 30, RENTER).status, "matched");
      after.close();
    });
  });

  it("takes back a reservation made before its renter was known to own the machine", async () => {
    await withDatabaseFile((path) => {
      // Matched while pc-1 had no owner on record.
      const before = new Platform({ path, now: () => now });
      before.setAvailability("pc-1", true, REPORT);
      const { bookingId } = before.book(730, 30, OWNER);
      assert.equal(before.booking(bookingId, OWNER)!.machine?.id, "pc-1");
      before.close();

      // Restarted knowing OWNER owns pc-1: the next check-in hands it back.
      const after = new Platform({ path, now: () => now, owners: new Map([["pc-1", OWNER]]) });
      assert.equal(after.heartbeat("pc-1").status, "available");
      const requeued = after.booking(bookingId, OWNER)!;
      assert.equal(requeued.status, "queued");
      assert.equal(requeued.machine, undefined);
      assert.equal(after.book(730, 30, RENTER).machine?.id, "pc-1");
      after.close();
    });
  });

  it("refuses to claim the renter's own machine before it has checked in again", async () => {
    await withDatabaseFile((path) => {
      const before = new Platform({ path, now: () => now });
      before.setAvailability("pc-1", true, REPORT);
      const { bookingId } = before.book(730, 30, OWNER);
      before.close();

      const after = new Platform({ path, now: () => now, owners: new Map([["pc-1", OWNER]]) });
      assert.deepEqual(after.claim(bookingId, OWNER), {
        ok: false,
        reason: "not-claimable",
        status: "queued",
      });
      assert.equal(after.booking(bookingId, OWNER)!.status, "queued");
      assert.equal(after.book(730, 30, RENTER).machine?.id, "pc-1");
      after.close();
    });
  });

  it("shows and hands a booking only to the renter who made it", () => {
    platform.setAvailability("pc-1", true, REPORT);
    const { bookingId } = platform.book(730, 30, RENTER);
    assert.equal(platform.booking(bookingId, OWNER), null);
    assert.equal(platform.booking(bookingId), null); // nor to nobody
    assert.deepEqual(platform.claim(bookingId, OWNER), { ok: false, reason: "not-found" });
    assert.equal(platform.booking(bookingId, RENTER)!.status, "matched");
    assert.ok(platform.claim(bookingId, RENTER).ok);
  });
});

describe("machines on offer", () => {
  const ids = () => platform.offeredMachines().machines.map((m) => m.host.id);

  it("lists what is offered and answering, with no machine taken back or gone silent", () => {
    offer("pc-1");
    offer("pc-2");
    offer("pc-3");
    platform.setAvailability("pc-2", false);
    assert.deepEqual(ids(), ["pc-1", "pc-3"]);
    advance(LIVENESS_MS);
    platform.heartbeat("pc-3");
    assert.deepEqual(ids(), ["pc-3"]);
    const [pc3] = platform.offeredMachines().machines;
    assert.equal(pc3!.host.status, "available");
    assert.deepEqual(pc3!.host.installed, [570, 730]);
    assert.equal(pc3!.profile.name, REPORT.name);
    assert.equal(pc3!.backAt, null);
  });

  it("counts a machine whose socket is open as seen now", () => {
    offer("pc-1");
    platform.hostConnected("pc-1");
    now += 10 * LIVENESS_MS; // no tick: nothing has been settled since
    const { at, machines } = platform.offeredMachines();
    assert.equal(at, now);
    assert.equal(machines[0]!.host.lastHeartbeatAt, now);
  });

  it("says when a busy machine is free again at the latest", () => {
    offer("pc-1");
    const { bookingId } = platform.book(730, 30);
    const reserved = platform.offeredMachines().machines[0]!;
    assert.equal(reserved.host.status, "busy");
    assert.equal(reserved.backAt, now + RESERVATION_MS + 30 * 60_000);

    advance(10_000);
    platform.heartbeat("pc-1");
    assert.ok(platform.claim(bookingId).ok);
    assert.equal(platform.offeredMachines().machines[0]!.backAt, now + 30 * 60_000);
  });
});
