// The renter's booking, kept across a closed tab or a sleeping laptop. The
// server drops a queued booking nobody has checked on for two minutes
// (server/src/platform.ts); polling it is that check. The booking id is kept in
// localStorage so a renter who comes back within those two minutes picks up the
// same place in the queue instead of booking again.
//
// Every call needs the renter signed in: the session cookie goes with each
// same-origin fetch, and a booking is only ever shown to the renter who made it.

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
const POLL_MS = 2_000;
/** Past these the browser has nothing left to wait for. */
const DONE: readonly BookingStatus[] = ["claimed", "playing", "ended", "expired"];

export type BookingOptions = {
  storage?: Storage;
  fetch?: typeof fetch;
  intervalMs?: number;
};

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
 * Check on the booking every `intervalMs` and report each answer. Stops, and
 * forgets the stored booking, once it is claimed, over, or gone — including
 * gone from view because the renter is no longer signed in. Returns stop().
 */
export function watchBooking(
  bookingId: string,
  onUpdate: (booking: Booking | null) => void,
  options: BookingOptions = {},
): () => void {
  const { storage = localStorage, fetch: get = fetch, intervalMs = POLL_MS } = options;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
  };

  const poll = async () => {
    let booking: Booking | null;
    try {
      const response = await get(`/api/bookings/${encodeURIComponent(bookingId)}`);
      if (response.status === 404 || response.status === 401) booking = null;
      else if (!response.ok) throw new Error(String(response.status));
      else booking = (await response.json()) as Booking;
    } catch {
      // A blip on the network: try again on the next beat.
      if (!stopped) timer = setTimeout(poll, intervalMs);
      return;
    }
    if (stopped) return;
    const done = !booking || DONE.includes(booking.status);
    if (done && storage.getItem(KEY) === bookingId) storage.removeItem(KEY);
    onUpdate(booking);
    if (done) stop();
    else timer = setTimeout(poll, intervalMs);
  };

  void poll();
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
