// The signaling wire format. Defined once and imported by both sides — the
// server relays these and the browser sends them, so a change here is a change
// to both or it is a bug.
//
//   host    register ──► registered, peer-joined, answer, ice, peer-left
//   client  join     ──► joined, offer, ice, peer-left
//   both    ping     ──► pong
//   either  refused  ──► denied, then the socket is closed with DENIED_CODE
//
// See access.ts for what `key`, `sessionKey` and `ticket` are, and
// docs/system-design/session-keys.md for how the PC gets a session key.

/**
 * Sent by the gaming PC to claim its room, with exactly one credential:
 *
 *   key         Its machine key. The phase-1 host app. Refused while the room
 *               is in a session (`session-active`), so it can never displace
 *               the streamer serving a renter.
 *   sessionKey  A session key for this room's live session. The streamer in
 *               the renter's Windows account, which must never hold the
 *               machine key. Replaces any host socket already in the room.
 */
export type RegisterMessage =
  | { type: "register"; hostId: string; key: string; sessionKey?: never }
  | { type: "register"; hostId: string; sessionKey: string; key?: never };

/** Sent by the renter to join a room. The room is the one the ticket names. */
export type JoinMessage = { type: "join"; ticket: string };

/** Relayed verbatim between the two peers. The server never reads these. */
export type SdpMessage = { type: "offer" | "answer"; sdp: RTCSessionDescriptionInit };
export type IceMessage = { type: "ice"; candidate: RTCIceCandidateInit };

/**
 * Server acknowledgements and room events. `iceServers` carries the TURN relay
 * when the server has one configured; clients add it to their default STUN.
 */
export type RegisteredMessage = { type: "registered"; hostId: string; iceServers?: RTCIceServer[] };
export type JoinedMessage = {
  type: "joined";
  hostId: string;
  hostOnline: boolean;
  iceServers?: RTCIceServer[];
};
/**
 * Why a register or join was refused, or why a registered host was hung up on.
 * The server closes the socket after it.
 *
 *   bad-machine-key  wrong machine key, or no such machine
 *   bad-session-key  forged, expired, for another room, or its session ended
 *   session-active   a machine-key register while the room is in a session
 *   session-ended    sent to a session-key host when its session is ended
 *   bad-ticket       renter's ticket forged or expired
 *   room-taken       another renter holds the seat
 */
export type DeniedMessage = {
  type: "denied";
  reason:
    "bad-machine-key" | "bad-session-key" | "session-active" | "session-ended" | "bad-ticket" | "room-taken";
};
export type PeerJoinedMessage = { type: "peer-joined" };
export type PeerLeftMessage = { type: "peer-left" };

/** Liveness. Required: Cloudflare closes an idle WebSocket after 100 seconds. */
export type PingMessage = { type: "ping" };
export type PongMessage = { type: "pong" };

export type SignalMessage =
  | RegisterMessage
  | JoinMessage
  | SdpMessage
  | IceMessage
  | RegisteredMessage
  | JoinedMessage
  | DeniedMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | PingMessage
  | PongMessage;

/** Messages the server forwards to the other peer without inspecting them. */
export const RELAYED_TYPES = ["offer", "answer", "ice"] as const;

export function isRelayed(msg: SignalMessage): msg is SdpMessage | IceMessage {
  return (RELAYED_TYPES as readonly string[]).includes(msg.type);
}

// --- Host session API (HTTP) -------------------------------------------------
//
// Called by the background service on the gaming PC, never by the streamer or
// the browser. Authenticated with the machine key as `Authorization: Bearer`.
//
//   POST   /api/machines/:id/session        start  → 201 SessionGrant | 409 session-active
//   POST   /api/machines/:id/session/renew  renew  → 200 SessionGrant | 404 no-session
//   DELETE /api/machines/:id/session        end    → 204, whether or not one was live
//
// Every refusal is a SessionError body. Full contract:
// docs/system-design/session-keys.md.

export const sessionPath = (hostId: string) => `/api/machines/${encodeURIComponent(hostId)}/session`;

/** What start and renew return. */
export type SessionGrant = {
  sessionId: string;
  /** Hand to the streamer; it sends it in `register`. */
  sessionKey: string;
  /** Unix seconds. After this the key registers nothing; renew for another. */
  expiresAt: number;
};

export type SessionError = {
  error: "bad-machine-key" | "session-active" | "no-session" | "not-configured" | "not-found";
};

/**
 * Close code after `denied`. Clients stop reconnecting when they see `denied`:
 * retrying with the same credential gets the same answer, forever.
 */
export const DENIED_CODE = 4003;
