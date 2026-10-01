// How often one signed-in renter may ask what can be played where
// (GET /api/availability, GET /api/games/:appid/machines). Each such read
// ranks every machine on offer, so one renter calling in a loop must not
// take the server's time from everyone else.
//
// A token bucket per renter: up to `burst` requests at once, then one more
// every `refillMs`. Keyed on the signed-in renter's Steam id, never on an
// address a request can claim in a header. A renter whose bucket has filled up
// again is forgotten once many renters are tracked, so the map stays small.

/** Requests one renter may make at once: a wall and a few game pages. */
export const DISCOVERY_BURST = 20;
/** After the burst, one more request per this many ms: 30 a minute. */
export const DISCOVERY_REFILL_MS = 2_000;
/** Past this many renters tracked, those with a full bucket are dropped. */
const MAX_TRACKED = 10_000;

export class RequestBudget {
  readonly #burst: number;
  readonly #refillMs: number;
  readonly #now: () => number;
  /** Each renter's tokens left as of `at`. */
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  constructor({
    burst = DISCOVERY_BURST,
    refillMs = DISCOVERY_REFILL_MS,
    now = Date.now,
  }: { burst?: number; refillMs?: number; now?: () => number } = {}) {
    this.#burst = burst;
    this.#refillMs = refillMs;
    this.#now = now;
  }

  /**
   * Spend one request of `renterId`'s budget. 0 when it may go ahead;
   * otherwise how many ms until it may, and nothing is spent.
   */
  take(renterId: string): number {
    const now = this.#now();
    const bucket = this.#buckets.get(renterId);
    const tokens = bucket ? this.#tokens(bucket, now) : this.#burst;
    if (tokens < 1) return Math.ceil((1 - tokens) * this.#refillMs);
    if (!bucket && this.#buckets.size >= MAX_TRACKED) this.#forgetIdle(now);
    this.#buckets.set(renterId, { tokens: tokens - 1, at: now });
    return 0;
  }

  /** Tokens in a bucket by `now`, refilled since it was last spent from, at most `burst`. */
  #tokens(bucket: { tokens: number; at: number }, now: number): number {
    return Math.min(this.#burst, bucket.tokens + Math.max(0, now - bucket.at) / this.#refillMs);
  }

  /** Drop every renter whose bucket is full again: they would start from a full one anyway. */
  #forgetIdle(now: number): void {
    for (const [renterId, bucket] of this.#buckets) {
      if (this.#tokens(bucket, now) >= this.#burst) this.#buckets.delete(renterId);
    }
  }
}
