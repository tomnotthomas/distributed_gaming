// Live host sessions: which room is in a renter's session right now, and
// therefore which session keys still register anything.
//
//   PC service (machine key)            this server               streamer (renter account)
//   ------------------------            -----------               -------------------------
//                           ◄────────── session-claimed { sessionId }
//   POST .../session        ──────────► start: that platform
//     { sessionId }                     session's host session,
//                           ◄────────── session key (minutes)
//   launches the streamer with the key ─────────────────────────► register { sessionKey }
//                                       verify: signed, unexpired,
//                                       session still live ─────► registered
//   DELETE .../session      ──────────► end: every key of the
//                                       session dies, the
//                                       streamer is hung up on ─► denied session-ended
//
// A host session is the PC's side of the platform session a renter claimed,
// and has its id: the server checks that start names that machine's claimed
// session. A session key alone is not enough: its session must still be the
// room's live one, under the same grant. That is what makes revocation real
// for an HMAC token.
//
// Kept in a KeySessionStore. The server's is the platform database
// (platform.ts), so a restart keeps every live session and its keys, and the
// platform session ending removes it in the same transaction.

import { randomBytes } from "node:crypto";
import { mintSessionKey, verifySessionKey, type SessionKey } from "./access.js";
import type { SessionGrant } from "./protocol.js";

/**
 * How long a session key can be used to register. Long enough for the service
 * to launch the streamer and the streamer to connect; short enough that a key
 * copied out of the renter's account is useless soon after. A registered socket
 * outlives it — the key admits the socket, it is not re-checked while connected.
 */
export const SESSION_KEY_TTL_SECONDS = 5 * 60;

/** A room's live host session: the platform session it serves, and the start that opened it. */
export type KeySession = { sessionId: string; grantId: string };

/** Where live host sessions are kept, at most one per room. */
export type KeySessionStore = {
  /** The room's live host session, or null. */
  get: (room: string) => KeySession | null;
  /** Record a live host session; false, changing nothing, when the room already has one. */
  add: (room: string, session: KeySession) => boolean;
  /** Remove the room's live host session; returns its session id, or null if none was live. */
  remove: (room: string) => string | null;
};

/** A store that lives and dies with the process. For tests and tools. */
export function memoryKeySessions(): KeySessionStore {
  const live = new Map<string, KeySession>();
  return {
    get: (room) => live.get(room) ?? null,
    add(room, session) {
      if (live.has(room)) return false;
      live.set(room, session);
      return true;
    },
    remove(room) {
      const session = live.get(room);
      live.delete(room);
      return session?.sessionId ?? null;
    },
  };
}

export type HostSessions = {
  /**
   * Open the host session for platform session `sessionId` in `room`, or null
   * when one is already live there. The caller checks that `sessionId` is the
   * room's claimed session. `now` is Unix milliseconds; the grant's `expiresAt`
   * is Unix seconds.
   */
  start: (room: string, sessionId: string, now?: number) => SessionGrant | null;
  /** Ends the live session in `room`, revoking its keys; returns its id, or null if none was live. */
  end: (room: string) => string | null;
  /** Whether `room` is in a session. While it is, the machine key cannot register it. */
  isLive: (room: string) => boolean;
  /**
   * The key, if it is signed, unexpired and its session is still live under the
   * grant that issued it; otherwise null. `now` is Unix milliseconds; keys are
   * rejected at or after their expiry time.
   */
  verify: (token: unknown, now?: number) => SessionKey | null;
};

/**
 * Host sessions kept in `store`, at most one live per room. `secret` signs and
 * verifies keys; `ttlSeconds` limits key validity, not session lifetime.
 * Sessions stay live until ended here or by the store. Socket disconnection is
 * the caller's responsibility.
 */
export function createHostSessions(
  secret: string,
  store: KeySessionStore = memoryKeySessions(),
  ttlSeconds = SESSION_KEY_TTL_SECONDS,
): HostSessions {
  return {
    start(room, sessionId, now = Date.now()) {
      const grantId = randomBytes(12).toString("base64url");
      if (!store.add(room, { sessionId, grantId })) return null;
      const sessionKey = mintSessionKey(
        secret,
        { room, session: sessionId, grant: grantId },
        ttlSeconds,
        now,
      );
      return { sessionId, sessionKey, expiresAt: Math.floor(now / 1000) + ttlSeconds };
    },

    end: (room) => store.remove(room),

    isLive: (room) => store.get(room) !== null,

    verify(token, now = Date.now()) {
      const key = verifySessionKey(secret, token, now);
      if (!key) return null;
      const live = store.get(key.room);
      return live?.sessionId === key.session && live.grantId === key.grant ? key : null;
    },
  };
}
