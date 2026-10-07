// The renter's event stream over HTTP: GET /api/events?booking= pushes each
// booking change as it happens. Opening it counts as the renter's contact;
// after that only the page's heartbeat, POST /api/bookings/:id/seen, does. Both
// need the signed-in renter, and only for their own bookings. GET /api/events
// with no booking tells the signed-in renter's wall each time what is on offer
// changes.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { mintRenterSession } from "../access.js";
import { createApi } from "../api.js";
import { createRenterEvents, MAX_STREAMS_PER_BOOKING, type RenterEvents } from "../events.js";
import { MAX_HOLD_MS, Platform, QUEUE_TIMEOUT_MS, RESERVATION_MS } from "../platform.js";
import { SESSION_COOKIE } from "../signin.js";
import { testDatabase } from "./db.js";
import { REPORT } from "./report.js";

const SESSION = "test-session-secret-that-is-long-enough-too";
const RENTER = "76561198000000001";
const OTHER = "76561198000000002";

/** The Cookie header of `steamId` signed in. */
const signedIn = (steamId: string) => `${SESSION_COOKIE}=${mintRenterSession(SESSION, steamId, 3600)}`;

/** One open event stream: the events and comments read so far, and a way to hang up. */
type Stream = {
  status: number;
  events: { event: string; data: any }[];
  comments: string[];
  /** True once the server ended the stream. */
  ended: boolean;
  close(): void;
};

/** Give the server and the stream reader `ms` to catch up. */
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until `check` holds, for at most `ms`: a change reaches a stream after
 * the platform reads the booking again, later on a loaded machine.
 */
async function until(check: () => boolean, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !check() && Date.now() < end;) await settle(10);
}

describe("renter event stream", () => {
  let now: number;
  let platform: Platform;
  let origin: string;
  let server: Server;

  before(async () => {
    server = createServer(async (req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (!(await api(req, res, path))) res.writeHead(418).end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  // A stream a failed test left open must not hold the server open forever.
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  let api: ReturnType<typeof createApi>;
  let events: RenterEvents;
  beforeEach(async () => {
    now = Date.UTC(2026, 8, 30, 12);
    // Wired as index.ts wires it: every booking and availability change goes to the streams.
    platform = await Platform.open({
      database: await testDatabase(),
      now: () => now,
      onBookingChanged: (id) => void events.bookingChanged(id),
      onAvailabilityChanged: () => events.availabilityChanged(),
    });
    events = createRenterEvents(platform, { keepAliveMs: 20, maxStreams: 8, maxStreamsPerRenter: 5 });
    api = createApi({
      platform,
      access: { secret: null, machines: new Map(), owners: new Map() },
      sessionSecret: SESSION,
      publicOrigin: null,
      fallbackOrigin: origin,
      events,
    });
  });

  afterEach(() => platform.close());

  /** Open GET /api/events?booking=… as `cookie`'s renter (none: signed out) and keep reading it in the background. */
  async function stream(
    query: string,
    headers: Record<string, string> = {},
    cookie: string | null = signedIn(RENTER),
  ): Promise<Stream> {
    const abort = new AbortController();
    const response = await fetch(`${origin}/api/events${query}`, {
      signal: abort.signal,
      headers: { ...headers, ...(cookie ? { cookie } : {}) },
    });
    const result: Stream = {
      status: response.status,
      events: [],
      comments: [],
      ended: false,
      close: () => abort.abort(),
    };
    if (!response.ok) {
      await response.body?.cancel();
      return result;
    }
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      const reader = response.body!.getReader();
      try {
        for (let read = await reader.read(); !read.done; read = await reader.read()) {
          buffer += decoder.decode(read.value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (block.startsWith(":")) result.comments.push(block.slice(1).trim());
            else {
              const field = (name: string) =>
                block
                  .split("\n")
                  .find((line) => line.startsWith(`${name}: `))
                  ?.slice(name.length + 2);
              result.events.push({ event: field("event")!, data: JSON.parse(field("data")!) });
            }
          }
        }
        result.ended = true;
      } catch {
        // aborted by close()
      }
    })();
    await until(() => result.events.length > 0 || result.ended);
    return result;
  }

  /** The page's heartbeat on the booking as `cookie`'s renter (none: signed out); its status. */
  const seen = async (bookingId: string, cookie: string | null = signedIn(RENTER)) =>
    (
      await fetch(`${origin}/api/bookings/${bookingId}/seen`, {
        method: "POST",
        headers: cookie ? { cookie } : {},
      })
    ).status;

  /** The booking statuses the stream has sent so far. */
  const statuses = (s: Stream) => s.events.map((e) => e.data.status);

  it("sends the booking at once, then each change the moment it happens", async () => {
    const { bookingId } = await platform.book(730, 30, RENTER);
    const s = await stream(`?booking=${bookingId}`);
    assert.equal(s.status, 200);
    assert.deepEqual(statuses(s), ["queued"]);
    assert.equal(s.events[0]!.event, "booking");

    await platform.setAvailability("pc-1", true, REPORT);
    await until(() => s.events.length > 1);
    assert.deepEqual(statuses(s), ["queued", "matched"]);
    const matched = s.events[1]!.data;
    assert.equal(matched.machine.id, "pc-1");
    assert.equal(typeof matched.claimBy, "number", "the claim countdown");

    await platform.claim(bookingId, RENTER);
    await until(() => s.events.length > 2);
    assert.deepEqual(statuses(s), ["queued", "matched", "claimed"]);
    s.close();
  });

  it("sends keep-alive comments so an idle stream is not closed", async () => {
    const { bookingId } = await platform.book(730, 30, RENTER);
    const s = await stream(`?booking=${bookingId}`);
    await until(() => s.comments.includes("keep-alive"));
    assert.ok(s.comments.includes("keep-alive"));
    s.close();
  });

  it("keeps a queued booking in the queue while the page beats, and only from its last beat", async () => {
    const { bookingId } = await platform.book(730, 30, RENTER);
    const s = await stream(`?booking=${bookingId}`);
    for (let beat = 0; beat < 6; beat++) {
      now += QUEUE_TIMEOUT_MS / 2;
      assert.equal(await seen(bookingId), 204);
    }
    assert.equal((await platform.viewBooking(bookingId))!.status, "queued", "beating, so still waiting");

    // The page stops beating, but its stream stays open.
    now += QUEUE_TIMEOUT_MS - 1;
    await platform.tick();
    assert.equal((await platform.viewBooking(bookingId))!.status, "queued");
    now += 1;
    await platform.tick();
    assert.equal(
      (await platform.viewBooking(bookingId))!.status,
      "expired",
      "an open stream is not the renter",
    );
    s.close();
  });

  it("gives a renter whose stream is open at a match the host made 60 s from it, however often the page beats", async () => {
    const { bookingId } = await platform.book(730, 30, RENTER);
    const s = await stream(`?booking=${bookingId}`);
    await platform.hostConnected("pc-1");
    now += 10_000; // between two beats of the page
    await platform.setAvailability("pc-1", true, REPORT);
    await until(() => s.events.length > 1);
    assert.deepEqual(statuses(s), ["queued", "matched"]);
    const matchedAt = now;
    assert.equal(s.events[1]!.data.claimBy, matchedAt + RESERVATION_MS);

    now += 5_000;
    assert.equal(await seen(bookingId), 204);
    assert.equal((await platform.viewBooking(bookingId))!.claimBy, matchedAt + RESERVATION_MS);
    s.close();
  });

  it("holds a match made while the tab was closed, and starts its claim clock when the stream reopens", async () => {
    const { bookingId } = await platform.book(730, 30, RENTER);
    await platform.hostConnected("pc-1");
    now += 1_000; // the tab is closed: no stream, no beat
    await platform.setAvailability("pc-1", true, REPORT);
    const matchedAt = now;
    const held = (await platform.viewBooking(bookingId))!;
    assert.equal(held.status, "matched");
    assert.equal(held.claimBy, matchedAt + MAX_HOLD_MS, "held for them meanwhile");

    now += 50_000; // the tab reopens and so does the stream, 10 s before a clock from the match would end
    const back = await stream(`?booking=${bookingId}`);
    assert.deepEqual(statuses(back), ["matched"]);
    assert.equal(back.events[0]!.data.claimBy, now + RESERVATION_MS);
    now += RESERVATION_MS - 1;
    await platform.tick();
    assert.equal((await platform.viewBooking(bookingId))!.status, "matched");
    back.close();
  });

  it("answers the heartbeat with 204, and 404 for an unknown booking", async () => {
    const { bookingId } = await platform.book(730, 30, RENTER);
    assert.equal(await seen(bookingId), 204);
    assert.equal(await seen("nope"), 404);
  });

  it("refuses a signed-out caller with 401, and somebody else's booking reads as not found", async () => {
    const { bookingId } = await platform.book(730, 30, RENTER);
    assert.equal((await stream(`?booking=${bookingId}`, {}, null)).status, 401);
    assert.equal(await seen(bookingId, null), 401);
    assert.equal((await stream(`?booking=${bookingId}`, {}, signedIn(OTHER))).status, 404);
    assert.equal(await seen(bookingId, signedIn(OTHER)), 404);
  });

  it("answers 404 for an unknown booking and 400 for an empty one", async () => {
    assert.equal((await stream("?booking=nope")).status, 404);
    assert.equal((await stream("?booking=")).status, 400);
  });

  /** The availability events the stream has sent so far. */
  const availability = (s: Stream) => s.events.filter((e) => e.event === "availability");

  /**
   * Wait until the wall's stream `s` has read all that was sent to it so far: a
   * stream is written in order, so a crew event sent now arrives after all of it.
   */
  async function caughtUp(s: Stream): Promise<void> {
    const crew = () => s.events.filter((e) => e.event === "crew").length;
    const before = crew();
    events.crewChanged();
    await until(() => crew() > before, 30_000);
    assert.ok(crew() > before, "the wall's stream did not catch up within 30 s");
  }

  it("tells the wall each time a machine is offered, taken, freed or taken back, and nothing else", async () => {
    const s = await stream("");
    assert.equal(s.status, 200);
    await caughtUp(s);
    assert.equal(availability(s).length, 0, "nothing until something changes");

    await platform.setAvailability("pc-1", true, REPORT);
    await caughtUp(s);
    assert.deepEqual(availability(s), [{ event: "availability", data: {} }]);

    // A heartbeat that changes nothing on offer is not news.
    await platform.heartbeat("pc-1");
    await caughtUp(s);
    assert.equal(availability(s).length, 1);

    // Matched to someone's booking: busy. Their booking is not this stream's to tell.
    const { bookingId } = await platform.book(730, 30, OTHER);
    await caughtUp(s);
    assert.equal(availability(s).length, 2);
    assert.ok(
      s.events.every((e) => e.event !== "booking"),
      "no booking on the wall's stream",
    );

    await platform.setAvailability("pc-1", false);
    await caughtUp(s);
    assert.equal(availability(s).length, 3, "taken back");
    assert.equal((await platform.viewBooking(bookingId))!.status, "queued");
    s.close();
  });

  it("sends keep-alives on the wall's stream too, and refuses it signed out", async () => {
    const s = await stream("");
    await until(() => s.comments.includes("keep-alive"));
    assert.ok(s.comments.includes("keep-alive"));
    s.close();
    assert.equal((await stream("", {}, null)).status, 401);
  });

  it("counts the wall's streams against the renter's cap with their booking streams", async () => {
    const { bookingId } = await platform.book(730, 30, RENTER);
    const open = [await stream(`?booking=${bookingId}`)];
    for (let i = 0; i < 4; i++) open.push(await stream(""));
    assert.deepEqual(
      open.map((s) => s.status),
      [200, 200, 200, 200, 200],
    );
    assert.equal((await stream("")).status, 429, "their sixth");
    const other = await stream("", {}, signedIn(OTHER));
    assert.equal(other.status, 200, "another renter has their own");
    for (const s of [...open, other]) s.close();
  });

  it("ends the wall's stream when the renter's session runs out", () => {
    let clock = 1_000;
    const events = createRenterEvents(platform, { keepAliveMs: 60_000, now: () => clock });
    const res = fakeResponse();
    assert.equal(events.openAvailability(res as unknown as ServerResponse, RENTER, 2_000), "opened");
    events.availabilityChanged();
    assert.equal(res.writableEnded, false);
    clock = 2_000;
    events.availabilityChanged();
    assert.equal(res.writableEnded, true);
    assert.equal(res.writesAfterEnd, 0);
    res.destroy();
  });

  it("refuses more than MAX_STREAMS_PER_BOOKING streams on one booking with 429", async () => {
    const { bookingId } = await platform.book(730, 30, RENTER);
    const open: Stream[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_BOOKING; i++) open.push(await stream(`?booking=${bookingId}`));
    assert.deepEqual(
      open.map((s) => s.status),
      Array(MAX_STREAMS_PER_BOOKING).fill(200),
    );
    assert.equal((await stream(`?booking=${bookingId}`)).status, 429);

    open[0]!.close();
    // Its place is free once the server has seen it close.
    let another = await stream(`?booking=${bookingId}`);
    for (const end = Date.now() + 5_000; another.status === 429 && Date.now() < end;) {
      await settle(10);
      another = await stream(`?booking=${bookingId}`);
    }
    assert.equal(another.status, 200, "a closed stream frees its place");
    for (const s of [...open, another]) s.close();
  });

  it("answers somebody else's booking with 404 even while its own streams are full", async () => {
    const { bookingId } = await platform.book(730, 30, RENTER);
    const open: Stream[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_BOOKING; i++) open.push(await stream(`?booking=${bookingId}`));
    // 429 here would tell a stranger the booking exists and is being watched.
    assert.equal((await stream(`?booking=${bookingId}`, {}, signedIn(OTHER))).status, 404);
    for (const s of open) s.close();
  });

  it("ends the stream once the booking needs no more watching", async () => {
    await platform.setAvailability("pc-1", true, REPORT);
    const { bookingId } = await platform.book(730, 30, RENTER);
    const s = await stream(`?booking=${bookingId}`);
    assert.deepEqual(statuses(s), ["matched"]);
    assert.equal(s.ended, false);

    await platform.claim(bookingId, RENTER);
    await until(() => s.ended);
    assert.deepEqual(statuses(s), ["matched", "claimed"]);
    assert.equal(s.ended, true);

    const late = await stream(`?booking=${bookingId}`);
    assert.deepEqual(statuses(late), ["claimed"], "a finished booking is sent once");
    assert.equal(late.ended, true);
  });

  it("follows a running session on to its end with to=end, saying why it ended", async () => {
    await platform.setAvailability("pc-1", true, REPORT);
    const { bookingId } = await platform.book(730, 30, RENTER);
    const claim = await platform.claim(bookingId, RENTER);
    assert.ok(claim.ok);
    const s = await stream(`?booking=${bookingId}&to=end`);
    assert.deepEqual(statuses(s), ["claimed"]);
    assert.equal(s.ended, false);

    await platform.startSession("pc-1", claim.sessionId);
    await until(() => s.events.length > 1);
    assert.equal(s.ended, false);

    // The owner takes the machine back mid-session.
    await platform.setAvailability("pc-1", false);
    await until(() => s.ended);
    assert.deepEqual(statuses(s), ["claimed", "playing", "ended"]);
    assert.equal(s.events[2]!.data.endReason, "owner_kill");
  });

  /**
   * A stand-in response: `write` answers `writes` and counts the chunks written
   * after end(), and destroy() closes it as a hung-up socket does.
   */
  const fakeResponse = (writes = true) => {
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      writesAfterEnd: 0,
      writeHead() {},
      write: () => {
        if (res.writableEnded) res.writesAfterEnd += 1;
        return writes;
      },
      end() {
        res.writableEnded = true;
      },
      destroy() {
        res.destroyed = true;
        res.emit("close");
      },
    });
    return res;
  };

  it("drops a stream whose renter does not read", async () => {
    const { bookingId } = await platform.book(730, 30, RENTER);
    const events = createRenterEvents(platform, { keepAliveMs: 60_000 });
    const res = fakeResponse(false); // its send buffer is already full
    assert.equal(await events.open(res as unknown as ServerResponse, bookingId, RENTER, Infinity), "opened");
    assert.equal(res.destroyed, true);
  });

  it("holds no stream for a renter who hung up while the booking was read", async () => {
    const { bookingId } = await platform.book(730, 30, RENTER);
    const events = createRenterEvents(platform, { keepAliveMs: 60_000, maxStreamsPerRenter: 1 });
    const gone = fakeResponse();
    const opening = events.open(gone as unknown as ServerResponse, bookingId, RENTER, Infinity);
    gone.destroy();
    assert.equal(await opening, "gone");
    const next = fakeResponse();
    assert.equal(
      await events.open(next as unknown as ServerResponse, bookingId, RENTER, Infinity),
      "opened",
      "the renter's one place was never taken",
    );
    next.destroy();
  });

  it("writes nothing more to a stream it ended before the stream has closed", async () => {
    await platform.setAvailability("pc-1", true, REPORT);
    const { bookingId } = await platform.book(730, 30, RENTER);
    await platform.claim(bookingId, RENTER);
    const events = createRenterEvents(platform, { keepAliveMs: 60_000 });
    const res = fakeResponse(); // ended, but its close event has not come yet
    assert.equal(await events.open(res as unknown as ServerResponse, bookingId, RENTER, Infinity), "opened");
    assert.equal(res.writableEnded, true);
    await events.bookingChanged(bookingId);
    assert.equal(res.writesAfterEnd, 0);
  });

  it("ends the stream when the renter's session runs out, on the next change or keep-alive", async () => {
    const { bookingId } = await platform.book(730, 30, RENTER);
    let clock = 1_000;
    const events = createRenterEvents(platform, { keepAliveMs: 5, now: () => clock });
    const res = fakeResponse();
    assert.equal(await events.open(res as unknown as ServerResponse, bookingId, RENTER, 2_000), "opened");
    await events.bookingChanged(bookingId);
    assert.equal(res.writableEnded, false, "still signed in");

    clock = 2_000;
    await events.bookingChanged(bookingId);
    assert.equal(res.writableEnded, true, "a change after the session ran out ends the stream");
    assert.equal(res.writesAfterEnd, 0);

    const idle = fakeResponse();
    assert.equal(await events.open(idle as unknown as ServerResponse, bookingId, RENTER, 3_000), "opened");
    clock = 3_000;
    await until(() => idle.writableEnded);
    assert.equal(idle.writableEnded, true, "the keep-alive ends it with no change at all");
    assert.equal(idle.writesAfterEnd, 0);
    res.destroy();
    idle.destroy();
  });

  it("holds a renter to the per-renter cap however the client address header is rotated, and leaves other renters alone", async () => {
    const bookings: string[] = [];
    for (let i = 0; i < 3; i++) bookings.push((await platform.book(730, 30, RENTER)).bookingId);
    /** A fresh CF-Connecting-IP on every request, as a renter dodging an address cap would send. */
    let address = 0;
    const rotated = () => ({ "cf-connecting-ip": `203.0.113.${++address}` });
    const open: Stream[] = [];
    for (let i = 0; i < 5; i++) open.push(await stream(`?booking=${bookings[i % 3]}`, rotated()));
    assert.deepEqual(
      open.map((s) => s.status),
      [200, 200, 200, 200, 200],
    );
    // Booking 3 holds one stream, well under its own cap: only the renter's cap refuses this.
    assert.equal((await stream(`?booking=${bookings[2]}`, rotated())).status, 429, "their sixth");
    assert.equal(
      (await stream("?booking=no-such-booking", rotated())).status,
      404,
      "an unknown one is still 404",
    );
    const theirs = (await platform.book(730, 30, OTHER)).bookingId;
    const other = await stream(`?booking=${theirs}`, rotated(), signedIn(OTHER));
    assert.equal(other.status, 200, "another renter is not held to the first one's count");
    for (const s of [...open, other]) s.close();
  });

  it("refuses any stream beyond the server-wide cap until one closes", async () => {
    const events: RenterEvents = createRenterEvents(platform, { maxStreams: 2, keepAliveMs: 60_000 });
    const renters = ["76561198000000011", "76561198000000012", "76561198000000013"];
    const [a, b, c] = await Promise.all(
      renters.map(async (renter) => ({
        renter,
        bookingId: (await platform.book(730, 30, renter)).bookingId,
      })),
    );
    const first = fakeResponse();
    const open = ({ renter, bookingId }: { renter: string; bookingId: string }, res = fakeResponse()) =>
      events.open(res as unknown as ServerResponse, bookingId, renter, Infinity);
    assert.equal(await open(a!, first), "opened");
    assert.equal(await open(b!), "opened");
    assert.equal(await open(c!), "too-many", "a third renter, a third booking: the server is full");
    assert.equal(
      await open({ renter: c!.renter, bookingId: "no-such-booking" }),
      "not-found",
      "an unknown booking reads as not found even when the server is full",
    );
    assert.equal(
      await open({ renter: c!.renter, bookingId: a!.bookingId }),
      "not-found",
      "and so does somebody else's",
    );

    first.destroy();
    assert.equal(await open(c!), "opened");
  });
});
