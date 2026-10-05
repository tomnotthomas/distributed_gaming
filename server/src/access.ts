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
//   Swiff OS   host certificate  Signed by this server (HMAC-SHA256, ROOM_SECRET,
//                            its own domain), naming one room, its hosting tier
//                            and an expiry minutes away. Minted only after the
//                            machine passed attestation — see attestation.ts.
//                            The hosting credential: the machine key alone is
//                            the control credential once hosting requires
//                            attestation.
//
//   Renter     sign-in session  Signed by this server (HMAC-SHA256 with
//                            SESSION_SECRET, never ROOM_SECRET, under its own
//                            domain), naming one Steam account and an expiry.
//                            Set as an HttpOnly cookie after Steam sign-in and
//                            required to book or claim — see signin.ts.
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
type Domain = "ticket" | "session" | "renter" | "signin" | "host" | "attest";

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
 * Mint a signed join ticket for `room` with a random ticket id, or `id` to hand
 * out a ticket already recorded on a session again.
 * Expiry is `ttlSeconds` after `now` (Unix milliseconds) rounded down to whole seconds.
 */
export function mintTicket(
  secret: string,
  room: string,
  ttlSeconds: number,
  now = Date.now(),
  id = b64url(randomBytes(12)),
): string {
  const ticket: Ticket = {
    room,
    id,
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

export type RenterSession = {
  /** The renter's 17-digit Steam id, as Steam OpenID vouched for it. */
  steamId: string;
  /** Unix seconds after which the session signs nobody in. */
  exp: number;
};

/** A Steam id as Steam OpenID returns it: exactly 17 digits. */
export const STEAM_ID = /^\d{17}$/;

/**
 * Mint a signed sign-in session for the Steam account `steamId`.
 * Expiry is `ttlSeconds` after `now` (Unix milliseconds) rounded down to whole seconds.
 */
export function mintRenterSession(
  secret: string,
  steamId: string,
  ttlSeconds: number,
  now = Date.now(),
): string {
  const session: RenterSession = { steamId, exp: Math.floor(now / 1000) + ttlSeconds };
  return seal(secret, session, "renter");
}

/**
 * The session, if `secret` signed it as a sign-in session, it names a Steam id
 * and has not expired. Otherwise null. `now` is Unix milliseconds; a session is
 * expired at its expiry time, not just after it.
 */
export function verifyRenterSession(secret: string, token: unknown, now = Date.now()): RenterSession | null {
  const session = unseal(secret, token, "renter");
  if (!session) return null;
  if (typeof session.steamId !== "string" || !STEAM_ID.test(session.steamId)) return null;
  if (typeof session.exp !== "number" || session.exp * 1000 <= now) return null;
  return { steamId: session.steamId, exp: session.exp };
}

/**
 * Mint a signed sign-in attempt holding `nonce`, valid for `ttlSeconds` after
 * `now` (Unix milliseconds). It ties Steam's answer to the browser that asked.
 */
export function mintSignInState(secret: string, nonce: string, ttlSeconds: number, now = Date.now()): string {
  return seal(secret, { nonce, exp: Math.floor(now / 1000) + ttlSeconds }, "signin");
}

/**
 * The nonce of a sign-in attempt `secret` signed that has not expired, or null.
 * `now` is Unix milliseconds; an attempt is expired at its expiry time.
 */
export function verifySignInState(secret: string, token: unknown, now = Date.now()): string | null {
  const state = unseal(secret, token, "signin");
  if (!state || typeof state.nonce !== "string" || !state.nonce) return null;
  if (typeof state.exp !== "number" || state.exp * 1000 <= now) return null;
  return state.nonce;
}

/** How far a machine may be trusted to host, by what vouched for it (attestation.ts). */
export type HostingTier = "attested" | "attested-discrete-tpm" | "unattested";

export type HostCert = {
  /** The room (machine id) this certificate may host. */
  room: string;
  /** What attestation found the machine to be. Never "unattested": that is the machine key's tier. */
  tier: Exclude<HostingTier, "unattested">;
  /** Unique per certificate. Starting a host session spends it (attestation.ts). */
  id: string;
  /** Unix seconds after which the certificate hosts nothing. */
  exp: number;
  /** Unix seconds it was minted at: the attestation it came from. Null in one minted before it was kept. */
  iat: number | null;
  /**
   * The TPM's resetCount in the quote that earned it, which counts the
   * machine's boots: the boot it was minted for. Null when the verifier does
   * not report one. The state key is released only to the machine's latest boot (state-key.ts).
   */
  boot: number | null;
};

const ATTESTED_TIERS: readonly string[] = ["attested", "attested-discrete-tpm"];

/**
 * Mint a signed host certificate for `room` at `tier`, with a random id, for
 * the boot `boot` counts (null: unknown). Expiry is `ttlSeconds` after `now`
 * (Unix milliseconds) rounded down to whole seconds.
 */
export function mintHostCert(
  secret: string,
  room: string,
  tier: HostCert["tier"],
  ttlSeconds: number,
  now = Date.now(),
  boot: number | null = null,
): string {
  const iat = Math.floor(now / 1000);
  const cert: HostCert = {
    room,
    tier,
    id: b64url(randomBytes(16)),
    exp: iat + ttlSeconds,
    iat,
    boot,
  };
  return seal(secret, cert, "host");
}

/**
 * The certificate, if `secret` signed it as a host certificate, it names a room
 * and an attested tier, and it has not expired. Otherwise null. `now` is Unix
 * milliseconds; a certificate is expired at its expiry time.
 */
export function verifyHostCert(secret: string, token: unknown, now = Date.now()): HostCert | null {
  const cert = unseal(secret, token, "host");
  if (!cert) return null;
  if (typeof cert.room !== "string" || !cert.room) return null;
  if (typeof cert.tier !== "string" || !ATTESTED_TIERS.includes(cert.tier)) return null;
  if (typeof cert.id !== "string" || !cert.id) return null;
  if (typeof cert.exp !== "number" || cert.exp * 1000 <= now) return null;
  const count = (value: unknown) =>
    Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
  return {
    room: cert.room,
    tier: cert.tier as HostCert["tier"],
    id: cert.id,
    exp: cert.exp,
    iat: count(cert.iat),
    boot: count(cert.boot),
  };
}

export type AttestChallenge = {
  /** The room (machine id) whose attestation this challenge is for. */
  room: string;
  /** Unique per challenge; it is spent by the first attestation that names it. */
  id: string;
  /** Unix seconds after which it is no longer accepted. */
  exp: number;
};

/**
 * Mint a signed attestation challenge for `room` with a random id. The machine
 * quotes over its SHA-256, so the quote is fresh. Expiry is `ttlSeconds` after
 * `now` (Unix milliseconds) rounded down to whole seconds.
 */
export function mintChallenge(secret: string, room: string, ttlSeconds: number, now = Date.now()): string {
  const challenge: AttestChallenge = {
    room,
    id: b64url(randomBytes(16)),
    exp: Math.floor(now / 1000) + ttlSeconds,
  };
  return seal(secret, challenge, "attest");
}

/**
 * The challenge, if `secret` signed it as an attestation challenge and it has
 * not expired. Otherwise null. Whether it was already spent is the caller's to
 * track. `now` is Unix milliseconds; a challenge is expired at its expiry time.
 */
export function verifyChallenge(secret: string, token: unknown, now = Date.now()): AttestChallenge | null {
  const challenge = unseal(secret, token, "attest");
  if (!challenge) return null;
  if (typeof challenge.room !== "string" || !challenge.room) return null;
  if (typeof challenge.id !== "string" || !challenge.id) return null;
  if (typeof challenge.exp !== "number" || challenge.exp * 1000 <= now) return null;
  return { room: challenge.room, id: challenge.id, exp: challenge.exp };
}

/** A new machine key and the hash the server stores for it. */
export function newMachineKey(): { key: string; hash: string } {
  const key = b64url(randomBytes(32));
  return { key, hash: sha256(key).toString("hex") };
}

/** `id:sha256hex[:owner],…` → id → hash. Malformed entries are skipped. */
export function parseMachineKeys(value: string | undefined): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  for (const entry of (value ?? "").split(",")) {
    const [id, hash] = entry.trim().split(":");
    if (id && hash && /^[0-9a-f]{64}$/i.test(hash)) keys.set(id, Buffer.from(hash, "hex"));
  }
  return keys;
}

/**
 * `id:sha256hex:owner,…` → id → the owner's Steam id, for every well-formed
 * entry that names one. An owner that is not a 17-digit Steam id is skipped.
 */
export function parseMachineOwners(value: string | undefined): Map<string, string> {
  const owners = new Map<string, string>();
  for (const entry of (value ?? "").split(",")) {
    const [id, hash, owner] = entry.trim().split(":");
    if (id && hash && /^[0-9a-f]{64}$/i.test(hash) && owner && STEAM_ID.test(owner)) owners.set(id, owner);
  }
  return owners;
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
  /** Machine id → its owner's Steam id. A renter is never matched to a machine they own. */
  owners: Map<string, string>;
};

/** ROOM_SECRET and MACHINE_KEYS, parsed. A missing or short secret is null. */
export function accessFromEnv(env: NodeJS.ProcessEnv): Access {
  const secret = env.ROOM_SECRET?.trim() ?? "";
  return {
    secret: secret.length >= MIN_SECRET_LENGTH ? secret : null,
    machines: parseMachineKeys(env.MACHINE_KEYS),
    owners: parseMachineOwners(env.MACHINE_KEYS),
  };
}
