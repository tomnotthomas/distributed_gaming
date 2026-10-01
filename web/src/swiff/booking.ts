// The renter's booking, kept across a closed tab or a sleeping laptop. The
// server drops a queued booking nobody has checked on for two minutes
// (server/src/platform.ts). Watching is the event stream GET /api/events,
// which the server pushes every change down; while it is open the page says it
// is still there with POST /api/bookings/:id/seen every 15 s, since a stream
// left open by a sleeping laptop is no sign of the renter. While the stream is
// down the page checks on the booking with a slow poll instead, and each check
// counts the same. The booking id is kept in localStorage so a renter who comes
// back within those two minutes picks up the same place in the queue instead
// of booking again.
//
// Every call needs the renter signed in: the session cookie goes with each
// same-origin fetch and with the event stream, and a booking is only ever shown
// to the renter who made it.

export type BookingStatus = "queued" | "matched" | "claimed" | "playing" | "ended" | "expired";

export type Booking = {
  bookingId: string;
  status: BookingStatus;
  gameId: number;
  minutes: number;
  machine?: { id: string; gpu: string | null; cpu: string | null; price: number };
  claimBy?: number;
};

const KEY = "swiff.booking";
/** The fallback poll while the stream is down: well inside the two minutes, slower than a stream. */
const SLOW_POLL_MS = 5_000;
/** The heartbeat while the stream is open: well inside the two minutes. */
const HEARTBEAT_MS = 15_000;
/** Past these the browser has nothing left to wait for. */
const DONE: readonly BookingStatus[] = ["claimed", "playing", "ended", "expired"];

/** The part of EventSource this file uses, so tests can stand in for it. */
type EventStream = Pick<EventSource, "addEventListener" | "close">;

export type BookingOptions = {
  storage?: Storage;
  fetch?: typeof fetch;
  /** The fallback poll's interval. */
  intervalMs?: number;
  /** The heartbeat's interval while the stream is open. */
  heartbeatMs?: number;
  /** Opens the event stream; null polls only. Defaults to the browser's EventSource where there is one. */
  eventSource?: ((url: string) => EventStream) | null;
};

/** The browser's EventSource, or null where there is none (and the helper polls only). */
const browserEventSource =
  typeof EventSource === "undefined" ? null : (url: string): EventStream => new EventSource(url);

/** Book a game and remember the booking, so a reload can resume it. */
export async function book(gameId: number, minutes: number, options: BookingOptions = {}): Promise<Booking> {
  const { storage = localStorage, fetch: get = fetch } = options;
  const response = await get("/api/bookings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gameId, minutes }),
  });
  if (!response.ok) throw new Error(`booking failed: ${response.status}`);
  const booking = (await response.json()) as Booking;
  storage.setItem(KEY, booking.bookingId);
  return booking;
}

/**
 * Follow the booking and report each state it reaches: pushed down the event
 * stream while it is open, with a heartbeat every `heartbeatMs`, and polled
 * every `intervalMs` while it is not. Stops, and forgets the stored booking,
 * once it is claimed, over, or gone — including gone from view because the
 * renter is no longer signed in. Returns stop().
 */
export function watchBooking(
  bookingId: string,
  onUpdate: (booking: Booking | null) => void,
  options: BookingOptions = {},
): () => void {
  const {
    storage = localStorage,
    fetch: get = fetch,
    intervalMs = SLOW_POLL_MS,
    heartbeatMs = HEARTBEAT_MS,
    eventSource = browserEventSource,
  } = options;
  let stopped = false;
  let polling = false;
  /** Bumped whenever the poll starts or stops, so a check still in flight from an older run ends there. */
  let run = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let stream: EventStream | null = null;

  /** Tell the server the renter is still here; a failed beat waits for the next. */
  const beat = async () => {
    try {
      await get(`/api/bookings/${encodeURIComponent(bookingId)}/seen`, { method: "POST" });
    } catch {
      // A blip on the network: the next beat tries again.
    }
  };

  const stopHeartbeat = () => {
    clearInterval(heartbeat);
    heartbeat = undefined;
  };

  /** Stop for good: no more polls or heartbeats, the stream closed. */
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    stopHeartbeat();
    stream?.close();
  };

  /** Report one answer; the last one forgets the booking and stops. */
  const settle = (booking: Booking | null) => {
    if (stopped) return;
    const done = !booking || DONE.includes(booking.status);
    if (done && storage.getItem(KEY) === bookingId) storage.removeItem(KEY);
    onUpdate(booking);
    if (done) stop();
  };

  /** Check on the booking once, and again after `intervalMs` while run `current` is on. */
  const poll = async (current: number) => {
    let booking: Booking | null;
    try {
      const response = await get(`/api/bookings/${encodeURIComponent(bookingId)}`);
      if (response.status === 404 || response.status === 401) booking = null;
      else if (!response.ok) throw new Error(String(response.status));
      else booking = (await response.json()) as Booking;
    } catch {
      // A blip on the network: try again on the next beat.
      if (!stopped && current === run) timer = setTimeout(poll, intervalMs, current);
      return;
    }
    if (stopped || current !== run) return;
    settle(booking);
    if (!stopped) timer = setTimeout(poll, intervalMs, current);
  };

  /** The stream is down: poll until it is back, the poll's checks standing in for the heartbeat. */
  const startPolling = () => {
    stopHeartbeat();
    if (polling || stopped) return;
    polling = true;
    void poll(++run);
  };

  /** The stream is up: it carries the booking from here, and the heartbeat says the renter is there. */
  const stopPolling = () => {
    polling = false;
    run += 1;
    clearTimeout(timer);
    if (heartbeat === undefined && !stopped) heartbeat = setInterval(() => void beat(), heartbeatMs);
  };

  if (!eventSource) {
    startPolling();
    return stop;
  }

  stream = eventSource(`/api/events?booking=${encodeURIComponent(bookingId)}`);
  stream.addEventListener("booking", (event) => {
    stopPolling();
    settle(JSON.parse((event as MessageEvent<string>).data) as Booking);
  });
  // Reconnected: the stream sends the booking again and carries on.
  stream.addEventListener("open", stopPolling);
  // Dropped: EventSource retries by itself, and the poll covers the gap. One
  // the server refused (CLOSED) is never retried, so the poll carries on alone.
  stream.addEventListener("error", startPolling);
  return stop;
}

/** On page load: resume watching the booking this browser made, if it kept one. Null when there is none. */
export function resumeBooking(
  onUpdate: (booking: Booking | null) => void,
  options: BookingOptions = {},
): (() => void) | null {
  const bookingId = (options.storage ?? localStorage).getItem(KEY);
  return bookingId ? watchBooking(bookingId, onUpdate, options) : null;
}
