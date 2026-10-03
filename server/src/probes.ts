// Latency probes: the relay for a renter's data channel straight to a PC,
// which measures the real path between them before anything is booked.
//
//   renter ── probe (token, offer) ──► here ── probe-offer ──► PC
//   renter ◄── probe-answer ────────── here ◄── probe-answer ── PC
//
// A probe answer carries the PC's candidates, its public address among them,
// so a renter may only probe what they are about to choose between: signed in,
// only the machines the server ranked in their top three for a game (the
// token, minted with the list in api.ts and spent here), and no more than 20
// a minute. A probe never touches a room's seat: it is not a join, and the
// renter in the room hears nothing of it. The server reads nothing in the
// descriptions; it only checks they are the right shape and size.
//
// Wire format: protocol.ts. The PC's side is @swiff/rtc's probe.ts, the
// renter's its latency.ts.

import { randomBytes } from "node:crypto";
import { verifyProbeToken, type RenterSession } from "./access.js";
import { RequestBudget } from "./budget.js";
import type { ProbeAnswerMessage, ProbeMessage, ProbeRefusedMessage, SignalMessage } from "./protocol.js";

/** How many of a renter's best machines for a game get a probe token. */
export const PROBED_PER_GAME = 3;
/** How long a probe token is good for, in seconds: the game page probes as soon as it has the list. */
export const PROBE_TOKEN_TTL_S = 60;
/** Probes one renter may start at once, and then one more every PROBE_REFILL_MS: 20 a minute. */
export const PROBE_BURST = 20;
export const PROBE_REFILL_MS = 60_000 / PROBE_BURST;
/** How long the PC's answer is waited for. The PC gives up on a probe after as long (probe.ts PROBE_MAX_MS). */
export const PROBE_WAIT_MS = 15_000;
/** The largest probe id taken from either side. */
const MAX_PROBE_ID_CHARS = 64;
/** The largest description relayed. A data-channel description with every candidate is a few KB. */
const MAX_SDP_CHARS = 16 * 1024;

/** A probe relayed to a PC, waiting for its answer. */
type Pending<S> = { renter: S; renterProbeId: string; host: S; timer: ReturnType<typeof setTimeout> };

export type ProbeRelayOptions<S> = {
  /** Signs probe tokens (SESSION_SECRET). Null: every probe is refused. */
  secret: string | null;
  /** Send a message to a socket, if it is still open. */
  send: (to: S, msg: SignalMessage) => void;
  /** The socket holding `hostId`'s room, or null when its PC is not connected. */
  hostSocket: (hostId: string) => S | null;
  /** Each renter's budget of probes. Defaults to PROBE_BURST, refilled one per PROBE_REFILL_MS. */
  budget?: RequestBudget;
  now?: () => number;
  waitMs?: number;
};

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_PROBE_ID_CHARS;

/** Whether `sdp` is a description of `type` small enough to relay. */
const isSdp = (sdp: unknown, type: "offer" | "answer"): sdp is RTCSessionDescriptionInit =>
  typeof sdp === "object" &&
  sdp !== null &&
  (sdp as RTCSessionDescriptionInit).type === type &&
  typeof (sdp as RTCSessionDescriptionInit).sdp === "string" &&
  (sdp as RTCSessionDescriptionInit).sdp!.length <= MAX_SDP_CHARS;

export class ProbeRelay<S> {
  readonly #secret: string | null;
  readonly #send: (to: S, msg: SignalMessage) => void;
  readonly #hostSocket: (hostId: string) => S | null;
  readonly #budget: RequestBudget;
  readonly #now: () => number;
  readonly #waitMs: number;
  /** Probes relayed to a PC, by the id the PC was given. */
  readonly #pending = new Map<string, Pending<S>>();
  /** Tokens spent, each until it expires (Unix ms): a token is good for one probe. */
  readonly #spent = new Map<string, number>();

  constructor({
    secret,
    send,
    hostSocket,
    budget,
    now = Date.now,
    waitMs = PROBE_WAIT_MS,
  }: ProbeRelayOptions<S>) {
    this.#secret = secret;
    this.#send = send;
    this.#hostSocket = hostSocket;
    this.#now = now;
    this.#budget = budget ?? new RequestBudget({ burst: PROBE_BURST, refillMs: PROBE_REFILL_MS, now });
    this.#waitMs = waitMs;
  }

  /** Probes waiting for a PC's answer. */
  get pending(): number {
    return this.#pending.size;
  }

  /**
   * A renter's `probe` from socket `from`, signed in as `renter` (null when its
   * upgrade request carried no sign-in): relayed to the PC as a probe-offer, or
   * refused. A message without a usable probe id or offer is dropped unanswered.
   */
  probe(from: S, renter: RenterSession | null, msg: ProbeMessage): void {
    if (!isId(msg.probeId) || !isSdp(msg.sdp, "offer")) return;
    const refuse = (reason: ProbeRefusedMessage["reason"]) =>
      this.#send(from, { type: "probe-refused", probeId: msg.probeId, reason });

    const now = this.#now();
    this.#forgetSpent(now);
    const token = this.#secret ? verifyProbeToken(this.#secret, msg.token, now) : null;
    if (
      !renter ||
      renter.exp * 1000 <= now ||
      !token ||
      token.renter !== renter.steamId ||
      token.host !== msg.hostId ||
      this.#spent.has(token.id)
    ) {
      return refuse("bad-token");
    }
    if (this.#budget.take(renter.steamId) !== 0) return refuse("too-many");
    const host = this.#hostSocket(msg.hostId);
    if (!host) return refuse("host-offline");

    this.#spent.set(token.id, token.exp * 1000);
    const probeId = randomBytes(12).toString("base64url");
    const timer = setTimeout(() => this.#pending.delete(probeId), this.#waitMs);
    timer.unref?.();
    this.#pending.set(probeId, { renter: from, renterProbeId: msg.probeId, host, timer });
    this.#send(host, { type: "probe-offer", probeId, sdp: msg.sdp });
  }

  /**
   * A PC's `probe-answer` from socket `from`: relayed to the renter who asked,
   * under their own probe id. Only the socket the offer went to may answer it,
   * once; anything else is dropped.
   */
  answer(from: S, msg: ProbeAnswerMessage): void {
    if (!isId(msg.probeId) || !isSdp(msg.sdp, "answer")) return;
    const pending = this.#pending.get(msg.probeId);
    if (!pending || pending.host !== from) return;
    this.#drop(msg.probeId, pending);
    this.#send(pending.renter, { type: "probe-answer", probeId: pending.renterProbeId, sdp: msg.sdp });
  }

  /** `socket` closed: nothing more is relayed to or from it. */
  forget(socket: S): void {
    for (const [probeId, pending] of this.#pending) {
      if (pending.renter === socket || pending.host === socket) this.#drop(probeId, pending);
    }
  }

  /** Stop waiting on every probe. */
  close(): void {
    for (const [probeId, pending] of this.#pending) this.#drop(probeId, pending);
  }

  #drop(probeId: string, pending: Pending<S>): void {
    clearTimeout(pending.timer);
    this.#pending.delete(probeId);
  }

  /**
   * Forget spent tokens that have expired: they are refused as expired now.
   * Oldest spent first, stopping at the first still live, so a probe never
   * walks every token: one minted earlier but spent later waits its turn.
   */
  #forgetSpent(now: number): void {
    for (const [id, until] of this.#spent) {
      if (until > now) break;
      this.#spent.delete(id);
    }
  }
}
