// The renter's event stream, Server-Sent Events. Two kinds, one endpoint:
// GET /api/events?booking=<id> follows one booking, and GET /api/events with
// no booking tells the signed-in renter's wall that what can be played where
// has changed.
//
//   renter page                         this server
//   -----------                         -----------
//       |  GET /api/events?booking=…        |
//       |---------------------------------->|  counts as the renter's contact
//       |  event: booking  {status: queued} |
//       |<----------------------------------|
//       |  : keep-alive   (every 25 s)      |
//       |<----------------------------------|
//       |  POST /api/bookings/:id/seen      |
//       |---------------------------------->|  the page's heartbeat, every 15 s
//       |  event: booking  {status: matched, claimBy, machine}
//       |<----------------------------------|  pushed the moment it matches
//
//       |  GET /api/events                  |
//       |---------------------------------->|
//       |  event: availability  {}          |
//       |<----------------------------------|  a machine was offered, taken back,
//       |  GET /api/availability?appids=…   |  went busy, came free or went offline
//       |---------------------------------->|
//
// An open stream is not presence by itself: a sleeping laptop's stream can
// stay open, through Cloudflare, long after its page stopped running. The
// renter is there only while the page speaks: the open, then its heartbeat.
//
// One-way plain HTTP, so it passes Cloudflare as it is, and the browser's
// EventSource reconnects by itself. Each booking event carries the whole
// booking as GET /api/bookings/:id answers it; `claimBy` is the claim
// countdown. An availability event carries nothing: what changed differs per
// renter (their own PC, how far away each machine is), so working it out for
// every open stream on every change would cost what the signed-in-only reads
// were made to avoid. The page asks again, within its own budget of those reads.
//
// Only the signed-in renter who made the booking can open a stream on it, as
// with the rest of the Booking API, and only a signed-in renter can hear about
// availability. So that streams cannot hold the server's resources open, a
// booking takes at most MAX_STREAMS_PER_BOOKING streams, one signed-in renter
// at most `maxStreamsPerRenter` of either kind and the server at most
// `maxStreams` in all; a booking stream ends once the booking needs no more
// watching, and a stream whose renter does not read what it is sent is
// dropped. The per-renter cap is keyed on the signed-in renter, not on an
// address a request can claim in a header, so no renter can hold more than
// their share.

import type { ServerResponse } from "node:http";
import type { BookingStatus, BookingView, Platform } from "./platform.js";

/** Cloudflare closes a response idle for 100 s; a comment line well inside that keeps it open. */
export const KEEP_ALIVE_MS = 25_000;
/** A few tabs on one booking are fine; more than this are refused. */
export const MAX_STREAMS_PER_BOOKING = 3;
/** Open streams the whole server holds at most, by default (MAX_EVENT_STREAMS). */
export const MAX_STREAMS = 500;
/** Open streams one signed-in renter holds at most, by default (MAX_EVENT_STREAMS_PER_RENTER). */
export const MAX_STREAMS_PER_RENTER = 10;
/** Past these the renter has nothing left to wait for, so the stream ends (web/src/swiff/booking.ts stops at the same). */
const DONE: readonly BookingStatus[] = ["claimed", "playing", "ended", "expired"];

/**
 * What open() did: answered with a stream, or answered nothing because the
 * booking is unknown, or it, the renter or the server has its fill of streams,
 * or the renter hung up while the booking was being read.
 */
export type OpenResult = "opened" | "not-found" | "too-many" | "gone";

export type RenterEvents = {
  /**
   * Answer GET /api/events for `bookingId` with a stream for the signed-in
   * `renterId`, unless the booking is unknown or not theirs, or a stream cap
   * is reached. The stream ends at `signedInUntil` (Unix ms), when the
   * renter's session does.
   */
  open(res: ServerResponse, bookingId: string, renterId: string, signedInUntil: number): Promise<OpenResult>;
  /**
   * Answer GET /api/events with no booking: a stream of availability events
   * for the signed-in `renterId`, unless a stream cap is reached. It ends at
   * `signedInUntil` (Unix ms), as a booking stream does.
   */
  openAvailability(
    res: ServerResponse,
    renterId: string,
    signedInUntil: number,
  ): Extract<OpenResult, "opened" | "too-many">;
  /**
   * Send the booking as it now stands to every stream open on it. The platform
   * calls this on each change; it resolves once the booking has been read and
   * sent, and never rejects: a failed read is logged.
   */
  bookingChanged(bookingId: string): Promise<void>;
  /** Tell every availability stream that what is on offer changed. The platform calls this on each change. */
  availabilityChanged(): void;
};

/** One booking event, in the event-stream format. */
const bookingEvent = (booking: BookingView) => `event: booking\ndata: ${JSON.stringify(booking)}\n\n`;

/** One availability event: nothing but that something changed. */
const AVAILABILITY_EVENT = "event: availability\ndata: {}\n\n";

/**
 * Write to the stream, or drop it when its buffer is full: a renter that does
 * not read is not kept in memory. EventSource reconnects one that was only slow.
 * A stream already ended is left alone until it closes: writing to it would
 * raise an error event nothing handles.
 */
function write(res: ServerResponse, chunk: string): void {
  if (res.destroyed || res.writableEnded) return;
  if (!res.write(chunk)) res.destroy();
}

/** The last event each stream was sent. */
const lastSent = new WeakMap<ServerResponse, string>();

/**
 * Send the booking, and end the stream once the booking needs no more watching.
 * A booking as it was last sent is not sent again: a change read after the
 * stream opened can be the state it opened with.
 */
function sendBooking(res: ServerResponse, booking: BookingView): void {
  const event = bookingEvent(booking);
  if (lastSent.get(res) === event) return;
  lastSent.set(res, event);
  write(res, event);
  if (DONE.includes(booking.status) && !res.destroyed) res.end();
}

/** The renter event streams over `platform`, holding each open one until its renter goes. */
export function createRenterEvents(
  platform: Platform,
  {
    keepAliveMs = KEEP_ALIVE_MS,
    maxStreams = MAX_STREAMS,
    maxStreamsPerRenter = MAX_STREAMS_PER_RENTER,
    now = Date.now,
  }: {
    keepAliveMs?: number | undefined;
    maxStreams?: number | undefined;
    maxStreamsPerRenter?: number | undefined;
    /** The clock sessions expire by. */
    now?: () => number;
  } = {},
): RenterEvents {
  const streams = new Map<string, Set<ServerResponse>>();
  /** When each open stream's renter session ends, in Unix ms. */
  const signedInUntil = new WeakMap<ServerResponse, number>();
  /** End the stream if its renter's session is over; true when it did. */
  const signedOut = (res: ServerResponse): boolean => {
    if (now() < (signedInUntil.get(res) ?? Infinity)) return false;
    if (!res.destroyed && !res.writableEnded) res.end();
    return true;
  };
  /** Open streams per signed-in renter, and in all. */
  const perRenter = new Map<string, number>();
  let total = 0;

  /** Streams open for availability, with no booking. */
  const watching = new Set<ServerResponse>();

  /** Whether `renterId` or the server has its fill of streams. */
  const full = (renterId: string) =>
    (perRenter.get(renterId) ?? 0) >= maxStreamsPerRenter || total >= maxStreams;

  /**
   * Answer with an event stream, counted against `renterId` and the server
   * until it closes, and ended once the session is over. `set` holds it while
   * it is open; `forget` runs once it closes, after it has left `set`.
   */
  function hold(
    res: ServerResponse,
    renterId: string,
    until: number,
    set: Set<ServerResponse>,
    forget = () => {},
  ) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      // Tells nginx-style proxies not to hold events back in a buffer.
      "x-accel-buffering": "no",
    });

    set.add(res);
    signedInUntil.set(res, until);
    perRenter.set(renterId, (perRenter.get(renterId) ?? 0) + 1);
    total += 1;
    // Each keep-alive also checks the session: one that has run out ends the stream.
    const keepAlive = setInterval(() => signedOut(res) || write(res, ": keep-alive\n\n"), keepAliveMs);
    keepAlive.unref();

    res.once("close", () => {
      clearInterval(keepAlive);
      set.delete(res);
      total -= 1;
      const left = (perRenter.get(renterId) ?? 1) - 1;
      if (left > 0) perRenter.set(renterId, left);
      else perRenter.delete(renterId);
      forget();
    });
  }

  return {
    async open(res, bookingId, renterId, until) {
      // An unknown booking, or somebody else's, reads as not found before any
      // stream count is checked: a 429 would tell that it exists and is watched.
      const booking = await platform.booking(bookingId, renterId);
      if (!booking) return "not-found";
      // Its close has been and gone: a stream held for it would never be let go.
      if (res.destroyed) return "gone";
      if ((streams.get(bookingId)?.size ?? 0) >= MAX_STREAMS_PER_BOOKING || full(renterId)) return "too-many";

      let open = streams.get(bookingId);
      if (!open) streams.set(bookingId, (open = new Set()));
      const mine = open;
      hold(res, renterId, until, mine, () => {
        if (!mine.size && streams.get(bookingId) === mine) streams.delete(bookingId);
      });
      sendBooking(res, booking);
      return "opened";
    },

    openAvailability(res, renterId, until) {
      if (full(renterId)) return "too-many";
      hold(res, renterId, until, watching);
      return "opened";
    },

    async bookingChanged(bookingId) {
      if (!streams.get(bookingId)?.size) return;
      let booking: BookingView | null;
      try {
        booking = await platform.viewBooking(bookingId);
      } catch (error) {
        // The change is committed; its streams hear of the next one.
        console.error("[swiff] booking event failed:", error instanceof Error ? error.name : typeof error);
        return;
      }
      // Read now, the streams open now: one may have opened while it was read.
      const open = streams.get(bookingId);
      if (!booking || !open) return;
      for (const res of [...open]) if (!signedOut(res)) sendBooking(res, booking);
    },

    availabilityChanged() {
      for (const res of [...watching]) if (!signedOut(res)) write(res, AVAILABILITY_EVENT);
    },
  };
}
