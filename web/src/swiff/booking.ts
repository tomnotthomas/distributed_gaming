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
//
// The page claims by itself (followBooking): a machine the renter picked is
// claimed the moment it is booked (202, matched), with no click; a queued
// booking is claimed the moment the stream pushes its match, with a chime when
// the tab is out of sight. Only the open stream claims: a renter whose stream
// is closed is away, and nothing is claimed until they come back and it opens
// again, within the server's two minutes. The slow poll that stands in while
// the stream is down keeps the booking, but never claims it.

import { chime as defaultChime } from "./chime";

export type BookingStatus = "queued" | "matched" | "claimed" | "playing" | "ended" | "expired";

export type Booking = {
  bookingId: string;
  status: BookingStatus;
  gameId: number;
  minutes: number;
  machine?: { id: string; gpu: string | null; cpu: string | null; price: number };
  claimBy?: number;
  sessionId?: string;
  /** Cents charged for the time played, once the session has ended. */
  price?: number;
};

/**
 * The renter's round trips in ms: to the server, and straight to any machine
 * probed, by id. The server matches the booking by them.
 */
export type Rtts = { server?: number; machines?: Record<string, number> };

/** The machine the server offers instead of one that was taken: the next on the renter's list. */
export type NextBest = {
  id: string;
  name: string | null;
  gpu: string;
  /** Cents per hour. */
  price: number;
  latency: { rttMs: number };
};

/** A picked machine booked (matched, to claim), or taken already, with what to offer instead. */
export type BookMachineResult =
  { kind: "booked"; booking: Booking } | { kind: "taken"; nextBest: NextBest | null };

/** What a claim hands back: the room to join, where, and the ticket that opens it. */
export type Claim = { sessionId: string; roomId: string; signalingUrl: string; ticket: string };

/** Where a booking update came from: the open stream, or the poll while it is down. */
export type UpdateSource = "stream" | "poll";

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

/** The browser's EventSource as it is now, or null where there is none (and the helper polls only). */
const browserEventSource = () =>
  typeof EventSource === "undefined" ? null : (url: string): EventStream => new EventSource(url);

/** POST `body` as JSON to `path`. */
const post = (get: typeof fetch, path: string, body?: unknown) =>
  get(path, {
    method: "POST",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

/**
 * Queue for a game: the server matches the booking to the best machine free
 * for it, judged by the renter's round trips. Remembers the booking, so a
 * reload can resume it.
 */
export async function book(
  gameId: number,
  minutes: number,
  options: BookingOptions & { rtts?: Rtts } = {},
): Promise<Booking> {
  const { storage = localStorage, fetch: get = fetch, rtts } = options;
  const response = await post(get, "/api/bookings", { gameId, minutes, ...(rtts ? { rtts } : {}) });
  if (!response.ok) throw new Error(`booking failed: ${response.status}`);
  const booking = (await response.json()) as Booking;
  storage.setItem(KEY, booking.bookingId);
  return booking;
}

/**
 * Book the machine the renter picked: reserved for them at once (202,
 * matched), and remembered as book() does, or taken since their list was read
 * (409), with the next best to offer instead.
 */
export async function bookMachine(
  machineId: string,
  gameId: number,
  minutes: number,
  options: BookingOptions & { rtts?: Rtts } = {},
): Promise<BookMachineResult> {
  const { storage = localStorage, fetch: get = fetch, rtts } = options;
  const response = await post(get, "/api/bookings", {
    gameId,
    minutes,
    machineId,
    ...(rtts ? { rtts } : {}),
  });
  if (response.status === 409) {
    const { nextBest = null } = (await response.json()) as { nextBest?: NextBest | null };
    return { kind: "taken", nextBest };
  }
  if (!response.ok) throw new Error(`booking failed: ${response.status}`);
  const booking = (await response.json()) as Booking;
  storage.setItem(KEY, booking.bookingId);
  return { kind: "booked", booking };
}

/**
 * Claim the matched machine: the room and its join ticket, or null when the
 * booking cannot be claimed (409: its reservation lapsed, or it is over).
 */
export async function claim(bookingId: string, options: BookingOptions = {}): Promise<Claim | null> {
  const { fetch: get = fetch } = options;
  const response = await post(get, `/api/bookings/${encodeURIComponent(bookingId)}/claim`);
  if (response.status === 409) return null;
  if (!response.ok) throw new Error(`claim failed: ${response.status}`);
  return (await response.json()) as Claim;
}

/**
 * End the booking, whatever it has come to: out of the queue, its machine
 * handed back, or its session over. The booking as it ended, or null when it
 * was over already or is not the renter's. Forgets it either way.
 */
export async function endBooking(bookingId: string, options: BookingOptions = {}): Promise<Booking | null> {
  const { storage = localStorage, fetch: get = fetch } = options;
  const response = await post(get, `/api/bookings/${encodeURIComponent(bookingId)}/end`);
  if (storage.getItem(KEY) === bookingId) storage.removeItem(KEY);
  if (response.status === 409 || response.status === 404) return null;
  if (!response.ok) throw new Error(`ending failed: ${response.status}`);
  return (await response.json()) as Booking;
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
  onUpdate: (booking: Booking | null, source: UpdateSource) => void,
  options: BookingOptions = {},
): () => void {
  const {
    storage = localStorage,
    fetch: get = fetch,
    intervalMs = SLOW_POLL_MS,
    heartbeatMs = HEARTBEAT_MS,
    eventSource = browserEventSource(),
  } = options;
  let stopped = false;
  let polling = false;
  /** Bumped whenever the poll starts or stops, so a check still in flight from an older run ends there. */
  let run = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let stream: EventStream | null = null;

  /**
   * Tell the server the renter is still here; a failed beat waits for the next.
   * Refused as signed out or not theirs, the booking is gone from view, as the
   * poll treats it.
   */
  const beat = async () => {
    let response: Response;
    try {
      response = await get(`/api/bookings/${encodeURIComponent(bookingId)}/seen`, { method: "POST" });
    } catch {
      // A blip on the network: the next beat tries again.
      return;
    }
    if (response.status === 404 || response.status === 401) settle(null, "stream");
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
  const settle = (booking: Booking | null, source: UpdateSource) => {
    if (stopped) return;
    const done = !booking || DONE.includes(booking.status);
    if (done && storage.getItem(KEY) === bookingId) storage.removeItem(KEY);
    onUpdate(booking, source);
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
    settle(booking, "poll");
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
    settle(JSON.parse((event as MessageEvent<string>).data) as Booking, "stream");
  });
  // Reconnected: the stream sends the booking again and carries on.
  stream.addEventListener("open", stopPolling);
  // Dropped: EventSource retries by itself, and the poll covers the gap. One
  // the server refused (CLOSED) is never retried, so the poll carries on alone.
  stream.addEventListener("error", startPolling);
  return stop;
}

/** The booking this browser made and kept, if any, for a page load to pick up. */
export function storedBookingId(storage: Storage = localStorage): string | null {
  return storage.getItem(KEY);
}

/** On page load: resume watching the booking this browser made, if it kept one. Null when there is none. */
export function resumeBooking(
  onUpdate: (booking: Booking | null, source: UpdateSource) => void,
  options: BookingOptions = {},
): (() => void) | null {
  const bookingId = storedBookingId(options.storage);
  return bookingId ? watchBooking(bookingId, onUpdate, options) : null;
}

/** What following a booking reports. */
export type FollowHandlers = {
  /** Each state the booking reaches; null once it is gone from view. */
  onUpdate: (booking: Booking | null) => void;
  /** The machine was claimed: the room to join and its ticket. */
  onClaimed: (claim: Claim, booking: Booking) => void;
  /** A claim the server failed to answer; the booking is still followed. */
  onClaimFailed?: () => void;
};

export type FollowOptions = BookingOptions & {
  /** Played when a match arrives while the tab is out of sight. */
  chime?: () => void;
  /** Whether the tab is out of sight. */
  hidden?: () => boolean;
};

const tabHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * Follow the booking and claim its machine by itself: at once when `first` is
 * a booking already matched (a picked machine, just booked), and otherwise the
 * moment the open stream pushes the match, chiming first when the tab is out
 * of sight. Each reservation is claimed once; one that cannot be claimed any
 * more (409) is left, and following goes on. Nothing is claimed off the slow
 * poll: with the stream closed the renter counts as away. Once claimed, the
 * booking is forgotten and following stops. Returns stop().
 */
export function followBooking(
  first: Booking | string,
  handlers: FollowHandlers,
  options: FollowOptions = {},
): () => void {
  const { chime = defaultChime, hidden = tabHidden, storage = localStorage } = options;
  const bookingId = typeof first === "string" ? first : first.bookingId;
  let stopped = false;
  /** The reservation (by its claim deadline) claimed or being claimed. */
  let claiming: number | undefined;

  const tryClaim = async (booking: Booking) => {
    if (claiming === booking.claimBy) return;
    claiming = booking.claimBy;
    let claimed: Claim | null;
    try {
      claimed = await claim(bookingId, options);
    } catch {
      claiming = undefined;
      if (!stopped) handlers.onClaimFailed?.();
      return;
    }
    if (stopped || !claimed) return;
    stop();
    if (storage.getItem(KEY) === bookingId) storage.removeItem(KEY);
    handlers.onClaimed(claimed, { ...booking, status: "claimed", sessionId: claimed.sessionId });
  };

  const unwatch = watchBooking(
    bookingId,
    (booking, source) => {
      if (stopped) return;
      handlers.onUpdate(booking);
      if (booking?.status !== "matched" || source !== "stream" || claiming === booking.claimBy) return;
      if (hidden()) chime();
      void tryClaim(booking);
    },
    options,
  );
  const stop = () => {
    stopped = true;
    unwatch();
  };
  if (typeof first !== "string" && first.status === "matched") void tryClaim(first);
  return stop;
}
