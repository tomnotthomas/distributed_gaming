// The renter's event stream: GET /api/events?booking=<id>, Server-Sent Events.
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
// An open stream is not presence by itself: a sleeping laptop's stream can
// stay open, through Cloudflare, long after its page stopped running. The
// renter is there only while the page speaks: the open, then its heartbeat.
//
// One-way plain HTTP, so it passes Cloudflare as it is, and the browser's
// EventSource reconnects by itself. Each event carries the whole booking as
// GET /api/bookings/:id answers it; `claimBy` is the claim countdown.
//
// Only the signed-in renter who made the booking can open a stream on it, as
// with the rest of the Booking API. So that streams cannot hold the server's
// resources open, a booking takes at most MAX_STREAMS_PER_BOOKING streams, one
// client address at most `maxStreamsPerClient` and the server at most
// `maxStreams` in all; a stream ends once the booking needs no more watching,
// and a stream whose renter does not read what it is sent is dropped.

import type { ServerResponse } from "node:http";
import type { BookingStatus, BookingView, Platform } from "./platform.js";

/** Cloudflare closes a response idle for 100 s; a comment line well inside that keeps it open. */
export const KEEP_ALIVE_MS = 25_000;
/** A few tabs on one booking are fine; more than this are refused. */
export const MAX_STREAMS_PER_BOOKING = 3;
/** Open streams the whole server holds at most, by default (MAX_EVENT_STREAMS). */
export const MAX_STREAMS = 500;
/** Open streams one client address holds at most, by default (MAX_EVENT_STREAMS_PER_CLIENT). */
export const MAX_STREAMS_PER_CLIENT = 10;
/** Past these the renter has nothing left to wait for, so the stream ends (web/src/swiff/booking.ts stops at the same). */
const DONE: readonly BookingStatus[] = ["claimed", "playing", "ended", "expired"];

/**
 * What open() did: answered with a stream, or answered nothing because the
 * booking is unknown, or it, the client or the server has its fill of streams.
 */
export type OpenResult = "opened" | "not-found" | "too-many";

export type RenterEvents = {
  /**
   * Answer GET /api/events for `bookingId` with a stream for the signed-in
   * `renterId`, from `client` (its address), unless the booking is unknown or
   * not theirs, or a stream cap is reached.
   */
  open(res: ServerResponse, bookingId: string, renterId: string, client: string): OpenResult;
  /** Send the booking as it now stands to every stream open on it. The platform calls this on each change. */
  bookingChanged(bookingId: string): void;
};

/** One booking event, in the event-stream format. */
const bookingEvent = (booking: BookingView) => `event: booking\ndata: ${JSON.stringify(booking)}\n\n`;

/**
 * Write to the stream, or drop it when its buffer is full: a renter that does
 * not read is not kept in memory. EventSource reconnects one that was only slow.
 */
function write(res: ServerResponse, chunk: string): void {
  if (!res.destroyed && !res.write(chunk)) res.destroy();
}

/** Send the booking, and end the stream once the booking needs no more watching. */
function sendBooking(res: ServerResponse, booking: BookingView): void {
  write(res, bookingEvent(booking));
  if (DONE.includes(booking.status) && !res.destroyed) res.end();
}

/** The renter event streams over `platform`, holding each open one until its renter goes. */
export function createRenterEvents(
  platform: Platform,
  {
    keepAliveMs = KEEP_ALIVE_MS,
    maxStreams = MAX_STREAMS,
    maxStreamsPerClient = MAX_STREAMS_PER_CLIENT,
  }: {
    keepAliveMs?: number | undefined;
    maxStreams?: number | undefined;
    maxStreamsPerClient?: number | undefined;
  } = {},
): RenterEvents {
  const streams = new Map<string, Set<ServerResponse>>();
  /** Open streams per client address, and in all. */
  const perClient = new Map<string, number>();
  let total = 0;

  return {
    open(res, bookingId, renterId, client) {
      if (
        (streams.get(bookingId)?.size ?? 0) >= MAX_STREAMS_PER_BOOKING ||
        (perClient.get(client) ?? 0) >= maxStreamsPerClient ||
        total >= maxStreams
      ) {
        return "too-many";
      }
      // Somebody else's booking reads as not found.
      const booking = platform.booking(bookingId, renterId);
      if (!booking) return "not-found";

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        // Tells nginx-style proxies not to hold events back in a buffer.
        "x-accel-buffering": "no",
      });

      let open = streams.get(bookingId);
      if (!open) streams.set(bookingId, (open = new Set()));
      open.add(res);
      perClient.set(client, (perClient.get(client) ?? 0) + 1);
      total += 1;
      const keepAlive = setInterval(() => write(res, ": keep-alive\n\n"), keepAliveMs);
      keepAlive.unref();

      res.once("close", () => {
        clearInterval(keepAlive);
        open.delete(res);
        total -= 1;
        const left = (perClient.get(client) ?? 1) - 1;
        if (left > 0) perClient.set(client, left);
        else perClient.delete(client);
        if (!open.size && streams.get(bookingId) === open) streams.delete(bookingId);
      });
      sendBooking(res, booking);
      return "opened";
    },

    bookingChanged(bookingId) {
      const open = streams.get(bookingId);
      if (!open?.size) return;
      const booking = platform.viewBooking(bookingId);
      if (!booking) return;
      for (const res of [...open]) sendBooking(res, booking);
    },
  };
}
