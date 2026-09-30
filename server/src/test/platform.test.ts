// The booking lifecycle and machine liveness, against a real SQLite database
// in memory and a clock the tests move by hand.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { LIVENESS_MS, Platform, QUEUE_TIMEOUT_MS, RESERVATION_MS } from "../platform.js";

let now: number;
let platform: Platform;

beforeEach(() => {
  now = Date.UTC(2026, 8, 30, 12);
  platform = new Platform({ now: () => now });
});

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

    platform.setAvailability("pc-1", true, { gpu: "RTX 4070", price: 120 });
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
    platform.setAvailability("pc-1", true);
    const booking = platform.book(730, 30);
    assert.equal(booking.status, "matched");
    assert.equal(booking.machine?.id, "pc-1");
  });

  it("refuses a claim once the reservation has lapsed and the renter is gone, and frees the machine", () => {
    platform.setAvailability("pc-1", true);
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

    platform.setAvailability("pc-1", true);
    assert.ok(platform.claim(bookingId).ok);
    assert.deepEqual(platform.claim(bookingId), { ok: false, reason: "not-claimable", status: "claimed" });
    assert.deepEqual(platform.claim("nope"), { ok: false, reason: "not-found" });
  });

  it("gives a machine to at most one booking, and the next one waits in order", () => {
    platform.setAvailability("pc-1", true);
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
    platform.setAvailability("pc-1", true, { availableUntil: now + 20 * 60_000 });
    const long = platform.book(730, 30);
    const short = platform.book(570, 15);
    assert.equal(platform.booking(long.bookingId)!.status, "queued");
    assert.equal(platform.booking(short.bookingId)!.machine?.id, "pc-1");
  });

  it("prices only the time actually played", () => {
    platform.setAvailability("pc-1", true, { price: 120 }); // cents per hour
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
    platform.setAvailability("pc-1", true);
    const { bookingId } = platform.book(730, 10);
    const claim = platform.claim(bookingId);
    assert.ok(claim.ok);

    beatFor("pc-1", 10 * 60_000);
    assert.equal(platform.booking(bookingId)!.status, "ended");
    assert.equal(platform.heartbeat("pc-1").status, "available");
    assert.equal(platform.startSession("pc-1", claim.sessionId), false);
  });

  it("only lets a machine start and end its own sessions", () => {
    platform.setAvailability("pc-1", true);
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
    platform.setAvailability("pc-1", true);
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

    platform.setAvailability("pc-1", true);
    assert.equal(platform.booking(bookingId)!.status, "matched");
  });

  it("keeps the booking of a renter who was away while its reservation lapsed", () => {
    platform.setAvailability("pc-1", true);
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
    platform.setAvailability("pc-1", true);
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
    platform.setAvailability("pc-1", true);
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
});

describe("session end notice", () => {
  let ended: string[];

  beforeEach(() => {
    ended = [];
    platform = new Platform({ now: () => now, onSessionEnded: (machineId) => ended.push(machineId) });
  });

  const claimed = () => {
    platform.setAvailability("pc-1", true);
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
});

describe("machine liveness", () => {
  it("stops offering a machine within seconds of its heartbeats stopping", () => {
    platform.setAvailability("pc-1", true);
    beatFor("pc-1", 60_000);
    assert.equal(platform.heartbeat("pc-1").status, "available");

    advance(LIVENESS_MS);
    const booking = platform.book(730, 30);
    assert.equal(booking.status, "queued");
  });

  it("keeps offering a machine whose heartbeats keep coming", () => {
    platform.setAvailability("pc-1", true);
    beatFor("pc-1", 10 * 60_000);
    assert.equal(platform.book(730, 30).status, "matched");
  });

  it("hands a reserved booking to another machine when its machine goes silent", () => {
    platform.setAvailability("pc-1", true);
    const { bookingId } = platform.book(730, 30);
    assert.equal(platform.booking(bookingId)!.machine?.id, "pc-1");

    platform.setAvailability("pc-2", true);
    beatFor("pc-2", LIVENESS_MS); // pc-1 says nothing
    const moved = platform.booking(bookingId)!;
    assert.equal(moved.status, "matched");
    assert.equal(moved.machine?.id, "pc-2");
  });

  it("ends the session of a machine that goes silent mid-game", () => {
    platform.setAvailability("pc-1", true);
    const { bookingId } = platform.book(730, 30);
    const claim = platform.claim(bookingId);
    assert.ok(claim.ok);
    platform.startSession("pc-1", claim.sessionId);

    advance(LIVENESS_MS);
    assert.equal(platform.booking(bookingId)!.status, "ended");
  });

  it("offers a dropped machine again when its heartbeats resume", () => {
    platform.setAvailability("pc-1", true);
    advance(LIVENESS_MS);
    assert.equal(platform.book(730, 30).status, "queued");

    const machine = platform.heartbeat("pc-1");
    assert.equal(machine.status, "reserved");
  });

  it("takes a machine back at once, ending what it was doing", () => {
    platform.setAvailability("pc-1", true);
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
      first.setAvailability("pc-1", true);
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
