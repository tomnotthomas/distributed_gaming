// Who may enter a room. Two credentials, one per side:
//
//   Gaming PC  machine key   A long random secret per machine, pasted into the
//                            host app once. The server holds only its SHA-256,
//                            so a leaked .env does not leak a working key.
//
//   Renter     join ticket   Signed by this server (HMAC-SHA256, ROOM_SECRET),
//                            naming one room and an expiry. Minted by the
//                            platform when a booking is claimed; in phase 1 by
//                            `npm run ticket`. Whoever holds it may take the
//                            room's renter seat until it expires, and only while
//                            nobody holding a different ticket is in it.
//
//   Streamer   session key   Signed by this server (HMAC-SHA256, ROOM_SECRET,
//                            its own domain so it is never a ticket), naming
//                            one room, one session and an expiry minutes away.
//                            Handed to the PC's background service, which holds
//                            the machine key, at session start; the service
//                            passes it to the streamer in the renter's Windows
//                            account, so the machine key never enters it. Only
//                            valid while that session is live — see sessions.ts.
//
// Both fail closed: with nothing configured no machine can register and no
// renter can join. A room that anyone with the URL can enter is not a default
// worth having on a machine that streams its screen to strangers.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type Ticket = {
  /** The room (machine id) this ticket opens. */
  room: string;
  /** Unique per ticket. The room's renter seat is held by one of these. */
  id: string;
  /** Unix seconds after which the ticket no longer opens anything. */
  exp: number;
};

/** Anything shorter is guessable offline once one ticket has been seen. */
export const MIN_SECRET_LENGTH = 32;

const b64url = (buf: Buffer) => buf.toString("base64url");

// Each kind of token signs its payload under its own prefix, so a join ticket
// can never be replayed as a session key or the other way round.
type Domain = "ticket" | "session";

/** HMAC-SHA256 signature of the encoded payload, separated by token domain. */
function sign(secret: string, payload: string, domain: Domain = "ticket"): Buffer {
  const prefix = domain === "ticket" ? "" : `${domain}.`;
  return createHmac("sha256", secret)
    .update(prefix + payload)
    .digest();
}

/**
 * Encode a JSON body and its domain-specific signature as a token.
 * JSON serialization errors propagate to the caller.
 */
function seal(secret: string, body: object, domain: Domain): string {
  const payload = b64url(Buffer.from(JSON.stringify(body)));
  return `${payload}.${b64url(sign(secret, payload, domain))}`;
}

/**
 * The token's parsed object payload if `secret` signed it under `domain`.
 * Malformed tokens, invalid signatures and JSON parse failures return null.
 * Payload fields and expiry are the caller's responsibility.
 */
function unseal(secret: string, token: unknown, domain: Domain): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;

  const expected = sign(secret, payload, domain);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const body: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Mint a signed join ticket for `room` with a random ticket id.
 * Expiry is `ttlSeconds` after `now` (Unix milliseconds) rounded down to whole seconds.
 */
export function mintTicket(secret: string, room: string, ttlSeconds: number, now = Date.now()): string {
  const ticket: Ticket = {
    room,
    id: b64url(randomBytes(12)),
    exp: Math.floor(now / 1000) + ttlSeconds,
  };
  return seal(secret, ticket, "ticket");
}

/**
 * The ticket, if it is signed by `secret` and has not expired. Otherwise null.
 * `now` is Unix milliseconds; a ticket is expired at its expiry time, not just after it.
 */
export function verifyTicket(secret: string, token: unknown, now = Date.now()): Ticket | null {
  const ticket = unseal(secret, token, "ticket");
  if (!ticket) return null;
  if (typeof ticket.room !== "string" || !ticket.room) return null;
  if (typeof ticket.id !== "string" || !ticket.id) return null;
  if (typeof ticket.exp !== "number" || ticket.exp * 1000 <= now) return null;
  return { room: ticket.room, id: ticket.id, exp: ticket.exp };
}

export type SessionKey = {
  /** The room (machine id) this key may register. */
  room: string;
  /** The platform session it belongs to. Dead the moment that session ends. */
  session: string;
  /**
   * The start that issued it. A session started again after its host session
   * was ended gets a new grant, so keys from before the end stay dead.
   */
  grant: string;
  /** Unix seconds after which the key registers nothing. */
  exp: number;
};

/**
 * Mint a signed key for the given room, session and grant without creating a live session.
 * Expiry is `ttlSeconds` after `now` (Unix milliseconds) rounded down to whole seconds.
 */
export function mintSessionKey(
  secret: string,
  { room, session, grant }: Omit<SessionKey, "exp">,
  ttlSeconds: number,
  now = Date.now(),
): string {
  const key: SessionKey = { room, session, grant, exp: Math.floor(now / 1000) + ttlSeconds };
  return seal(secret, key, "session");
}

/**
 * The key, if it is signed by `secret` as a session key and has not expired.
 * Whether its session is still live is for sessions.ts to say.
 * Invalid or expired tokens return null. `now` is Unix milliseconds;
 * a key is expired when its expiry time is less than or equal to `now`.
 */
export function verifySessionKey(secret: string, token: unknown, now = Date.now()): SessionKey | null {
  const key = unseal(secret, token, "session");
  if (!key) return null;
  if (typeof key.room !== "string" || !key.room) return null;
  if (typeof key.session !== "string" || !key.session) return null;
  if (typeof key.grant !== "string" || !key.grant) return null;
  if (typeof key.exp !== "number" || key.exp * 1000 <= now) return null;
  return { room: key.room, session: key.session, grant: key.grant, exp: key.exp };
}

/** A new machine key and the hash the server stores for it. */
export function newMachineKey(): { key: string; hash: string } {
  const key = b64url(randomBytes(32));
  return { key, hash: sha256(key).toString("hex") };
}

/** `id:sha256hex,id:sha256hex` → id → hash. Malformed entries are skipped. */
export function parseMachineKeys(value: string | undefined): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  for (const entry of (value ?? "").split(",")) {
    const [id, hash] = entry.trim().split(":");
    if (id && hash && /^[0-9a-f]{64}$/i.test(hash)) keys.set(id, Buffer.from(hash, "hex"));
  }
  return keys;
}

export function verifyMachineKey(keys: Map<string, Buffer>, id: unknown, key: unknown): boolean {
  if (typeof id !== "string" || typeof key !== "string") return false;
  const stored = keys.get(id);
  // Hashing first makes the comparison constant-length whatever was sent.
  return Boolean(stored) && timingSafeEqual(sha256(key), stored!);
}

export type Access = {
  /** Null when ROOM_SECRET is missing or too short: every join and session is refused. */
  secret: string | null;
  machines: Map<string, Buffer>;
};

export function accessFromEnv(env: NodeJS.ProcessEnv): Access {
  const secret = env.ROOM_SECRET?.trim() ?? "";
  return {
    secret: secret.length >= MIN_SECRET_LENGTH ? secret : null,
    machines: parseMachineKeys(env.MACHINE_KEYS),
  };
}
