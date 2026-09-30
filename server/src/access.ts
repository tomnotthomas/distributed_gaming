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

function sign(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function mintTicket(
  secret: string,
  room: string,
  ttlSeconds: number,
  now = Date.now(),
): string {
  const ticket: Ticket = {
    room,
    id: b64url(randomBytes(12)),
    exp: Math.floor(now / 1000) + ttlSeconds,
  };
  const payload = b64url(Buffer.from(JSON.stringify(ticket)));
  return `${payload}.${b64url(sign(secret, payload))}`;
}

/** The ticket, if it is signed by `secret` and has not expired. Otherwise null. */
export function verifyTicket(secret: string, token: unknown, now = Date.now()): Ticket | null {
  if (typeof token !== "string") return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;

  const expected = sign(secret, payload);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let ticket: Partial<Ticket>;
  try {
    ticket = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof ticket.room !== "string" || !ticket.room) return null;
  if (typeof ticket.id !== "string" || !ticket.id) return null;
  if (typeof ticket.exp !== "number" || ticket.exp * 1000 <= now) return null;
  return { room: ticket.room, id: ticket.id, exp: ticket.exp };
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
  /** Null when ROOM_SECRET is missing or too short: every join is refused. */
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
