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
// booking is claimed the moment its match arrives, with a chime when the tab is
// out of sight. An open page is the renter being there, so a match is claimed
// whether the stream pushes it or the slow poll that stands in while the stream
// is down finds it. A renter whose page is closed is away, and nothing is
// claimed until they come back: the server holds a machine matched meanwhile
// for up to two minutes from the match, and starts the claim's 60 s when the
// page reopens its stream, so the page claims it then with the time restored.
//
// The server books and claims only games in the renter's Steam library or free
// to play (server/src/licence.ts). It refuses anything else with 403 and a
// code, which reaches the page as a Refusal: BookingRefused from a booking
// call, and onClaimFailed's argument from a claim.
//
// A claimed booking is kept as the one being played, with its session and
// room, until it is ended. Its join ticket is a bearer credential and is never
// stored: a page that comes back to it (a reload, a laptop that died) asks for
// its seat again with POST /api/bookings/:id/rejoin, which hands out the
// claim's ticket id again while the PC holds the session for a renter who
// dropped (two minutes, server/src/grace.ts).

import type { Control, PicturePref } from "@swiff/rank";
import { chime as defaultChime } from "./chime";

export type BookingStatus = "queued" | "matched" | "claimed" | "playing" | "ended" | "expired";

export type Booking = {
  bookingId: string;
  status: BookingStatus;
  gameId: number;
  minutes: number;
  machine?: { id: string; name?: string | null; gpu: string | null; cpu: string | null; price: number };
  claimBy?: number;
  sessionId?: string;
  /** Unix ms the session started, while it runs. */
  startedAt?: number;
  /** Cents charged for the time played, once the session has ended. */
  price?: number;
  /**
   * Unix ms until which the PC holds a running session for a renter who
   * dropped out of it; absent while they are connected, or not yet missed.
   */
  heldUntil?: number;
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

/** Why the server refused a game: not in the renter's Steam library, or their library cannot be read. */
export type Refusal = "not-owned" | "library-unreadable";

const REFUSALS: readonly Refusal[] = ["not-owned", "library-unreadable"];

/** A booking the server refused because the renter may not play the game (403). */
export class BookingRefused extends Error {
  constructor(readonly refusal: Refusal) {
    super(`booking refused: ${refusal}`);
  }
}

/** The Refusal a 403 answer names, or undefined for any other answer. */
async function refusalOf(response: Response): Promise<Refusal | undefined> {
  if (response.status !== 403) return undefined;
  const { code } = (await response
    .clone()
    .json()
    .catch(() => ({}))) as { code?: unknown };
  return REFUSALS.find((r) => r === code);
}

/** Throw for a booking call that failed: BookingRefused when the game is refused. */
async function bookingFailed(response: Response): Promise<never> {
  const refusal = await refusalOf(response);
  throw refusal ? new BookingRefused(refusal) : new Error(`booking failed: ${response.status}`);
}

/** A picked machine booked (matched, to claim), or taken already, with what to offer instead. */
export type BookMachineResult =
  { kind: "booked"; booking: Booking } | { kind: "taken"; nextBest: NextBest | null };

/** What a claim hands back: the room to join, where, and the ticket that opens it. */
export type Claim = { sessionId: string; roomId: string; signalingUrl: string; ticket: string };

const KEY = "swiff.booking";
/** When the page last heard from the server about the stored booking, Unix ms. */
const SEEN_KEY = "swiff.booking.seen";
/** The claimed booking being played, with its session and room (never its ticket), kept to come back to. */
const PLAY_KEY = "swiff.play";
/** How long the server keeps a queued booking whose renter has gone quiet (server/src/platform.ts). */
export const QUEUE_HOLD_MS = 2 * 60_000;
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

/** How the renter asks: their round trips, the controls they turned on and their Picture setting. */
export type BookingAsk = { rtts?: Rtts; controls?: Control[]; picture?: PicturePref };

/** The parts of `ask` the renter gave, for a booking body. */
const askBody = ({ rtts, controls, picture }: BookingAsk) => ({
  ...(rtts ? { rtts } : {}),
  ...(controls ? { controls } : {}),
  ...(picture ? { picture } : {}),
});

/**
 * Queue for a game: the server matches the booking to the best machine free
 * for it, judged by the renter's round trips and ranked by how they play.
 * Remembers the booking, so a reload can resume it.
 */
export async function book(
  gameId: number,
  minutes: number,
  options: BookingOptions & BookingAsk = {},
): Promise<Booking> {
  const { storage = localStorage, fetch: get = fetch } = options;
  const response = await post(get, "/api/bookings", { gameId, minutes, ...askBody(options) });
  if (!response.ok) await bookingFailed(response);
  const booking = (await response.json()) as Booking;
  remember(booking.bookingId, storage);
  return booking;
}

/**
 * Book the machine the renter picked: reserved for them at once (202,
 * matched), and remembered as book() does, or taken since their list was read
 * (409), with the next best to offer instead, ranked by the renter's controls
 * and Picture setting as their list was.
 */
export async function bookMachine(
  machineId: string,
  gameId: number,
  minutes: number,
  options: BookingOptions & BookingAsk = {},
): Promise<BookMachineResult> {
  const { storage = localStorage, fetch: get = fetch } = options;
  const response = await post(get, "/api/bookings", { gameId, minutes, machineId, ...askBody(options) });
  if (response.status === 409) {
    const { nextBest = null } = (await response.json()) as { nextBest?: NextBest | null };
    return { kind: "taken", nextBest };
  }
  if (!response.ok) await bookingFailed(response);
  const booking = (await response.json()) as Booking;
  remember(booking.bookingId, storage);
  return { kind: "booked", booking };
}

/**
 * Claim the matched machine: the room and its join ticket, or null when the
 * server refuses it (4xx: its reservation lapsed, it is over, or it is not the
 * renter's).
 */
export async function claim(bookingId: string, options: BookingOptions = {}): Promise<Claim | null> {
  const answer = await askToClaim(bookingId, options);
  return "claim" in answer ? answer.claim : null;
}

/**
 * Come back to the renter's running session, for a page that no longer holds
 * its ticket (it is never stored): the same room and session, and a ticket for
 * the same seat, valid until the session's deadline. Null when the server
 * refuses it (4xx: the booking has no session running, or it is not the
 * renter's), and then it is forgotten as the one being played.
 */
export async function resumeTicket(bookingId: string, options: BookingOptions = {}): Promise<Claim | null> {
  const { storage = localStorage, fetch: get = fetch } = options;
  const response = await post(get, `/api/bookings/${encodeURIComponent(bookingId)}/rejoin`);
  if (response.status >= 400 && response.status < 500) {
    forgetPlay(bookingId, storage);
    return null;
  }
  if (!response.ok) throw new Error(`rejoining failed: ${response.status}`);
  return (await response.json()) as Claim;
}

/**
 * The booking as it stands, read once, with until when the PC holds its
 * session for a renter who dropped. Null when it is gone from view (over long
 * ago, not the renter's, or signed out).
 */
export async function fetchBooking(bookingId: string, options: BookingOptions = {}): Promise<Booking | null> {
  const { fetch: get = fetch } = options;
  const response = await get(`/api/bookings/${encodeURIComponent(bookingId)}`);
  if (response.status === 404 || response.status === 401) return null;
  if (!response.ok) throw new Error(`reading the booking failed: ${response.status}`);
  return (await response.json()) as Booking;
}

/** Keep `bookingId` as the booking to pick up on a reload, heard from now. */
function remember(bookingId: string, storage: Storage) {
  storage.setItem(KEY, bookingId);
  storage.setItem(SEEN_KEY, String(Date.now()));
}

/** Forget the stored booking, if it is `bookingId`. */
function forgetBooking(bookingId: string, storage: Storage) {
  if (storage.getItem(KEY) !== bookingId) return;
  storage.removeItem(KEY);
  storage.removeItem(SEEN_KEY);
}

/**
 * A claim's answer: the room and ticket, or the status the server gave when it
 * refused (4xx), with the Refusal when it refused the game.
 */
type ClaimAnswer = { claim: Claim } | { refused: BookingStatus | undefined; refusal?: Refusal };

async function askToClaim(bookingId: string, options: BookingOptions): Promise<ClaimAnswer> {
  const { fetch: get = fetch } = options;
  const response = await post(get, `/api/bookings/${encodeURIComponent(bookingId)}/claim`);
  if (response.status >= 400 && response.status < 500) {
    const refusal = await refusalOf(response);
    if (refusal) return { refused: undefined, refusal };
    const { status } = (await response.json().catch(() => ({}))) as { status?: BookingStatus };
    return { refused: status };
  }
  if (!response.ok) throw new Error(`claim failed: ${response.status}`);
  return { claim: (await response.json()) as Claim };
}

/**
 * End the booking, whatever it has come to: out of the queue, its machine
 * handed back, or its session over. The booking as it ended, or null when it
 * was over already or is not the renter's. Forgets it either way.
 */
export async function endBooking(bookingId: string, options: BookingOptions = {}): Promise<Booking | null> {
  const { storage = localStorage, fetch: get = fetch } = options;
  forgetBooking(bookingId, storage);
  forgetPlay(bookingId, storage);
  const response = await post(get, `/api/bookings/${encodeURIComponent(bookingId)}/end`);
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
  onUpdate: (booking: Booking | null) => void,
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
    if (response.status === 404 || response.status === 401) settle(null);
    else if (response.ok) heard();
  };

  /** The server answered about the booking: a reload now finds it heard from now. */
  const heard = () => {
    if (!stopped && storage.getItem(KEY) === bookingId) storage.setItem(SEEN_KEY, String(Date.now()));
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
    if (done) forgetBooking(bookingId, storage);
    else heard();
    if (!booking || booking.status === "ended" || booking.status === "expired")
      forgetPlay(bookingId, storage);
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

/** A claimed booking being played: the booking, and the session and room its claim handed out. */
export type StoredPlay = { bookingId: string; sessionId: string; roomId: string };

/** The claimed booking this browser is playing, kept to come back to; null when there is none. */
export function storedPlay(storage: Storage = localStorage): StoredPlay | null {
  try {
    const play = JSON.parse(storage.getItem(PLAY_KEY) ?? "null") as StoredPlay | null;
    return typeof play?.bookingId === "string" &&
      typeof play.sessionId === "string" &&
      typeof play.roomId === "string"
      ? { bookingId: play.bookingId, sessionId: play.sessionId, roomId: play.roomId }
      : null;
  } catch {
    return null;
  }
}

/**
 * On page load: drop a kept play from before tickets stopped being stored, so
 * no join ticket stays on disk. Its booking is still followed by its id.
 */
export function forgetStoredTicket(storage: Storage = localStorage): void {
  try {
    const raw = storage.getItem(PLAY_KEY);
    if (raw !== null && /"ticket"\s*:/.test(raw)) storage.removeItem(PLAY_KEY);
  } catch {
    // Storage switched off holds nothing to forget.
  }
}

/** Forget `bookingId` as the booking being played: it ended, expired or is gone. */
export function forgetPlay(bookingId: string, storage: Storage = localStorage) {
  if (storedPlay(storage)?.bookingId === bookingId) storage.removeItem(PLAY_KEY);
}

/** The booking this browser made and kept, if any, for a page load to pick up. */
export function storedBookingId(storage: Storage = localStorage): string | null {
  return storage.getItem(KEY);
}

/**
 * How long the server still keeps the stored booking in its queue without
 * hearing from the renter, by when the page last heard about it, in ms; 0
 * once that has run out, and null without a stored booking.
 */
export function queueHoldLeft(storage: Storage = localStorage, now = Date.now()): number | null {
  if (!storage.getItem(KEY)) return null;
  const seen = Number(storage.getItem(SEEN_KEY));
  if (!Number.isFinite(seen) || seen <= 0) return null;
  return Math.max(0, seen + QUEUE_HOLD_MS - now);
}

/** On page load: resume watching the booking this browser made, if it kept one. Null when there is none. */
export function resumeBooking(
  onUpdate: (booking: Booking | null) => void,
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
  /**
   * A claim the server failed to answer by its deadline, or refused (4xx), with
   * the Refusal when it refused the game; the booking is still followed, unless
   * a lost claim went through after all.
   */
  onClaimFailed?: (refusal?: Refusal) => void;
};

export type FollowOptions = BookingOptions & {
  /** Played when a match arrives while the tab is out of sight. */
  chime?: () => void;
  /** Whether the tab is out of sight. */
  hidden?: () => boolean;
  /** The first wait before trying a claim the network lost again; it doubles each time. */
  retryMs?: number;
};

/** The first wait before a lost claim is tried again, and the longest. */
const CLAIM_RETRY_MS = 1_000;
const CLAIM_RETRY_MAX_MS = 8_000;

const tabHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * Follow the booking and claim its machine by itself: at once when `first` is
 * a booking already matched (a picked machine, just booked), and otherwise the
 * moment the match arrives, pushed down the stream or found by the slow poll,
 * chiming first when the tab is out of sight. Each reservation is claimed once;
 * a match heard of while following whose claim the network loses is tried
 * again, waiting longer each time, until its reservation lapses (claimBy) or
 * the booking moves on. One the server refuses (4xx) is left, and following
 * goes on. A lost claim that went through after all (a later try refused as
 * `claimed`, or the stream reporting it claimed) holds the machine with no
 * ticket to join it: that booking is ended, handing the machine back, and
 * following stops.
 * Once claimed, the booking is forgotten as a booking to follow, kept as the
 * one being played (storedPlay), and following stops. Returns stop().
 */
export function followBooking(
  first: Booking | string,
  handlers: FollowHandlers,
  options: FollowOptions = {},
): () => void {
  const {
    chime = defaultChime,
    hidden = tabHidden,
    storage = localStorage,
    retryMs = CLAIM_RETRY_MS,
  } = options;
  const bookingId = typeof first === "string" ? first : first.bookingId;
  let stopped = false;
  /** The reservation (by its claim deadline) claimed or being claimed. */
  let claiming: number | undefined;
  /** The reservation the booking stands matched to now, if it does. */
  let matchedTo: number | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  /** The reservation a claim's answer was lost for: that claim may have gone through. */
  let lostFor: number | undefined;
  /** A claim waiting on its answer. */
  let asking = false;
  /** The booking was seen claimed while a claim of it waited on its answer. */
  let seenClaimed = false;

  /** A lost claim went through with no ticket to show for it: end the booking, handing the machine back. */
  const release = () => {
    stop();
    handlers.onClaimFailed?.();
    void endBooking(bookingId, options).then(
      (ended) => handlers.onUpdate(ended),
      () => handlers.onUpdate(null),
    );
  };

  /** Claim `booking`'s reservation; a lost claim is tried again after `waitMs`, while there is time. */
  const tryClaim = async (booking: Booking, waitMs: number | null) => {
    claiming = booking.claimBy;
    asking = true;
    let answer: ClaimAnswer;
    try {
      answer = await askToClaim(bookingId, options);
    } catch {
      asking = false;
      if (stopped) return;
      lostFor = booking.claimBy;
      if (seenClaimed) return release();
      if (claiming !== booking.claimBy) return;
      if (waitMs !== null && matchedTo === booking.claimBy && Date.now() + waitMs < (matchedTo ?? 0)) {
        retry = setTimeout(() => void tryClaim(booking, Math.min(waitMs * 2, CLAIM_RETRY_MAX_MS)), waitMs);
        return;
      }
      claiming = undefined;
      handlers.onClaimFailed?.();
      return;
    }
    asking = false;
    if (stopped) return;
    if (!("claim" in answer)) {
      if (answer.refused === "claimed" && lostFor === booking.claimBy) release();
      else handlers.onClaimFailed?.(answer.refusal);
      return;
    }
    const claimed = answer.claim;
    stop();
    forgetBooking(bookingId, storage);
    // Kept to come back to only: storage that refuses it (full, or switched
    // off) must not keep the renter from the machine they just claimed.
    try {
      const play: StoredPlay = { bookingId, sessionId: claimed.sessionId, roomId: claimed.roomId };
      storage.setItem(PLAY_KEY, JSON.stringify(play));
    } catch {
      console.warn("[swiff] could not keep the claimed booking for resume");
    }
    handlers.onClaimed(claimed, { ...booking, status: "claimed", sessionId: claimed.sessionId });
  };

  const unwatch = watchBooking(
    bookingId,
    (booking) => {
      if (stopped) return;
      handlers.onUpdate(booking);
      // Claimed with no ticket here: a claim whose answer was lost went through.
      // One still waiting on its answer decides once it has it.
      if (booking?.status === "claimed") {
        if (asking) seenClaimed = true;
        else if (lostFor !== undefined) return release();
      }
      if (booking?.status !== "matched") {
        matchedTo = undefined;
        clearTimeout(retry);
        return;
      }
      matchedTo = booking.claimBy;
      if (claiming === matchedTo) return;
      clearTimeout(retry);
      if (hidden()) chime();
      void tryClaim(booking, retryMs);
    },
    options,
  );
  const stop = () => {
    stopped = true;
    clearTimeout(retry);
    unwatch();
  };
  if (typeof first !== "string" && first.status === "matched") void tryClaim(first, null);
  return stop;
}
