// How often one signed-in renter may ask what can be played where
// (GET /api/availability, GET /api/games/:appid/machines). Each such read
// ranks every machine on offer, so one renter calling in a loop must not
// take the server's time from everyone else.
//
// A token bucket per renter: up to `burst` requests at once, then one more
// every `refillMs`. Keyed on the signed-in renter's Steam id, never on an
// address a request can claim in a header. The map is capped at `maxTracked`
// renters: once full, those whose bucket has filled up again are forgotten,
// and if that frees too little, the least recently active go too, a tenth of the cap
// at a time, so the cleanup runs once per many new renters rather than per one.
// A renter forgotten that way starts again from a full bucket.

/** Requests one renter may make at once: a wall and a few game pages. */
export const DISCOVERY_BURST = 20;
/** After the burst, one more request per this many ms: 30 a minute. */
export const DISCOVERY_REFILL_MS = 2_000;
/**
 * The most renters tracked at once: about 10 MB, and far more than are signed
 * in at once, so forgetting a renter whose bucket has not refilled is a last resort.
 */
export const MAX_TRACKED = 100_000;

export class RequestBudget {
  readonly #burst: number;
  readonly #refillMs: number;
  readonly #now: () => number;
  readonly #maxTracked: number;
  /** Each renter's tokens left as of `at`, least recently spent from first. */
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  constructor({
    burst = DISCOVERY_BURST,
    refillMs = DISCOVERY_REFILL_MS,
    now = Date.now,
    maxTracked = MAX_TRACKED,
  }: { burst?: number; refillMs?: number; now?: () => number; maxTracked?: number } = {}) {
    this.#burst = burst;
    this.#refillMs = refillMs;
    this.#now = now;
    this.#maxTracked = maxTracked;
  }

  /** How many renters are tracked right now. */
  get tracked(): number {
    return this.#buckets.size;
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
    if (!bucket && this.#buckets.size >= this.#maxTracked) this.#makeRoom(now);
    this.#buckets.delete(renterId); // re-added last: the most recently active
    this.#buckets.set(renterId, { tokens: tokens - 1, at: now });
    return 0;
  }

  /** Tokens in a bucket by `now`, refilled since it was last spent from, at most `burst`. */
  #tokens(bucket: { tokens: number; at: number }, now: number): number {
    return Math.min(this.#burst, bucket.tokens + Math.max(0, now - bucket.at) / this.#refillMs);
  }

  /**
   * Bring the map down to nine tenths of the cap: first every renter whose
   * bucket is full again (they would start from a full one anyway), then, if
   * that is not enough, the least recently active.
   */
  #makeRoom(now: number): void {
    const target = this.#maxTracked - Math.max(1, Math.floor(this.#maxTracked / 10));
    for (const [renterId, bucket] of this.#buckets) {
      if (this.#tokens(bucket, now) >= this.#burst) this.#buckets.delete(renterId);
    }
    for (const renterId of this.#buckets.keys()) {
      if (this.#buckets.size <= target) break;
      this.#buckets.delete(renterId);
    }
  }
}
