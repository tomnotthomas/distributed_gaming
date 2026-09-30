// Live host sessions: which room is in a renter's session right now, and
// therefore which session keys still register anything.
//
//   PC service (machine key)            this server               streamer (renter account)
//   ------------------------            -----------               -------------------------
//   POST .../session        ──────────► start: new session,
//                           ◄────────── session key (minutes)
//   launches the streamer with the key ─────────────────────────► register { sessionKey }
//                                       verify: signed, unexpired,
//                                       session still live ─────► registered
//   POST .../session/renew  ──────────► fresh key, same session
//   DELETE .../session      ──────────► end: every key of the
//                                       session dies, the
//                                       streamer is hung up on ─► denied session-ended
//
// A session key alone is not enough: its session must still be the room's live
// one. That is what makes revocation real for an HMAC token, and why a server
// restart (which forgets every session) fails closed.
//
// Held in memory, like the rooms themselves. One process is the whole
// signaling server; when there is a database this moves there.

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

export type HostSessions = {
  /** A new session for `room`, or null when one is already live there. */
  start: (room: string, now?: number) => SessionGrant | null;
  /** A fresh key for the live session in `room`, or null when there is none. */
  renew: (room: string, now?: number) => SessionGrant | null;
  /** Ends the live session in `room`, if any, and returns its id. */
  end: (room: string) => string | null;
  /** Whether `room` is in a session. While it is, the machine key cannot register it. */
  isLive: (room: string) => boolean;
  /** The key, if it is signed, unexpired and its session is still live. */
  verify: (token: unknown, now?: number) => SessionKey | null;
};

export function createHostSessions(secret: string, ttlSeconds = SESSION_KEY_TTL_SECONDS): HostSessions {
  const live = new Map<string, string>(); // room -> session id

  const grant = (room: string, sessionId: string, now: number): SessionGrant => {
    const sessionKey = mintSessionKey(secret, room, sessionId, ttlSeconds, now);
    return { sessionId, sessionKey, expiresAt: Math.floor(now / 1000) + ttlSeconds };
  };

  return {
    start(room, now = Date.now()) {
      if (live.has(room)) return null;
      const sessionId = randomBytes(12).toString("base64url");
      live.set(room, sessionId);
      return grant(room, sessionId, now);
    },

    renew(room, now = Date.now()) {
      const sessionId = live.get(room);
      return sessionId ? grant(room, sessionId, now) : null;
    },

    end(room) {
      const sessionId = live.get(room) ?? null;
      live.delete(room);
      return sessionId;
    },

    isLive: (room) => live.has(room),

    verify(token, now = Date.now()) {
      const key = verifySessionKey(secret, token, now);
      return key && live.get(key.room) === key.session ? key : null;
    },
  };
}
