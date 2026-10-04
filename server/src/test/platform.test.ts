// The booking lifecycle and machine liveness, against a real Postgres
// database (test/db.ts) and a clock the tests move by hand.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { Database } from "../db.js";
import {
  LIVENESS_MS,
  MAX_HOLD_MS,
  Platform,
  QOS_GRACE_MS,
  QUEUE_TIMEOUT_MS,
  RESERVATION_MS,
  RETRY_MS,
  TIME_UP_GRACE_MS,
  type BookingView,
  type MachineSpec,
  type PlatformOptions,
} from "../platform.js";
import { testDatabase, testSchema } from "./db.js";
import { REPORT } from "./report.js";

let now: number;
let platform: Platform;
/** The database the platform is on. */
let database: Database;

/** A platform on a fresh database and the test clock, in place of the last one. */
async function openPlatform(options: Omit<PlatformOptions, "database" | "now"> = {}): Promise<Platform> {
  await platform?.close();
  database = await testDatabase();
  platform = await Platform.open({ database, now: () => now, ...options });
  return platform;
}

/** How many bookings have been made. */
async function bookingCount(): Promise<number> {
  const { rows } = await database.query<{ n: number }>("SELECT count(*)::int AS n FROM bookings");
  return rows[0]!.n;
}

beforeEach(async () => {
  now = Date.UTC(2026, 8, 30, 12);
  await openPlatform();
});

afterEach(() => platform.close());

/** Offer a machine that has every test game and the hardware for it. */
const offer = (machineId: string, spec: MachineSpec = {}) =>
  platform.setAvailability(machineId, true, { ...REPORT, ...spec });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const advance = async (ms: number) => {
  now += ms;
  await platform.tick();
};

/** Keep a machine alive across `ms`, beating every 5 s as the host app does. */
const beatFor = async (machineId: string, ms: number) => {
  for (let t = 0; t < ms; t += 5_000) {
    await advance(Math.min(5_000, ms - t));
    await platform.heartbeat(machineId);
  }
};

describe("booking lifecycle", () => {
  it("goes queued -> matched -> claimed -> playing -> ended", async () => {
    const booking = await platform.book(730, 30);
    assert.equal(booking.status, "queued");

    await offer("pc-1", { price: 120 });
    const matched = (await platform.booking(booking.bookingId))!;
    assert.equal(matched.status, "matched");
    assert.equal(matched.machine?.id, "pc-1");
    assert.equal(matched.claimBy, now + RESERVATION_MS);
    assert.equal((await platform.heartbeat("pc-1")).status, "reserved");

    const claim = await platform.claim(booking.bookingId);
    assert.ok(claim.ok);
    assert.equal(claim.roomId, "pc-1");
    assert.equal(claim.minutes, 30);
    assert.equal((await platform.booking(booking.bookingId))!.status, "claimed");
    const machine = await platform.heartbeat("pc-1");
    assert.equal(machine.status, "in_session");
    assert.equal(machine.session?.id, claim.sessionId);

    assert.ok(await platform.startSession("pc-1", claim.sessionId));
    assert.equal((await platform.booking(booking.bookingId))!.status, "playing");

    await beatFor("pc-1", 20 * 60_000);
    assert.ok(await platform.endSession("pc-1", claim.sessionId));
    assert.equal((await platform.booking(booking.bookingId))!.status, "ended");
    assert.equal((await platform.heartbeat("pc-1")).status, "available");
  });

  it("matches a booking at once when a machine is already free", async () => {
    await offer("pc-1");
    const booking = await platform.book(730, 30);
    assert.equal(booking.status, "matched");
    assert.equal(booking.machine?.id, "pc-1");
  });

  it("refuses a claim once the reservation has lapsed and the renter is gone, and frees the machine", async () => {
    await offer("pc-1");
    const { bookingId } = await platform.book(730, 30);

    await beatFor("pc-1", QUEUE_TIMEOUT_MS);
    const claim = await platform.claim(bookingId);
    assert.deepEqual(claim, { ok: false, reason: "not-claimable", status: "expired" });
    assert.equal((await platform.booking(bookingId))!.status, "expired");
    assert.equal((await platform.heartbeat("pc-1")).status, "available");
  });

  it("refuses a claim that is too early, a second claim, and an unknown booking", async () => {
    const { bookingId } = await platform.book(730, 30);
    assert.deepEqual(await platform.claim(bookingId), {
      ok: false,
      reason: "not-claimable",
      status: "queued",
    });

    await offer("pc-1");
    assert.ok((await platform.claim(bookingId)).ok);
    assert.deepEqual(await platform.claim(bookingId), {
      ok: false,
      reason: "not-claimable",
      status: "claimed",
    });
    assert.deepEqual(await platform.claim("nope"), { ok: false, reason: "not-found" });
  });

  it("gives a machine to at most one booking, and the next one waits in order", async () => {
    await offer("pc-1");
    const first = await platform.book(730, 30);
    const second = await platform.book(570, 30);
    assert.equal(first.status, "matched");
    assert.equal(second.status, "queued");

    const claim = await platform.claim(first.bookingId);
    assert.ok(claim.ok);
    assert.equal((await platform.booking(second.bookingId))!.status, "queued");

    await platform.endSession("pc-1", claim.sessionId);
    assert.equal((await platform.booking(second.bookingId))!.status, "matched");
  });

  it("does not match a machine that is not free for the whole booking", async () => {
    await offer("pc-1", { availableUntil: now + 20 * 60_000 });
    const long = await platform.book(730, 30);
    const short = await platform.book(570, 15);
    assert.equal((await platform.booking(long.bookingId))!.status, "queued");
    assert.equal((await platform.booking(short.bookingId))!.machine?.id, "pc-1");
  });

  it("prices only the time actually played", async () => {
    await offer("pc-1", { price: 120 }); // cents per hour
    const { bookingId } = await platform.book(730, 60);
    const claim = await platform.claim(bookingId);
    assert.ok(claim.ok);
    await beatFor("pc-1", 5 * 60_000); // the renter takes five minutes to arrive
    await platform.startSession("pc-1", claim.sessionId);
    await beatFor("pc-1", 30 * 60_000);
    await platform.endSession("pc-1", claim.sessionId);
    assert.equal((await platform.booking(bookingId))!.price, 60);
  });

  it("ends a session the host never ends when its ticket runs out", async () => {
    await offer("pc-1");
    const { bookingId } = await platform.book(730, 10);
    const claim = await platform.claim(bookingId);
    assert.ok(claim.ok);

    await beatFor("pc-1", 10 * 60_000);
    assert.equal((await platform.booking(bookingId))!.status, "ended");
    assert.equal((await platform.heartbeat("pc-1")).status, "available");
    assert.equal(await platform.startSession("pc-1", claim.sessionId), false);
  });

  it("only lets a machine start and end its own sessions", async () => {
    await offer("pc-1");
    await platform.setAvailability("pc-2", false);
    const { bookingId } = await platform.book(730, 30);
    const claim = await platform.claim(bookingId);
    assert.ok(claim.ok);
    assert.equal(await platform.sessionMachine(claim.sessionId), "pc-1");
    assert.equal(await platform.startSession("pc-2", claim.sessionId), false);
    assert.equal(await platform.endSession("pc-2", claim.sessionId), false);
    assert.equal((await platform.booking(bookingId))!.status, "claimed");
  });
});

describe("calls made at once", () => {
  it("runs them in the order they were made", async () => {
    // Not awaited in between: each still sees what the ones before it did.
    const first = platform.book(730, 30);
    const machine = offer("pc-1");
    const second = platform.book(730, 30);
    assert.equal((await first).status, "queued", "no machine yet when it ran");
    assert.equal((await machine).status, "reserved", "matched at once to the booking before it");
    assert.equal((await second).status, "queued", "the one machine is taken");
    assert.equal((await platform.booking((await first).bookingId))!.status, "matched");
  });

  it("gives a machine to one booking however many are made at once", async () => {
    await offer("pc-1");
    const bookings = await Promise.all(
      ["r1", "r2", "r3", "r4", "r5"].map((renter) => platform.book(730, 30, renter)),
    );
    assert.deepEqual(
      bookings.map((booking) => booking.status),
      ["matched", "queued", "queued", "queued", "queued"],
    );
  });

  it("lets one of two claims made at once take the machine", async () => {
    await offer("pc-1");
    const { bookingId } = await platform.book(730, 30);
    const claims = await Promise.all([platform.claim(bookingId), platform.claim(bookingId)]);
    assert.deepEqual(
      claims.map((claim) => claim.ok),
      [true, false],
    );
    assert.deepEqual(claims[1], { ok: false, reason: "not-claimable", status: "claimed" });
  });

  it("gives a machine to one booking when two servers on the same database book at once", async () => {
    await withDatabase(async (open) => {
      const a = await Platform.open({ database: open(), now: () => now });
      const b = await Platform.open({ database: open(), now: () => now });
      await a.setAvailability("pc-1", true, REPORT);
      const bookings = await Promise.all(
        [a, b, a, b, a, b].map((server, i) => server.book(730, 30, `renter-${i}`)),
      );
      assert.equal(bookings.filter((booking) => booking.status === "matched").length, 1);
      const db = open();
      const { rows } = await db.query("SELECT machine_id FROM reservations");
      assert.deepEqual(rows, [{ machine_id: "pc-1" }]);
      await db.close();
      await Promise.all([a.close(), b.close()]);
    });
  });
});

describe("queue timeout", () => {
  it("drops a queued booking the renter stopped checking on, and never matches it", async () => {
    const { bookingId } = await platform.book(730, 30);
    await advance(QUEUE_TIMEOUT_MS);
    await offer("pc-1");
    assert.equal((await platform.heartbeat("pc-1")).status, "available");
    assert.equal((await platform.booking(bookingId))!.status, "expired");
    assert.deepEqual(await platform.claim(bookingId), {
      ok: false,
      reason: "not-claimable",
      status: "expired",
    });
  });

  it("keeps a queued booking whose renter comes back within the timeout", async () => {
    const { bookingId } = await platform.book(730, 30);
    await advance(QUEUE_TIMEOUT_MS - 1_000); // the laptop slept
    assert.equal((await platform.booking(bookingId))!.status, "queued");
    await advance(QUEUE_TIMEOUT_MS - 1_000); // the same renter, polling again, keeps it alive
    assert.equal((await platform.booking(bookingId))!.status, "queued");

    await offer("pc-1");
    assert.equal((await platform.booking(bookingId))!.status, "matched");
  });

  it("expires the booking of a renter who saw the match and let it lapse, and serves the next", async () => {
    await offer("pc-1");
    const first = await platform.claim((await platform.book(730, 30)).bookingId);
    assert.ok(first.ok);
    const { bookingId } = await platform.book(730, 30);
    const behind = await platform.book(570, 30);

    await beatFor("pc-1", 10_000);
    await platform.endSession("pc-1", first.sessionId);
    assert.equal((await platform.booking(bookingId))!.status, "matched"); // the renter is there and sees it
    assert.equal((await platform.booking(behind.bookingId))!.status, "queued");
    await beatFor("pc-1", RESERVATION_MS); // and never claims

    assert.equal((await platform.booking(bookingId))!.status, "expired");
    const next = (await platform.booking(behind.bookingId))!;
    assert.equal(next.status, "matched");
    assert.equal(next.machine?.id, "pc-1");
  });
});

describe("the claim clock of a renter away at the match", () => {
  /** A booking queued at its renter's last contact and matched to pc-1 `awayMs` later, with the tab closed. */
  const matchedAway = async (awayMs = 30_000) => {
    await platform.hostConnected("pc-1");
    const { bookingId } = await platform.book(730, 30, "steam:1");
    now += awayMs;
    await offer("pc-1");
    assert.equal((await platform.viewBooking(bookingId))!.status, "matched");
    return { bookingId, matchedAt: now };
  };

  it("runs 60 s from the match for a renter there at the match, however often they check", async () => {
    await platform.hostConnected("pc-1");
    const { bookingId } = await platform.book(730, 30, "steam:1");
    now += 10_000;
    assert.equal((await platform.booking(bookingId, "steam:1"))!.status, "queued"); // the page's heartbeat
    await offer("pc-1");
    const matchedAt = now;
    assert.equal((await platform.booking(bookingId, "steam:1"))!.claimBy, matchedAt + RESERVATION_MS);

    await advance(15_000);
    assert.equal((await platform.booking(bookingId, "steam:1"))!.claimBy, matchedAt + RESERVATION_MS);
    await advance(RESERVATION_MS - 15_000);
    assert.equal((await platform.viewBooking(bookingId))!.status, "expired");
    assert.equal((await platform.heartbeat("pc-1")).status, "available");
  });

  it("holds the machine for a renter away at the match, and starts their 60 s when they are back", async () => {
    const { bookingId, matchedAt } = await matchedAway();
    assert.equal((await platform.viewBooking(bookingId))!.claimBy, matchedAt + MAX_HOLD_MS);

    await advance(50_000); // back with 10 s left of a clock started at the match
    const back = (await platform.booking(bookingId, "steam:1"))!;
    assert.equal(back.status, "matched");
    assert.equal(back.claimBy, now + RESERVATION_MS);
    await advance(30_000);
    assert.equal(
      (await platform.booking(bookingId, "steam:1"))!.claimBy,
      back.claimBy,
      "only the first contact starts it",
    );
    assert.ok((await platform.claim(bookingId, "steam:1")).ok);
  });

  it("never runs past 2 minutes from the match for a renter back late", async () => {
    const { bookingId, matchedAt } = await matchedAway();
    await advance(100_000);
    assert.equal((await platform.booking(bookingId, "steam:1"))!.claimBy, matchedAt + MAX_HOLD_MS);

    await advance(MAX_HOLD_MS - 100_000 - 1);
    assert.equal((await platform.viewBooking(bookingId))!.status, "matched");
    await advance(1);
    assert.equal((await platform.viewBooking(bookingId))!.status, "expired");
    assert.equal((await platform.heartbeat("pc-1")).status, "available");
  });

  it("lets the machine go to the next in line 2 minutes after the match when the renter never comes back", async () => {
    const { bookingId, matchedAt } = await matchedAway();
    assert.equal(await platform.nextDeadline(), matchedAt + MAX_HOLD_MS);
    const behind = await platform.book(730, 30, "steam:2");

    await advance(MAX_HOLD_MS - 1);
    assert.equal((await platform.viewBooking(bookingId))!.status, "matched");
    assert.equal((await platform.booking(behind.bookingId, "steam:2"))!.status, "queued");
    await advance(1);
    assert.equal((await platform.viewBooking(bookingId))!.status, "expired");
    const next = (await platform.viewBooking(behind.bookingId))!;
    assert.equal(next.status, "matched");
    assert.equal(next.machine?.id, "pc-1");
  });
});

describe("join ticket revocation", () => {
  const claimed = async () => {
    await offer("pc-1");
    const { bookingId } = await platform.book(730, 30);
    const claim = await platform.claim(bookingId);
    assert.ok(claim.ok);
    await platform.recordTicket(claim.sessionId, "ticket-1");
    assert.equal(await platform.ticketRevoked("ticket-1"), false);
    return claim;
  };

  it("revokes the ticket when the host ends the session", async () => {
    const claim = await claimed();
    await platform.endSession("pc-1", claim.sessionId);
    assert.equal(await platform.ticketRevoked("ticket-1"), true);
  });

  it("revokes the ticket when the owner takes the machine back", async () => {
    await claimed();
    await platform.setAvailability("pc-1", false);
    assert.equal(await platform.ticketRevoked("ticket-1"), true);
  });

  it("revokes the ticket when the machine goes silent", async () => {
    await claimed();
    await advance(LIVENESS_MS);
    assert.equal(await platform.ticketRevoked("ticket-1"), true);
  });

  it("revokes the ticket when the session runs past its time", async () => {
    await claimed();
    await beatFor("pc-1", 30 * 60_000);
    assert.equal(await platform.ticketRevoked("ticket-1"), true);
  });

  it("leaves a ticket minted by hand, with no session, alone", async () => {
    assert.equal(await platform.ticketRevoked("hand-minted"), false);
  });

  it("takes turns with another server on the same database, and sees what it committed", async () => {
    await withDatabase(async (open) => {
      await platform.close();
      platform = await Platform.open({ database: open(), now: () => now });
      const claim = await claimed();
      // Another server ends the session behind this one's back, holding the
      // machines table as every platform write does, for a moment first.
      const other = open();
      let committed = false;
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => (locked = resolve));
      const writing = other.transaction(
        async (tx) => {
          await tx.query("UPDATE sessions SET ended_at = 1");
          locked();
          await wait(300);
          committed = true;
        },
        "BEGIN",
        "LOCK TABLE machines IN EXCLUSIVE MODE",
      );
      await holding;
      assert.equal(
        await platform.endSession("pc-1", claim.sessionId),
        false,
        "ended already, once its turn came",
      );
      assert.ok(committed);
      assert.equal(await platform.ticketRevoked("ticket-1"), true);
      await writing;
      await other.close();
    });
  });
});

describe("session end notice", () => {
  let ended: string[];

  beforeEach(async () => {
    ended = [];
    await openPlatform({ onSessionEnded: (machineId) => ended.push(machineId) });
  });

  const claimed = async () => {
    await offer("pc-1");
    const claim = await platform.claim((await platform.book(730, 30)).bookingId);
    assert.ok(claim.ok);
    assert.deepEqual(ended, []);
    return claim;
  };

  it("tells the server when the booked time runs out", async () => {
    await claimed();
    await beatFor("pc-1", 30 * 60_000);
    assert.deepEqual(ended, ["pc-1"]);
  });

  it("tells the server when the machine goes silent", async () => {
    await claimed();
    await advance(LIVENESS_MS);
    assert.deepEqual(ended, ["pc-1"]);
  });

  it("tells the server when the owner takes the machine back", async () => {
    await claimed();
    await platform.setAvailability("pc-1", false);
    assert.deepEqual(ended, ["pc-1"]);
  });

  it("tells the server when the host ends the session", async () => {
    const claim = await claimed();
    await platform.endSession("pc-1", claim.sessionId);
    assert.deepEqual(ended, ["pc-1"]);
  });

  it("tells the server only once the end is committed", async () => {
    // A call made from inside the notice takes its turn after the call that
    // ended the session, and sees it ended.
    const seen: Promise<BookingView | null>[] = [];
    await openPlatform({ onSessionEnded: () => seen.push(platform.booking(bookingId)) });
    await offer("pc-1");
    const { bookingId } = await platform.book(730, 30);
    assert.ok((await platform.claim(bookingId)).ok);
    await platform.setAvailability("pc-1", false);
    assert.deepEqual(
      (await Promise.all(seen)).map((booking) => booking?.status),
      ["ended"],
    );
  });

  it("keeps the session ended, and the sweep going, when the notice fails", async () => {
    await openPlatform({
      onSessionEnded: () => {
        throw new Error("eviction failed");
      },
    });
    await offer("pc-1");
    const first = await platform.book(730, 10);
    assert.ok((await platform.claim(first.bookingId)).ok);

    await beatFor("pc-1", 10 * 60_000);
    assert.equal((await platform.booking(first.bookingId))!.status, "ended");
    assert.equal((await platform.book(570, 10)).machine?.id, "pc-1");
  });
});

describe("availability notice", () => {
  let told: number;

  beforeEach(async () => {
    told = 0;
    await openPlatform({ onAvailabilityChanged: () => (told += 1) });
  });

  it("tells once per change that offers, takes, frees or takes back a machine", async () => {
    await offer("pc-1");
    assert.equal(told, 1, "offered");
    await platform.heartbeat("pc-1");
    await advance(1_000);
    assert.equal(told, 1, "a beat and a tick that change nothing on offer are not news");

    const { bookingId } = await platform.book(730, 30);
    assert.equal(told, 2, "matched: busy");
    const claim = await platform.claim(bookingId);
    assert.ok(claim.ok);
    assert.equal(told, 3, "claimed: busy until the session runs out rather than the claim lapses");
    await platform.endSession("pc-1", claim.sessionId);
    assert.equal(told, 4, "free again");

    await offer("pc-1", { price: 50 });
    assert.equal(told, 5, "new terms, though its status stayed");
    await platform.setAvailability("pc-1", false);
    assert.equal(told, 6, "taken back");
  });

  it("tells when a silent machine drops offline", async () => {
    await offer("pc-1");
    told = 0;
    await advance(LIVENESS_MS);
    assert.equal(told, 1);
  });
});

describe("machine liveness", () => {
  it("tells the host the share-until it is offered with, so it can offer it again on the same terms", async () => {
    const until = now + 2 * 3_600_000;
    assert.equal((await offer("pc-1", { availableUntil: until })).until, until);
    assert.equal((await platform.heartbeat("pc-1")).until, until);
    const paused = await platform.setAvailability("pc-1", false, { availableUntil: until });
    assert.equal(paused.until, until);
    assert.equal((await offer("pc-1", { availableUntil: until })).status, "available");
    assert.equal("until" in (await offer("pc-1")), false, "no share-until: none is told");
  });

  it("stops offering a machine within seconds of its heartbeats stopping", async () => {
    await offer("pc-1");
    await beatFor("pc-1", 60_000);
    assert.equal((await platform.heartbeat("pc-1")).status, "available");

    await advance(LIVENESS_MS);
    const booking = await platform.book(730, 30);
    assert.equal(booking.status, "queued");
  });

  it("keeps offering a machine whose heartbeats keep coming", async () => {
    await offer("pc-1");
    await beatFor("pc-1", 10 * 60_000);
    assert.equal((await platform.book(730, 30)).status, "matched");
  });

  it("hands a reserved booking to another machine when its machine goes silent", async () => {
    await offer("pc-1");
    const { bookingId } = await platform.book(730, 30);
    assert.equal((await platform.booking(bookingId))!.machine?.id, "pc-1");

    await offer("pc-2");
    await beatFor("pc-2", LIVENESS_MS); // pc-1 says nothing
    const moved = (await platform.booking(bookingId))!;
    assert.equal(moved.status, "matched");
    assert.equal(moved.machine?.id, "pc-2");
  });

  it("ends the session of a machine that goes silent mid-game", async () => {
    await offer("pc-1");
    const { bookingId } = await platform.book(730, 30);
    const claim = await platform.claim(bookingId);
    assert.ok(claim.ok);
    await platform.startSession("pc-1", claim.sessionId);

    await advance(LIVENESS_MS);
    assert.equal((await platform.booking(bookingId))!.status, "ended");
  });

  it("offers a dropped machine again when its heartbeats resume", async () => {
    await offer("pc-1");
    await advance(LIVENESS_MS);
    assert.equal((await platform.book(730, 30)).status, "queued");

    const machine = await platform.heartbeat("pc-1");
    assert.equal(machine.status, "reserved");
  });

  it("takes a machine back at once, ending what it was doing", async () => {
    await offer("pc-1");
    const { bookingId } = await platform.book(730, 30);
    const claim = await platform.claim(bookingId);
    assert.ok(claim.ok);

    assert.equal((await platform.setAvailability("pc-1", false)).status, "idle");
    assert.equal((await platform.booking(bookingId))!.status, "ended");
    assert.equal((await platform.book(570, 30)).status, "queued");
  });

  it("keeps its state in the database across restarts", async () => {
    await withDatabase(async (open) => {
      const first = await Platform.open({ database: open(), now: () => now });
      await first.setAvailability("pc-1", true, REPORT);
      const { bookingId } = await first.book(730, 30);
      await first.close();

      const second = await Platform.open({ database: open(), now: () => now });
      assert.equal((await second.booking(bookingId))!.status, "matched");
      await second.close();
    });
  });
});

/** When the session ended, read straight from the database. */
async function endedAt(db: Database, sessionId: string): Promise<number> {
  const { rows } = await db.query<{ ended_at: number }>("SELECT ended_at FROM sessions WHERE id = $1", [
    sessionId,
  ]);
  await db.close();
  return rows[0]!.ended_at;
}

/** Run `work` on a fresh database, which it may open as often as restarts would, dropped afterwards. */
async function withDatabase(work: (open: () => Database) => Promise<void>): Promise<void> {
  const schema = await testSchema();
  try {
    await work(() => schema.open());
  } finally {
    await schema.drop();
  }
}

describe("host profiles", () => {
  it("stores the report and reads it back, with the GPU's score from the table", async () => {
    await offer("pc-1");
    assert.deepEqual(await platform.machineProfile("pc-1"), {
      id: "pc-1",
      name: REPORT.name,
      hardware: { ...REPORT.hardware, gpuScore: 230 },
      games: [...REPORT.games].sort((a, b) => a - b),
      controls: REPORT.controls,
      net: REPORT.net,
    });
    assert.equal((await platform.heartbeat("pc-1")).gpu, REPORT.hardware.gpu);
  });

  it("scores a GPU the table does not know as 0", async () => {
    await offer("pc-1", { hardware: { ...REPORT.hardware, gpu: "Mystery Card 9000" } });
    assert.equal((await platform.machineProfile("pc-1"))!.hardware!.gpuScore, 0);
  });

  it("replaces the games list when a heartbeat carries one, and keeps it when it does not", async () => {
    await offer("pc-1");
    await platform.heartbeat("pc-1", { games: [440] });
    assert.deepEqual((await platform.machineProfile("pc-1"))!.games, [440]);

    await platform.heartbeat("pc-1", { net: { rttMs: 30, jitterMs: 4, upMbps: 20 } });
    const profile = (await platform.machineProfile("pc-1"))!;
    assert.deepEqual(profile.games, [440]);
    assert.deepEqual(profile.net, { rttMs: 30, jitterMs: 4, upMbps: 20 });
    assert.deepEqual(profile.hardware?.gpu, REPORT.hardware.gpu);
  });

  it("knows nothing about a machine that has not reported", async () => {
    assert.equal(await platform.machineProfile("pc-9"), null);
    await platform.heartbeat("pc-1");
    assert.deepEqual(await platform.machineProfile("pc-1"), {
      id: "pc-1",
      name: null,
      hardware: null,
      games: [],
      controls: [],
      net: null,
    });
  });
});

describe("matching on the game and the hardware", () => {
  it("skips a machine without the game installed", async () => {
    await offer("pc-1", { games: [570] });
    const booking = await platform.book(730, 30);
    assert.equal(booking.status, "queued");

    await platform.heartbeat("pc-1", { games: [570, 730] });
    assert.equal((await platform.booking(booking.bookingId))!.status, "matched");
  });

  it("skips a machine below the game's minimum GPU, RAM or VRAM", async () => {
    const low = [
      { ...REPORT.hardware, gpu: "Intel UHD Graphics 630" },
      { ...REPORT.hardware, ramMb: 4_096 },
      { ...REPORT.hardware, vramMb: 512 },
    ];
    for (const [i, hardware] of low.entries()) await offer(`low-${i}`, { hardware, price: 10 });
    // Counter-Strike 2 asks for a GTX 1050, 8 GB of RAM and 1 GB of VRAM.
    const { bookingId, status } = await platform.book(730, 30);
    assert.equal(status, "queued");

    await offer("pc-1", { price: 500 });
    assert.equal((await platform.booking(bookingId))!.machine?.id, "pc-1");
  });

  it("skips a machine that has never reported its hardware or games", async () => {
    await platform.setAvailability("pc-1", true);
    assert.equal((await platform.book(730, 30)).status, "queued");
  });

  it("picks the cheapest of the machines that qualify and are otherwise alike", async () => {
    await offer("pc-1", { price: 300 });
    await offer("pc-2", { price: 100 });
    await offer("pc-3", { price: 50, games: [570] });
    assert.equal((await platform.book(730, 30)).machine?.id, "pc-2");
  });

  it("matches a booking to a machine of the right game when another game is waiting first", async () => {
    await offer("pc-1", { games: [570] });
    const first = await platform.book(730, 30);
    const second = await platform.book(570, 30);
    assert.equal((await platform.booking(first.bookingId))!.status, "queued");
    assert.equal((await platform.booking(second.bookingId))!.machine?.id, "pc-1");
  });

  it("never matches a renter to their own machine", async () => {
    await withDatabase(async (open) => {
      const setup = await Platform.open({ database: open(), now: () => now });
      await setup.setAvailability("pc-1", true, REPORT);
      await setup.close();
      const db = open();
      await db.query("UPDATE machines SET owner_id = 'steam:1' WHERE id = 'pc-1'");
      await db.close();

      const reopened = await Platform.open({ database: open(), now: () => now });
      assert.equal((await reopened.book(730, 30, "steam:1")).status, "queued");
      assert.equal((await reopened.book(730, 30, "steam:2")).machine?.id, "pc-1");
      await reopened.close();
    });
  });
});

describe("matching by rank()", () => {
  /** A machine `rttMs` from the server, otherwise the test PC. */
  const at = (rttMs: number, spec: MachineSpec = {}) => ({ ...spec, net: { ...REPORT.net, rttMs } });

  it("picks the machine the renter's list puts first, not merely the cheapest", async () => {
    await offer("far", at(50, { price: 50 }));
    await offer("near", at(5, { price: 300 }));
    const booking = await platform.book(730, 30, "steam:1", { server: 10 });
    assert.equal(booking.machine?.id, "near");
  });

  it("prefers a machine that is not shaky to a cheaper one that is", async () => {
    // Five two-hour sessions whose renters lose 5% of packets make it Shaky.
    await offer("shaky", { price: 50 });
    await platform.hostConnected("shaky");
    for (let i = 0; i < 5; i++) {
      const claim = await platform.claim((await platform.bookMachine("shaky", 730, 180))!.bookingId);
      assert.ok(claim.ok);
      await platform.recordTicket(claim.sessionId, `ticket-${i}`);
      await platform.startSession("shaky", claim.sessionId);
      await advance(2 * 3_600_000);
      const qos = { fps: 60, bitrate: 20e6, rttMs: 12, packetLoss: 0.05 };
      await platform.recordQos(claim.sessionId, `ticket-${i}`, qos);
      assert.equal(await platform.leaveSession(claim.sessionId, `ticket-${i}`), "ok");
    }
    assert.equal((await platform.stability("shaky")).stability, "shaky");

    await offer("steady", { price: 300 });
    assert.equal((await platform.book(730, 30)).machine?.id, "steady");
  });

  it("leaves a machine too far from the renter unmatched, and matches one close enough", async () => {
    await offer("pc-1", at(40));
    const { bookingId, status } = await platform.book(730, 30, "steam:1", { server: 60 });
    assert.equal(status, "queued");

    await offer("pc-2", at(10));
    assert.equal((await platform.booking(bookingId, "steam:1"))!.machine?.id, "pc-2");
  });

  it("judges a machine by the round trip the renter measured to it, when they did", async () => {
    await offer("pc-1", at(5, { price: 50 }));
    await offer("pc-2", at(5, { price: 300 }));
    const rtts = { server: 10, machines: { "pc-1": 120 } };
    assert.equal((await platform.book(730, 30, "steam:1", rtts)).machine?.id, "pc-2");
  });

  it("keeps judging by the renter's round trips across a restart", async () => {
    await withDatabase(async (open) => {
      const first = await Platform.open({ database: open(), now: () => now });
      const { bookingId } = await first.book(730, 30, "steam:1", { server: 70 });
      await first.close();

      const reopened = await Platform.open({ database: open(), now: () => now });
      await reopened.setAvailability("pc-1", true, { ...REPORT, net: { ...REPORT.net, rttMs: 20 } });
      assert.equal((await reopened.booking(bookingId, "steam:1"))!.status, "queued");
      await reopened.setAvailability("pc-2", true, { ...REPORT, net: { ...REPORT.net, rttMs: 5 } });
      assert.equal((await reopened.booking(bookingId, "steam:1"))!.machine?.id, "pc-2");
      await reopened.close();
    });
  });
});

describe("booking a picked machine", () => {
  it("reserves the machine picked even when another ranks first", async () => {
    await offer("pc-1", { price: 50 });
    await offer("pc-2", { price: 300 });
    const booking = (await platform.bookMachine("pc-2", 730, 30, "steam:1"))!;
    assert.equal(booking.status, "matched");
    assert.equal(booking.machine?.id, "pc-2");
    assert.equal(booking.claimBy, now + RESERVATION_MS);
    assert.equal((await platform.heartbeat("pc-2")).status, "reserved");
    assert.ok((await platform.claim(booking.bookingId, "steam:1")).ok);
  });

  it("books nothing when the machine was taken a moment ago", async () => {
    await offer("pc-1");
    assert.equal((await platform.book(730, 30, "steam:1")).machine?.id, "pc-1");
    assert.equal(await platform.bookMachine("pc-1", 730, 30, "steam:2"), null);
    assert.equal(await bookingCount(), 1);
  });

  it("serves the queue first: a waiting booking gets a machine come free before a renter picking it", async () => {
    await platform.hostConnected("pc-1");
    await offer("pc-1");
    const playing = await platform.claim((await platform.book(730, 1, "steam:3")).bookingId, "steam:3");
    assert.ok(playing.ok);
    const waiting = await platform.book(730, 30, "steam:1");
    assert.equal(waiting.status, "queued");
    // The one-minute session runs out with nothing yet to have noticed: the pick finds pc-1 free.
    now += 60_000;
    assert.equal(await platform.bookMachine("pc-1", 730, 30, "steam:2"), null);
    const served = (await platform.viewBooking(waiting.bookingId))!;
    assert.equal(served.status, "matched");
    assert.equal(served.machine?.id, "pc-1");
  });

  it("books nothing on a machine that is gone, not free all session, without the game, or the renter's own", async () => {
    await openPlatform({ owners: new Map([["own", "steam:1"]]) });
    await offer("own");
    await offer("short", { availableUntil: now + 20 * 60_000 });
    await offer("other-game", { games: [570] });
    await offer("silent");
    now += LIVENESS_MS;
    for (const id of ["own", "short", "other-game"]) await platform.heartbeat(id);
    for (const id of ["own", "short", "other-game", "silent", "unknown"]) {
      assert.equal(await platform.bookMachine(id, 730, 30, "steam:1"), null, id);
    }
    assert.equal(await bookingCount(), 0);
  });

  it("books nothing on a machine too far from the renter", async () => {
    await offer("pc-1", { net: { ...REPORT.net, rttMs: 60 } });
    assert.equal(await platform.bookMachine("pc-1", 730, 30, "steam:1", { server: 30 }), null);
    assert.ok(await platform.bookMachine("pc-1", 730, 30, "steam:1", { server: 10 }));
  });
});

describe("the renter ending a booking", () => {
  it("takes a queued booking out of the queue for good", async () => {
    const { bookingId } = await platform.book(730, 30, "steam:1");
    const ended = await platform.endBooking(bookingId, "steam:1");
    assert.ok(ended.ok);
    assert.equal(ended.booking.status, "ended");

    await offer("pc-1");
    assert.equal((await platform.booking(bookingId, "steam:1"))!.status, "ended");
    assert.equal((await platform.heartbeat("pc-1")).status, "available");
  });

  it("hands a matched booking's machine to whoever waits next", async () => {
    await offer("pc-1");
    const first = await platform.book(730, 30, "steam:1");
    const next = await platform.book(730, 30, "steam:2");
    assert.ok((await platform.endBooking(first.bookingId, "steam:1")).ok);
    assert.equal((await platform.booking(next.bookingId, "steam:2"))!.machine?.id, "pc-1");
    assert.deepEqual(await platform.claim(first.bookingId, "steam:1"), {
      ok: false,
      reason: "not-claimable",
      status: "ended",
    });
  });

  it("ends a claimed or playing session as renter, revoking its ticket and freeing the machine", async () => {
    const ended: string[] = [];
    await openPlatform({ onSessionEnded: (machineId, sessionId) => ended.push(`${machineId}:${sessionId}`) });
    for (const playing of [false, true]) {
      await offer("pc-1", { price: 120 });
      const { bookingId } = await platform.book(730, 30, "steam:1");
      const claim = await platform.claim(bookingId, "steam:1");
      assert.ok(claim.ok);
      await platform.recordTicket(claim.sessionId, `ticket-${playing}`);
      if (playing) {
        await platform.startSession("pc-1", claim.sessionId);
        await beatFor("pc-1", 10 * 60_000);
      }

      const result = await platform.endBooking(bookingId, "steam:1");
      assert.ok(result.ok);
      assert.equal(result.booking.status, "ended");
      assert.equal(result.booking.price, playing ? 20 : 0);
      assert.equal(await platform.sessionEndReason(claim.sessionId), "renter");
      assert.ok(await platform.ticketRevoked(`ticket-${playing}`));
      assert.equal((await platform.heartbeat("pc-1")).status, "available");
      assert.equal(ended.at(-1), `pc-1:${claim.sessionId}`);
    }
  });

  it("refuses a booking already over, and anybody else's", async () => {
    const { bookingId } = await platform.book(730, 30, "steam:1");
    assert.deepEqual(await platform.endBooking(bookingId, "steam:2"), { ok: false, reason: "not-found" });
    assert.deepEqual(await platform.endBooking("nope", "steam:1"), { ok: false, reason: "not-found" });
    assert.ok((await platform.endBooking(bookingId, "steam:1")).ok);
    assert.deepEqual(await platform.endBooking(bookingId, "steam:1"), {
      ok: false,
      reason: "over",
      status: "ended",
    });
  });
});

describe("claim notice and host sessions", () => {
  it("tells the server which machine was claimed, with the session, game and minutes", async () => {
    const claims: unknown[] = [];
    await openPlatform({
      onSessionClaimed: (machineId, claim) => claims.push({ machineId, ...claim }),
    });
    await offer("pc-1");
    const { bookingId } = await platform.book(730, 45);
    assert.deepEqual(claims, [], "not told on a match");
    const claim = await platform.claim(bookingId);
    assert.ok(claim.ok);
    assert.deepEqual(claims, [{ machineId: "pc-1", sessionId: claim.sessionId, gameId: 730, minutes: 45 }]);
    assert.ok(!(await platform.claim(bookingId)).ok);
    assert.equal(claims.length, 1, "a refused claim tells nothing");
  });

  it("names the session claimed on a machine only while it runs", async () => {
    await offer("pc-1");
    assert.equal(await platform.claimedSession("pc-1"), null);
    const claim = await platform.claim((await platform.book(730, 30)).bookingId);
    assert.ok(claim.ok);
    assert.deepEqual(await platform.claimedSession("pc-1"), {
      sessionId: claim.sessionId,
      gameId: 730,
      minutes: 30,
    });
    assert.equal(await platform.claimedSession("pc-2"), null);
    await platform.endSession("pc-1", claim.sessionId);
    assert.equal(await platform.claimedSession("pc-1"), null);
  });

  it("removes the host session together with the session it serves, and tells the server its id", async () => {
    const ended: [string, string][] = [];
    await openPlatform({
      onSessionEnded: (machineId, id) => ended.push([machineId, id]),
    });
    await offer("pc-1");
    const claim = await platform.claim((await platform.book(730, 30)).bookingId);
    assert.ok(claim.ok);
    const store = platform.keySessions;
    assert.ok(await store.add("pc-1", { sessionId: claim.sessionId, grantId: "g1" }));
    assert.ok(!(await store.add("pc-1", { sessionId: claim.sessionId, grantId: "g2" })), "one per machine");
    assert.deepEqual(await store.get("pc-1"), { sessionId: claim.sessionId, grantId: "g1" });

    await advance(LIVENESS_MS); // the machine goes silent and its session ends
    assert.equal(await store.get("pc-1"), null);
    assert.deepEqual(ended, [["pc-1", claim.sessionId]]);
  });

  it("ends a host session on its own, leaving the session running", async () => {
    await offer("pc-1");
    const claim = await platform.claim((await platform.book(730, 30)).bookingId);
    assert.ok(claim.ok);
    const store = platform.keySessions;
    await store.add("pc-1", { sessionId: claim.sessionId, grantId: "g1" });
    assert.equal(await store.remove("pc-1"), claim.sessionId);
    assert.equal(await store.remove("pc-1"), null);
    assert.equal((await platform.claimedSession("pc-1"))?.sessionId, claim.sessionId);
  });

  it("keeps host sessions in the database across restarts", async () => {
    await withDatabase(async (open) => {
      const first = await Platform.open({ database: open(), now: () => now });
      await first.setAvailability("pc-1", true, REPORT);
      const claim = await first.claim((await first.book(730, 30)).bookingId);
      assert.ok(claim.ok);
      await first.keySessions.add("pc-1", { sessionId: claim.sessionId, grantId: "g1" });
      await first.close();

      const second = await Platform.open({ database: open(), now: () => now });
      assert.deepEqual(await second.keySessions.get("pc-1"), { sessionId: claim.sessionId, grantId: "g1" });
      await second.close();
    });
  });
});

describe("session end reasons", () => {
  /** A claimed 30-minute session on pc-1 with join ticket "ticket-1", started unless told otherwise. */
  const session = async (start = true) => {
    await offer("pc-1");
    const claim = await platform.claim((await platform.book(730, 30)).bookingId);
    assert.ok(claim.ok);
    await platform.recordTicket(claim.sessionId, "ticket-1");
    if (start) assert.ok(await platform.startSession("pc-1", claim.sessionId));
    return claim.sessionId;
  };

  it("is renter when the renter leaves with the session's own ticket", async () => {
    const id = await session();
    await beatFor("pc-1", 60_000);
    assert.equal(await platform.leaveSession(id, "ticket-1"), "ok");
    assert.equal(await platform.sessionEndReason(id), "renter");
    assert.equal((await platform.heartbeat("pc-1")).status, "available");
    assert.equal(await platform.ticketRevoked("ticket-1"), true);
  });

  it("lets only the session's own ticket leave it, and only while it runs", async () => {
    const id = await session();
    assert.equal(await platform.leaveSession(id, "ticket-2"), "wrong-ticket");
    assert.equal(await platform.leaveSession("no-such-session", "ticket-1"), "not-found");
    assert.equal(await platform.sessionEndReason(id), null);
    await platform.setAvailability("pc-1", false);
    assert.equal(await platform.leaveSession(id, "ticket-1"), "over");
    assert.equal(await platform.sessionEndReason(id), "owner_kill");
  });

  it("is host_end when the host ends a session before its expiry, whatever the host meant", async () => {
    const id = await session();
    await beatFor("pc-1", 60_000);
    await platform.endSession("pc-1", id);
    assert.equal(await platform.sessionEndReason(id), "host_end");
  });

  it("is host_end when the host backdates its end to look like it ran its time", async () => {
    const id = await session();
    await beatFor("pc-1", 60_000);
    await platform.endSession("pc-1", id, now + 30 * 60_000);
    assert.equal(await platform.sessionEndReason(id), "host_end");
  });

  it("is time_up when the host ends it within the grace before its expiry", async () => {
    const id = await session();
    now += 30 * 60_000 - 5_000; // no tick: the host's timer runs slightly ahead of the server's
    await platform.endSession("pc-1", id);
    assert.equal(await platform.sessionEndReason(id), "time_up");
  });

  it("is host_end when the host ends it just outside the grace before its expiry", async () => {
    const id = await session();
    now += 30 * 60_000 - TIME_UP_GRACE_MS - 1_000;
    await platform.endSession("pc-1", id);
    assert.equal(await platform.sessionEndReason(id), "host_end");
  });

  it("is time_up when the host ends it once the server sees it past its expiry", async () => {
    const id = await session();
    now += 30 * 60_000; // no tick: the host's end arrives before the backstop
    await platform.endSession("pc-1", id);
    assert.equal(await platform.sessionEndReason(id), "time_up");
  });

  it("is owner_kill when the owner takes the machine back", async () => {
    const id = await session();
    await platform.setAvailability("pc-1", false);
    assert.equal(await platform.sessionEndReason(id), "owner_kill");
  });

  it("is host_offline when the machine goes silent", async () => {
    const id = await session();
    await advance(LIVENESS_MS);
    assert.equal(await platform.sessionEndReason(id), "host_offline");
  });

  it("is time_up when a started session runs past its time unended", async () => {
    const id = await session();
    await beatFor("pc-1", 30 * 60_000);
    assert.equal(await platform.sessionEndReason(id), "time_up");
  });

  it("is grace_expired when the renter claimed and never arrived", async () => {
    const id = await session(false);
    await beatFor("pc-1", 30 * 60_000);
    assert.equal(await platform.sessionEndReason(id), "grace_expired");
  });

  it("is null while the session runs", async () => {
    assert.equal(await platform.sessionEndReason(await session()), null);
  });
});

describe("machine uptime", () => {
  const uptime = async () => {
    const { stats } = await platform.stability("pc-1");
    return { offeredMs: Math.round(stats.offeredHours * 3_600_000), coverage: stats.heartbeatCoverage };
  };

  it("counts every heartbeat-covered moment while offered", async () => {
    await offer("pc-1");
    await beatFor("pc-1", 10 * 60_000);
    assert.deepEqual(await uptime(), { offeredMs: 10 * 60_000, coverage: 1 });
    assert.equal((await platform.stability("pc-1")).stats.dropsPerHour, 0);
  });

  it("counts a liveness drop, and the time offline as offered but unseen", async () => {
    await offer("pc-1");
    await beatFor("pc-1", 60_000);
    await advance(LIVENESS_MS); // dropped: seen until now, then nothing
    await advance(45_000);
    // Still offline: the time since the drop counts without a check-in.
    assert.deepEqual(await uptime(), { offeredMs: 120_000, coverage: 75 / 120 });
    await platform.heartbeat("pc-1");
    assert.deepEqual(await uptime(), { offeredMs: 120_000, coverage: 75 / 120 });
    assert.equal((await platform.stability("pc-1")).stats.dropsPerHour, 1 / (120 / 3600));
  });

  it("does not count a drop when the host shuts down after its offer ended", async () => {
    await offer("pc-1", { availableUntil: now + 62_000 });
    await beatFor("pc-1", 60_000);
    await advance(LIVENESS_MS + 60_000);
    assert.equal((await platform.stability("pc-1")).stats.dropsPerHour, 0);
    assert.deepEqual(await uptime(), { offeredMs: 62_000, coverage: 1 });
  });

  it("counts a drop when the host goes silent well before its offer ends", async () => {
    await offer("pc-1", { availableUntil: now + 10 * 60_000 });
    await beatFor("pc-1", 60_000);
    await advance(LIVENESS_MS + 60_000);
    const { stats } = await platform.stability("pc-1");
    assert.equal(Math.round(stats.dropsPerHour * stats.offeredHours), 1);
  });

  it("keeps the whole UTC day the seven-day window starts in", async () => {
    await offer("pc-1");
    await beatFor("pc-1", 60 * 60_000);
    await platform.setAvailability("pc-1", false);
    await advance(7 * 24 * 3_600_000 - 30 * 60_000);
    await platform.heartbeat("pc-1");
    assert.deepEqual(await uptime(), { offeredMs: 60 * 60_000, coverage: 1 });
  });

  it("does not count time the machine was taken back", async () => {
    await offer("pc-1");
    await beatFor("pc-1", 60_000);
    await platform.setAvailability("pc-1", false);
    await advance(60 * 60_000);
    await platform.heartbeat("pc-1");
    await offer("pc-1");
    await beatFor("pc-1", 10_000);
    assert.deepEqual(await uptime(), { offeredMs: 70_000, coverage: 1 });
  });

  it("stops counting at the end of the offer", async () => {
    await offer("pc-1", { availableUntil: now + 30_000 });
    await beatFor("pc-1", 60_000);
    assert.deepEqual(await uptime(), { offeredMs: 30_000, coverage: 1 });
  });

  it("splits time across UTC midnight into each day's row", async () => {
    now = Date.UTC(2026, 8, 30, 23, 59, 50);
    await offer("pc-1");
    await beatFor("pc-1", 20_000);
    assert.deepEqual(await uptime(), { offeredMs: 20_000, coverage: 1 });
  });

  it("forgets days older than the seven-day window", async () => {
    await offer("pc-1");
    await beatFor("pc-1", 10_000);
    await platform.setAvailability("pc-1", false);
    await advance(8 * 24 * 3_600_000);
    assert.deepEqual(await uptime(), { offeredMs: 0, coverage: 1 });
  });
});

describe("renter QoS", () => {
  const REPORT_GOOD = { fps: 60, bitrate: 20e6, rttMs: 12, packetLoss: 0.001 };

  /** A claimed session on pc-1 whose join ticket is "ticket-1". */
  const claimed = async () => {
    await offer("pc-1");
    const claim = await platform.claim((await platform.book(730, 30)).bookingId);
    assert.ok(claim.ok);
    await platform.recordTicket(claim.sessionId, "ticket-1");
    return claim.sessionId;
  };

  it("keeps a summary of the session's reports", async () => {
    const id = await claimed();
    assert.equal(await platform.sessionQos(id), null);
    assert.equal(await platform.recordQos(id, "ticket-1", REPORT_GOOD), "ok");
    assert.equal(
      await platform.recordQos(id, "ticket-1", { ...REPORT_GOOD, fps: 30, packetLoss: 0.003 }),
      "ok",
    );
    assert.deepEqual(await platform.sessionQos(id), {
      reports: 2,
      fps: 45,
      bitrate: 20e6,
      rttMs: 12,
      packetLoss: 0.002,
    });
  });

  it("takes reports only with the session's own ticket", async () => {
    const id = await claimed();
    assert.equal(await platform.recordQos(id, "ticket-2", REPORT_GOOD), "wrong-ticket");
    assert.equal(await platform.recordQos("no-such-session", "ticket-1", REPORT_GOOD), "not-found");
    assert.equal(await platform.sessionQos(id), null);
  });

  it("refuses every report for a session handed out with no ticket", async () => {
    await offer("pc-1");
    const claim = await platform.claim((await platform.book(730, 30)).bookingId);
    assert.ok(claim.ok);
    assert.equal(await platform.recordQos(claim.sessionId, "", REPORT_GOOD), "wrong-ticket");
  });

  it("takes a last report shortly after the session ends, and none later", async () => {
    const id = await claimed();
    await platform.endSession("pc-1", id);
    now += QOS_GRACE_MS;
    assert.equal(await platform.recordQos(id, "ticket-1", REPORT_GOOD), "ok");
    now += 1;
    assert.equal(await platform.recordQos(id, "ticket-1", REPORT_GOOD), "over");
  });
});

describe("machine stability", () => {
  /**
   * A two-hour session on pc-1, left by the renter, reporting `packetLoss`.
   * The PC's socket stays open throughout, so the machine is seen with no
   * heartbeat: hours of them would make each test a database round trip per
   * five seconds played.
   */
  const play = async (packetLoss: number) => {
    await platform.hostConnected("pc-1");
    const claim = await platform.claim((await platform.book(730, 180)).bookingId);
    assert.ok(claim.ok);
    await platform.recordTicket(claim.sessionId, `ticket-${claim.sessionId}`);
    assert.ok(await platform.startSession("pc-1", claim.sessionId));
    await advance(2 * 3_600_000);
    await platform.recordQos(claim.sessionId, `ticket-${claim.sessionId}`, {
      fps: 60,
      bitrate: 20e6,
      rttMs: 12,
      packetLoss,
    });
    assert.equal(await platform.leaveSession(claim.sessionId, `ticket-${claim.sessionId}`), "ok");
  };

  it("is New for a machine never heard from", async () => {
    assert.equal((await platform.stability("pc-9")).stability, "new");
  });

  it("is New until five sessions and ten offered hours, then reads the week", async () => {
    await offer("pc-1");
    for (let i = 0; i < 4; i++) await play(0.002);
    assert.equal((await platform.stability("pc-1")).stability, "new");
    await play(0.002);
    const { stats, stability } = await platform.stability("pc-1");
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

  it("is Shaky for a machine whose renters lose too many packets", async () => {
    await offer("pc-1");
    for (let i = 0; i < 5; i++) await play(0.05);
    assert.equal((await platform.stability("pc-1")).stability, "shaky");
  });

  it("only counts the last seven days of sessions", async () => {
    await offer("pc-1");
    for (let i = 0; i < 5; i++) await play(0.05);
    await platform.setAvailability("pc-1", false);
    await advance(8 * 24 * 3_600_000);
    const { stats } = await platform.stability("pc-1");
    assert.equal(stats.sessions, 0);
    assert.equal(stats.offeredHours, 0);
  });
});

describe("deadline timer", () => {
  let changed: string[];

  beforeEach(async () => {
    // Only setTimeout is faked: the platform's own timer is the only thing
    // that can move these bookings, and nothing here calls tick().
    mock.timers.enable({ apis: ["setTimeout"] });
    changed = [];
    await openPlatform({ onBookingChanged: (id) => changed.push(id) });
  });

  afterEach(async () => {
    await platform.close();
    mock.timers.reset();
  });

  /** Let `ms` pass on both the clock and the timers, without calling tick(). */
  const pass = async (ms: number) => {
    now += ms;
    mock.timers.tick(ms);
  };

  it("arms no timer while nothing waits on time", async () => {
    assert.equal(await platform.nextDeadline(), null);
    await platform.book(730, 30);
    assert.equal(await platform.nextDeadline(), now + QUEUE_TIMEOUT_MS);
  });

  it("lapses a reservation at its deadline, not a moment before", async () => {
    await platform.hostConnected("pc-1");
    await offer("pc-1");
    const { bookingId, claimBy } = await platform.book(730, 30);
    assert.equal(claimBy, now + RESERVATION_MS);
    assert.equal(await platform.nextDeadline(), claimBy);
    changed = [];

    await pass(RESERVATION_MS - 1);
    assert.equal((await platform.viewBooking(bookingId))!.status, "matched");
    assert.deepEqual(changed, []);

    await pass(1);
    assert.equal((await platform.viewBooking(bookingId))!.status, "expired");
    assert.deepEqual(changed, [bookingId]);
  });

  it("ends a session at its booked time", async () => {
    await platform.hostConnected("pc-1");
    await offer("pc-1");
    const claim = await platform.claim((await platform.book(730, 30)).bookingId);
    assert.ok(claim.ok);
    await pass(30 * 60_000 - 1);
    assert.equal((await platform.claimedSession("pc-1"))?.sessionId, claim.sessionId);
    await pass(1);
    assert.equal(await platform.claimedSession("pc-1"), null);
  });

  it("drops a machine with no socket once its heartbeat is LIVENESS_MS old", async () => {
    await offer("pc-1");
    const { bookingId } = await platform.book(730, 30);
    await pass(LIVENESS_MS - 1);
    assert.equal((await platform.viewBooking(bookingId))!.status, "matched");
    await pass(1);
    assert.equal(
      (await platform.viewBooking(bookingId))!.status,
      "queued",
      "back in the queue for another machine",
    );
  });

  it("drops a queued booking nobody checks on after QUEUE_TIMEOUT_MS", async () => {
    const { bookingId } = await platform.book(730, 30);
    await pass(QUEUE_TIMEOUT_MS - 1);
    assert.equal((await platform.viewBooking(bookingId))!.status, "queued");
    await pass(1);
    assert.equal((await platform.viewBooking(bookingId))!.status, "expired");
    assert.equal(await platform.nextDeadline(), null);
  });

  it("re-arms for an earlier deadline a change brings in", async () => {
    const { bookingId } = await platform.book(730, 30);
    await offer("pc-1"); // matched now: the reservation lapses before the queue timeout would
    assert.equal(await platform.nextDeadline(), now + LIVENESS_MS);
    await pass(LIVENESS_MS);
    assert.equal((await platform.viewBooking(bookingId))!.status, "queued");
  });
});

describe("presence", () => {
  it("keeps a machine whose socket is open offered with no heartbeat", async () => {
    await platform.hostConnected("pc-1");
    await offer("pc-1");
    await advance(10 * LIVENESS_MS);
    const booking = await platform.book(730, 30);
    assert.equal(booking.status, "matched");
    assert.equal(booking.machine?.id, "pc-1");
  });

  it("takes a machine offline the moment its socket drops, handing its booking back", async () => {
    await platform.hostConnected("pc-1");
    await offer("pc-1");
    const { bookingId } = await platform.book(730, 30);
    await platform.hostDisconnected("pc-1", true);
    assert.equal((await platform.booking(bookingId))!.status, "queued");
    assert.equal((await platform.heartbeat("pc-1")).status, "reserved", "a heartbeat offers it again");
  });

  it("keeps a claimed session through a dropped socket for the liveness window, no longer", async () => {
    await platform.hostConnected("pc-1");
    await offer("pc-1");
    const claim = await platform.claim((await platform.book(730, 30)).bookingId);
    assert.ok(claim.ok);
    await platform.hostDisconnected("pc-1", true);
    await advance(LIVENESS_MS - 1);
    assert.equal((await platform.claimedSession("pc-1"))?.sessionId, claim.sessionId);
    await advance(1);
    assert.equal(await platform.claimedSession("pc-1"), null);
  });

  it("gives a machine handed over to its streamer the liveness window", async () => {
    await platform.hostConnected("pc-1");
    await offer("pc-1");
    const claim = await platform.claim((await platform.book(730, 30)).bookingId);
    assert.ok(claim.ok);
    await advance(10 * LIVENESS_MS);
    await platform.hostDisconnected("pc-1", false);
    await advance(LIVENESS_MS - 1);
    assert.equal((await platform.claimedSession("pc-1"))?.sessionId, claim.sessionId);
    await platform.hostConnected("pc-1"); // the streamer registers
    await advance(10 * LIVENESS_MS);
    assert.equal((await platform.claimedSession("pc-1"))?.sessionId, claim.sessionId);
  });

  it("brings a machine dropped as offline back when its socket reconnects", async () => {
    await offer("pc-1");
    await advance(LIVENESS_MS);
    assert.equal((await platform.book(730, 30)).status, "queued");
    await platform.hostConnected("pc-1");
    assert.equal((await platform.heartbeat("pc-1")).status, "reserved");
  });

  it("stores nothing for a socket from a machine never heard from", async () => {
    await platform.hostConnected("pc-9");
    await platform.hostDisconnected("pc-9", true);
    assert.equal(await platform.machineProfile("pc-9"), null);
  });

  it("gives every machine on offer and every queued booking a fresh deadline after a restart", async () => {
    await withDatabase(async (open) => {
      const first = await Platform.open({ database: open(), now: () => now });
      await first.hostConnected("pc-1");
      await first.setAvailability("pc-1", true, REPORT);
      const queued = await first.book(1, 30); // a game no machine has
      now += 10 * QUEUE_TIMEOUT_MS;
      await first.close();

      const second = await Platform.open({ database: open(), now: () => now });
      assert.equal(await second.nextDeadline(), now + LIVENESS_MS);
      assert.equal((await second.viewBooking(queued.bookingId))!.status, "queued");
      await second.close();
    });
  });

  it("drops a machine that never comes back after a restart as of its last contact", async () => {
    await withDatabase(async (open) => {
      const lastContact = now;
      const first = await Platform.open({ database: open(), now: () => now });
      await first.setAvailability("pc-1", true, REPORT);
      const claim = await first.claim((await first.book(730, 120)).bookingId);
      assert.ok(claim.ok);
      const { sessionId } = claim;
      await first.close();

      now = lastContact + 60 * 60_000;
      const second = await Platform.open({ database: open(), now: () => now });
      now += LIVENESS_MS - 1;
      await second.tick();
      assert.equal(await second.sessionEndReason(sessionId), null);
      now += 1;
      await second.tick();
      assert.equal(await second.sessionEndReason(sessionId), "host_offline");
      const { stats } = await second.stability("pc-1");
      assert.equal(Math.round(stats.offeredHours * stats.heartbeatCoverage * 3_600_000), LIVENESS_MS);
      await second.close();

      assert.equal(await endedAt(open(), sessionId), lastContact);
    });
  });

  it("counts the time a machine on offer was gone across a restart as unseen when it reconnects", async () => {
    await withDatabase(async (open) => {
      const first = await Platform.open({ database: open(), now: () => now });
      await first.setAvailability("pc-1", true, REPORT);
      await first.close();

      now += 10 * 60_000;
      const second = await Platform.open({ database: open(), now: () => now });
      await second.hostConnected("pc-1");
      const { stats } = await second.stability("pc-1");
      assert.equal(Math.round(stats.offeredHours * 3_600_000), 10 * 60_000);
      assert.equal(Math.round(stats.offeredHours * stats.heartbeatCoverage * 3_600_000), LIVENESS_MS);
      await second.close();
    });
  });

  it("ends a game on a present machine that never comes back after a restart as of its last ping round", async () => {
    await withDatabase(async (open) => {
      const first = await Platform.open({ database: open(), now: () => now });
      await first.hostConnected("pc-1");
      await first.setAvailability("pc-1", true, { ...REPORT, price: 120 });
      const { bookingId } = await first.book(730, 180);
      const claim = await first.claim(bookingId);
      assert.ok(claim.ok);
      const { sessionId } = claim;
      await first.startSession("pc-1", sessionId);
      const startedAt = now;
      // Two hours of play with nothing touching the database but the ping rounds.
      for (let t = 0; t < 2 * 60 * 60_000; t += 25_000) {
        now += 25_000;
        await first.hostsAlive(["pc-1"]);
      }
      const lastPing = now;
      now += 20_000; // the server dies before the next round
      await first.close();

      now += 60 * 60_000;
      const second = await Platform.open({ database: open(), now: () => now });
      now += LIVENESS_MS;
      await second.tick();
      assert.equal(await second.sessionEndReason(sessionId), "host_offline");
      assert.equal(
        (await second.booking(bookingId))!.price,
        Math.round((120 * (lastPing - startedAt)) / 3_600_000),
      );
      const { stats } = await second.stability("pc-1");
      const seenMs = Math.round(stats.offeredHours * stats.heartbeatCoverage * 3_600_000);
      assert.equal(seenMs, lastPing - startedAt + LIVENESS_MS);
      await second.close();

      assert.equal(await endedAt(open(), sessionId), lastPing);
    });
  });
});

describe("presence and uptime", () => {
  const uptime = async () => {
    const { stats } = await platform.stability("pc-1");
    return { offeredMs: Math.round(stats.offeredHours * 3_600_000), coverage: stats.heartbeatCoverage };
  };

  it("counts the time a socket is open as seen, with no heartbeat", async () => {
    await platform.hostConnected("pc-1");
    await offer("pc-1");
    await advance(10 * 60_000);
    assert.deepEqual(await uptime(), { offeredMs: 10 * 60_000, coverage: 1 });
    now += 60_000; // no tick in between: still seen
    assert.deepEqual(await uptime(), { offeredMs: 11 * 60_000, coverage: 1 });
  });

  it("counts a dropped socket as a liveness drop, and the time since as unseen", async () => {
    await platform.hostConnected("pc-1");
    await offer("pc-1");
    await advance(60_000);
    await platform.hostDisconnected("pc-1", true);
    await advance(45_000);
    // Seen for the liveness window after its last contact, as after a heartbeat.
    assert.deepEqual(await uptime(), { offeredMs: 105_000, coverage: 75 / 105 });
    assert.equal((await platform.stability("pc-1")).stats.dropsPerHour, 1 / (105 / 3600));
  });

  it("counts no drop for a room the server handed over", async () => {
    await platform.hostConnected("pc-1");
    await offer("pc-1");
    await advance(60_000);
    await platform.hostDisconnected("pc-1", false);
    await platform.hostConnected("pc-1");
    await advance(60_000);
    assert.equal((await platform.stability("pc-1")).stats.dropsPerHour, 0);
    assert.deepEqual(await uptime(), { offeredMs: 120_000, coverage: 1 });
  });
});

describe("a host disconnect the database fails", () => {
  it("still drops the presence, and the retried tick takes the machine offline", async () => {
    await withDatabase(async (open) => {
      const db = await Platform.open({ database: open(), now: () => now });
      await db.hostConnected("pc-1");
      await db.setAvailability("pc-1", true, REPORT);
      const { bookingId } = await db.book(730, 30);
      assert.equal((await db.viewBooking(bookingId))!.status, "matched");
      now += 2 * LIVENESS_MS; // no tick: the machine has not been touched since

      // Every write to machine_uptime fails from here.
      const other = open();
      await other.query("ALTER TABLE machine_uptime RENAME TO machine_uptime_away");
      await assert.rejects(db.hostDisconnected("pc-1", true));
      assert.equal((await db.viewBooking(bookingId))!.status, "matched", "rolled back");
      await other.query("ALTER TABLE machine_uptime_away RENAME TO machine_uptime");
      await other.close();

      // The failure armed a retry in RETRY_MS: no call here moves the booking.
      await wait(RETRY_MS + 500);
      assert.equal(
        (await db.viewBooking(bookingId))!.status,
        "queued",
        "offline, so the booking is handed back",
      );
      await db.close();
    });
  });

  it("drops the presence even when the transaction never begins", async () => {
    const database = await testDatabase();
    let down = false;
    // Connecting fails (a Neon compute that does not wake in time): nothing runs.
    const flaky: Database = {
      query: (sql, params) => database.query(sql, params),
      transaction: (work, begin) =>
        down ? Promise.reject(new Error("connection timeout")) : database.transaction(work, begin),
      close: () => database.close(),
    };
    await platform.close();
    platform = await Platform.open({ database: flaky, now: () => now });
    await platform.hostConnected("pc-1");
    await offer("pc-1");
    const { bookingId } = await platform.book(730, 30);
    assert.equal((await platform.viewBooking(bookingId))!.status, "matched");

    down = true;
    await assert.rejects(platform.hostDisconnected("pc-1", true));
    down = false;

    // No longer present, so silent: offline, and the booking is handed back.
    await advance(2 * LIVENESS_MS);
    assert.equal((await platform.viewBooking(bookingId))!.status, "queued");
  });
});

describe("renters and owners", () => {
  const RENTER = "76561198000000001";
  const OWNER = "76561198000000003";

  beforeEach(async () => {
    await openPlatform({ owners: new Map([["pc-own", OWNER]]) });
  });

  it("never matches a booking to a machine its renter owns", async () => {
    await platform.setAvailability("pc-own", true, { ...REPORT, price: 10 });
    const own = await platform.book(730, 30, OWNER);
    assert.equal(own.status, "queued");

    await beatFor("pc-own", 30_000);
    await platform.book(730, 30, OWNER); // touching the queue again changes nothing
    assert.equal((await platform.booking(own.bookingId, OWNER))!.status, "queued");

    // The same machine goes to the next renter in line instead.
    assert.equal((await platform.book(730, 30, RENTER)).machine?.id, "pc-own");
    await platform.setAvailability("pc-1", true, { ...REPORT, price: 99 });
    assert.equal((await platform.booking(own.bookingId, OWNER))!.machine?.id, "pc-1");
  });

  it("takes the owner from the configuration each time the machine checks in", async () => {
    await withDatabase(async (open) => {
      const before = await Platform.open({ database: open(), now: () => now });
      await before.setAvailability("pc-1", true, REPORT);
      await before.close();

      // Restarted with pc-1's owner configured: the stored machine learns it.
      const after = await Platform.open({
        database: open(),
        now: () => now,
        owners: new Map([["pc-1", OWNER]]),
      });
      await after.heartbeat("pc-1");
      assert.equal((await after.book(730, 30, OWNER)).status, "queued");
      assert.equal((await after.book(730, 30, RENTER)).status, "matched");
      await after.close();
    });
  });

  it("takes back a reservation made before its renter was known to own the machine", async () => {
    await withDatabase(async (open) => {
      // Matched while pc-1 had no owner on record.
      const before = await Platform.open({ database: open(), now: () => now });
      await before.setAvailability("pc-1", true, REPORT);
      const { bookingId } = await before.book(730, 30, OWNER);
      assert.equal((await before.booking(bookingId, OWNER))!.machine?.id, "pc-1");
      await before.close();

      // Restarted knowing OWNER owns pc-1: the next check-in hands it back.
      const after = await Platform.open({
        database: open(),
        now: () => now,
        owners: new Map([["pc-1", OWNER]]),
      });
      assert.equal((await after.heartbeat("pc-1")).status, "available");
      const requeued = (await after.booking(bookingId, OWNER))!;
      assert.equal(requeued.status, "queued");
      assert.equal(requeued.machine, undefined);
      assert.equal((await after.book(730, 30, RENTER)).machine?.id, "pc-1");
      await after.close();
    });
  });

  it("refuses to claim the renter's own machine before it has checked in again", async () => {
    await withDatabase(async (open) => {
      const before = await Platform.open({ database: open(), now: () => now });
      await before.setAvailability("pc-1", true, REPORT);
      const { bookingId } = await before.book(730, 30, OWNER);
      await before.close();

      const after = await Platform.open({
        database: open(),
        now: () => now,
        owners: new Map([["pc-1", OWNER]]),
      });
      assert.deepEqual(await after.claim(bookingId, OWNER), {
        ok: false,
        reason: "not-claimable",
        status: "queued",
      });
      assert.equal((await after.booking(bookingId, OWNER))!.status, "queued");
      assert.equal((await after.book(730, 30, RENTER)).machine?.id, "pc-1");
      await after.close();
    });
  });

  it("shows and hands a booking only to the renter who made it", async () => {
    await platform.setAvailability("pc-1", true, REPORT);
    const { bookingId } = await platform.book(730, 30, RENTER);
    assert.equal(await platform.booking(bookingId, OWNER), null);
    assert.equal(await platform.booking(bookingId), null); // nor to nobody
    assert.deepEqual(await platform.claim(bookingId, OWNER), { ok: false, reason: "not-found" });
    assert.equal((await platform.booking(bookingId, RENTER))!.status, "matched");
    assert.ok((await platform.claim(bookingId, RENTER)).ok);
  });
});

describe("machines on offer", () => {
  const ids = async () => (await platform.offeredMachines()).machines.map((m) => m.host.id);

  it("reads any number of machines with the same few statements", async () => {
    // Counts what each call sends the database: the calls behind a read wait on all of it.
    let statements = 0;
    const counted = (db: Database): Database => ({
      ...db,
      transaction: (work, begin, setup) =>
        db.transaction(
          (tx) =>
            work({
              query: (sql, params) => {
                statements += 1;
                return tx.query(sql, params);
              },
            }),
          begin,
          setup,
        ),
    });
    await platform.close();
    platform = await Platform.open({ database: counted(await testDatabase()), now: () => now });
    const read = async () => {
      statements = 0;
      const { machines } = await platform.offeredMachines();
      return { machines: machines.length, statements };
    };

    await offer("pc-1");
    await platform.book(730, 30);
    await offer("pc-2");
    const few = await read();
    assert.equal(few.machines, 2);
    for (let i = 3; i <= 8; i++) {
      await offer(`pc-${i}`);
      await platform.book(730, 30);
    }
    const many = await read();
    assert.equal(many.machines, 8);
    assert.equal(many.statements, few.statements);
  });

  it("gives each machine its own free-again time and history", async () => {
    await offer("pc-1", { price: 10 });
    const reserved = await platform.book(730, 30);
    await offer("pc-2", { price: 20 });
    const claim = await platform.claim((await platform.book(570, 60)).bookingId);
    assert.ok(claim.ok);
    await offer("pc-3", { price: 30 });

    const { machines } = await platform.offeredMachines();
    const byId = new Map(machines.map((m) => [m.host.id, m]));
    assert.equal(byId.get("pc-1")!.backAt, reserved.claimBy! + 30 * 60_000);
    assert.equal(byId.get("pc-2")!.backAt, now + 60 * 60_000);
    assert.equal(byId.get("pc-3")!.backAt, null);
    for (const id of ["pc-1", "pc-2", "pc-3"]) {
      assert.deepEqual(byId.get(id)!.history, (await platform.stability(id)).stats, id);
    }
  });

  it("lists what is offered and answering, with no machine taken back or gone silent", async () => {
    await offer("pc-1");
    await offer("pc-2");
    await offer("pc-3");
    await platform.setAvailability("pc-2", false);
    assert.deepEqual(await ids(), ["pc-1", "pc-3"]);
    await advance(LIVENESS_MS);
    await platform.heartbeat("pc-3");
    assert.deepEqual(await ids(), ["pc-3"]);
    const [pc3] = (await platform.offeredMachines()).machines;
    assert.equal(pc3!.host.status, "available");
    assert.deepEqual(pc3!.host.installed, [570, 730]);
    assert.equal(pc3!.profile.name, REPORT.name);
    assert.equal(pc3!.backAt, null);
  });

  it("counts a machine whose socket is open as seen now", async () => {
    await offer("pc-1");
    await platform.hostConnected("pc-1");
    now += 10 * LIVENESS_MS; // no tick: nothing has been settled since
    const { at, machines } = await platform.offeredMachines();
    assert.equal(at, now);
    assert.equal(machines[0]!.host.lastHeartbeatAt, now);
  });

  it("says when a busy machine is free again at the latest", async () => {
    await offer("pc-1");
    const { bookingId } = await platform.book(730, 30);
    const reserved = (await platform.offeredMachines()).machines[0]!;
    assert.equal(reserved.host.status, "busy");
    assert.equal(reserved.backAt, now + RESERVATION_MS + 30 * 60_000);

    await advance(10_000);
    await platform.heartbeat("pc-1");
    assert.ok((await platform.claim(bookingId)).ok);
    assert.equal((await platform.offeredMachines()).machines[0]!.backAt, now + 30 * 60_000);
  });
});
