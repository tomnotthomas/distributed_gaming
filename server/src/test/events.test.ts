// The renter's event stream over HTTP: GET /api/events pushes each booking
// change as it happens. Opening it counts as the renter's contact; after that
// only the page's heartbeat, POST /api/bookings/:id/seen, does. Both need the
// signed-in renter, and only for their own bookings.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { mintRenterSession } from "../access.js";
import { createApi } from "../api.js";
import { createRenterEvents, MAX_STREAMS_PER_BOOKING, type RenterEvents } from "../events.js";
import { Platform, QUEUE_TIMEOUT_MS, RESERVATION_MS } from "../platform.js";
import { SESSION_COOKIE } from "../signin.js";
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

  after(() => server.close());

  let api: ReturnType<typeof createApi>;
  beforeEach(() => {
    now = Date.UTC(2026, 8, 30, 12);
    // Wired as index.ts wires it: every booking change goes to the streams.
    const events = createRenterEvents(
      (platform = new Platform({ now: () => now, onBookingChanged: (id) => events.bookingChanged(id) })),
      { keepAliveMs: 20, maxStreams: 8, maxStreamsPerRenter: 5 },
    );
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
    await settle();
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
    const { bookingId } = platform.book(730, 30, RENTER);
    const s = await stream(`?booking=${bookingId}`);
    assert.equal(s.status, 200);
    assert.deepEqual(statuses(s), ["queued"]);
    assert.equal(s.events[0]!.event, "booking");

    platform.setAvailability("pc-1", true, REPORT);
    await settle();
    assert.deepEqual(statuses(s), ["queued", "matched"]);
    const matched = s.events[1]!.data;
    assert.equal(matched.machine.id, "pc-1");
    assert.equal(typeof matched.claimBy, "number", "the claim countdown");

    platform.claim(bookingId, RENTER);
    await settle();
    assert.deepEqual(statuses(s), ["queued", "matched", "claimed"]);
    s.close();
  });

  it("sends keep-alive comments so an idle stream is not closed", async () => {
    const { bookingId } = platform.book(730, 30, RENTER);
    const s = await stream(`?booking=${bookingId}`);
    await settle(60);
    assert.ok(s.comments.includes("keep-alive"));
    s.close();
  });

  it("keeps a queued booking in the queue while the page beats, and only from its last beat", async () => {
    const { bookingId } = platform.book(730, 30, RENTER);
    const s = await stream(`?booking=${bookingId}`);
    for (let beat = 0; beat < 6; beat++) {
      now += QUEUE_TIMEOUT_MS / 2;
      assert.equal(await seen(bookingId), 204);
    }
    assert.equal(platform.viewBooking(bookingId)!.status, "queued", "beating, so still waiting");

    // The page stops beating, but its stream stays open.
    now += QUEUE_TIMEOUT_MS - 1;
    platform.tick();
    assert.equal(platform.viewBooking(bookingId)!.status, "queued");
    now += 1;
    platform.tick();
    assert.equal(platform.viewBooking(bookingId)!.status, "expired", "an open stream is not the renter");
    s.close();
  });

  it("puts a match that lapsed while the laptop slept back in the queue in its old place", async () => {
    const first = platform.book(730, 30, RENTER).bookingId;
    const s = await stream(`?booking=${first}`);
    const second = platform.book(730, 30, RENTER).bookingId;
    platform.hostConnected("pc-1");
    now += 1_000; // the lid closes: the stream stays open, the page stops beating
    platform.setAvailability("pc-1", true, REPORT);
    await settle();
    assert.deepEqual(statuses(s), ["queued", "matched"]);

    now += RESERVATION_MS;
    platform.tick();
    const again = platform.viewBooking(first)!;
    assert.equal(again.status, "matched", "back in the queue, still first, so matched again");
    assert.equal(again.claimBy, now + RESERVATION_MS);
    assert.equal(platform.viewBooking(second)!.status, "queued");
    s.close();
  });

  it("answers the heartbeat with 204, and 404 for an unknown booking", async () => {
    const { bookingId } = platform.book(730, 30, RENTER);
    assert.equal(await seen(bookingId), 204);
    assert.equal(await seen("nope"), 404);
  });

  it("refuses a signed-out caller with 401, and somebody else's booking reads as not found", async () => {
    const { bookingId } = platform.book(730, 30, RENTER);
    assert.equal((await stream(`?booking=${bookingId}`, {}, null)).status, 401);
    assert.equal(await seen(bookingId, null), 401);
    assert.equal((await stream(`?booking=${bookingId}`, {}, signedIn(OTHER))).status, 404);
    assert.equal(await seen(bookingId, signedIn(OTHER)), 404);
  });

  it("answers 404 for an unknown booking and 400 without one", async () => {
    assert.equal((await stream("?booking=nope")).status, 404);
    assert.equal((await stream("")).status, 400);
  });

  it("refuses more than MAX_STREAMS_PER_BOOKING streams on one booking with 429", async () => {
    const { bookingId } = platform.book(730, 30, RENTER);
    const open: Stream[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_BOOKING; i++) open.push(await stream(`?booking=${bookingId}`));
    assert.deepEqual(
      open.map((s) => s.status),
      Array(MAX_STREAMS_PER_BOOKING).fill(200),
    );
    assert.equal((await stream(`?booking=${bookingId}`)).status, 429);

    open[0]!.close();
    await settle();
    const another = await stream(`?booking=${bookingId}`);
    assert.equal(another.status, 200, "a closed stream frees its place");
    for (const s of [...open, another]) s.close();
  });

  it("answers somebody else's booking with 404 even while its own streams are full", async () => {
    const { bookingId } = platform.book(730, 30, RENTER);
    const open: Stream[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_BOOKING; i++) open.push(await stream(`?booking=${bookingId}`));
    // 429 here would tell a stranger the booking exists and is being watched.
    assert.equal((await stream(`?booking=${bookingId}`, {}, signedIn(OTHER))).status, 404);
    for (const s of open) s.close();
  });

  it("ends the stream once the booking needs no more watching", async () => {
    platform.setAvailability("pc-1", true, REPORT);
    const { bookingId } = platform.book(730, 30, RENTER);
    const s = await stream(`?booking=${bookingId}`);
    assert.deepEqual(statuses(s), ["matched"]);
    assert.equal(s.ended, false);

    platform.claim(bookingId, RENTER);
    await settle();
    assert.deepEqual(statuses(s), ["matched", "claimed"]);
    assert.equal(s.ended, true);

    const late = await stream(`?booking=${bookingId}`);
    assert.deepEqual(statuses(late), ["claimed"], "a finished booking is sent once");
    assert.equal(late.ended, true);
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

  it("drops a stream whose renter does not read", () => {
    const { bookingId } = platform.book(730, 30, RENTER);
    const events = createRenterEvents(platform, { keepAliveMs: 60_000 });
    const res = fakeResponse(false); // its send buffer is already full
    assert.equal(events.open(res as unknown as ServerResponse, bookingId, RENTER, Infinity), "opened");
    assert.equal(res.destroyed, true);
  });

  it("writes nothing more to a stream it ended before the stream has closed", () => {
    platform.setAvailability("pc-1", true, REPORT);
    const { bookingId } = platform.book(730, 30, RENTER);
    platform.claim(bookingId, RENTER);
    const events = createRenterEvents(platform, { keepAliveMs: 60_000 });
    const res = fakeResponse(); // ended, but its close event has not come yet
    assert.equal(events.open(res as unknown as ServerResponse, bookingId, RENTER, Infinity), "opened");
    assert.equal(res.writableEnded, true);
    events.bookingChanged(bookingId);
    assert.equal(res.writesAfterEnd, 0);
  });

  it("ends the stream when the renter's session runs out, on the next change or keep-alive", async () => {
    const { bookingId } = platform.book(730, 30, RENTER);
    let clock = 1_000;
    const events = createRenterEvents(platform, { keepAliveMs: 5, now: () => clock });
    const res = fakeResponse();
    assert.equal(events.open(res as unknown as ServerResponse, bookingId, RENTER, 2_000), "opened");
    events.bookingChanged(bookingId);
    assert.equal(res.writableEnded, false, "still signed in");

    clock = 2_000;
    events.bookingChanged(bookingId);
    assert.equal(res.writableEnded, true, "a change after the session ran out ends the stream");
    assert.equal(res.writesAfterEnd, 0);

    const idle = fakeResponse();
    assert.equal(events.open(idle as unknown as ServerResponse, bookingId, RENTER, 3_000), "opened");
    clock = 3_000;
    await settle();
    assert.equal(idle.writableEnded, true, "the keep-alive ends it with no change at all");
    assert.equal(idle.writesAfterEnd, 0);
    res.destroy();
    idle.destroy();
  });

  it("holds a renter to the per-renter cap however the client address header is rotated, and leaves other renters alone", async () => {
    const bookings = [1, 2, 3].map(() => platform.book(730, 30, RENTER).bookingId);
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
    const theirs = platform.book(730, 30, OTHER).bookingId;
    const other = await stream(`?booking=${theirs}`, rotated(), signedIn(OTHER));
    assert.equal(other.status, 200, "another renter is not held to the first one's count");
    for (const s of [...open, other]) s.close();
  });

  it("refuses any stream beyond the server-wide cap until one closes", () => {
    const events: RenterEvents = createRenterEvents(platform, { maxStreams: 2, keepAliveMs: 60_000 });
    const renters = ["76561198000000011", "76561198000000012", "76561198000000013"];
    const [a, b, c] = renters.map((renter) => ({
      renter,
      bookingId: platform.book(730, 30, renter).bookingId,
    }));
    const first = fakeResponse();
    const open = ({ renter, bookingId }: { renter: string; bookingId: string }, res = fakeResponse()) =>
      events.open(res as unknown as ServerResponse, bookingId, renter, Infinity);
    assert.equal(open(a!, first), "opened");
    assert.equal(open(b!), "opened");
    assert.equal(open(c!), "too-many", "a third renter, a third booking: the server is full");

    first.destroy();
    assert.equal(open(c!), "opened");
  });
});
