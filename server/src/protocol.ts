// The signaling wire format. Defined once and imported by both sides — the
// server relays these and the browser sends them, so a change here is a change
// to both or it is a bug.
//
//   host    register ──► registered, session-claimed, peer-joined, answer, ice, peer-left,
//                        probe-offer (answered with probe-answer)
//   client  join     ──► joined, offer, ice, peer-left, game-started
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
/**
 * Pushed to a machine-key host the moment a renter claims its machine, so the
 * PC service need not wait for its next heartbeat. It starts the host session
 * for exactly this `sessionId` (see the session API below). `appid` is the
 * Steam game booked; `minutes` the time booked.
 */
export type SessionClaimedMessage = {
  type: "session-claimed";
  sessionId: string;
  appid: number;
  minutes: number;
};
/**
 * A latency probe: a data channel straight to a PC, which never takes the seat.
 *
 *   renter  probe        ──► server  asks to probe `hostId`
 *   server  probe-offer  ──► PC      the renter's offer, under the server's `probeId`
 *   PC      probe-answer ──► server  the PC's answer, relayed to the renter
 *
 * Neither side trickles: each description carries all of its candidates. The PC
 * echoes every message on the renter's channel and closes the probe when it
 * closes, or after 15 s. The PC side is in @swiff/rtc (probe.ts); the
 * server relay and the renter side are still to come.
 */
export type ProbeMessage = { type: "probe"; hostId: string };
export type ProbeOfferMessage = { type: "probe-offer"; probeId: string; sdp: RTCSessionDescriptionInit };
export type ProbeAnswerMessage = { type: "probe-answer"; probeId: string; sdp: RTCSessionDescriptionInit };

export type PeerJoinedMessage = { type: "peer-joined" };
/**
 * The other side left the room. To the host, `grace` (seconds) says the renter
 * dropped mid-session and has that long to come back with the same ticket
 * before the session ends as grace_expired (grace.ts): keep the game running,
 * let go of anything held. Without it the renter is not coming back.
 */
export type PeerLeftMessage = { type: "peer-left"; grace?: number };

/**
 * Sent by the host once it has launched the booked game (steam://rungameid),
 * after the stream's first frame and POST /api/sessions/:id/start. Relayed to
 * the renter like offer/answer/ice.
 */
export type GameStartedMessage = { type: "game-started"; appid: number };

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
  | SessionClaimedMessage
  | ProbeMessage
  | ProbeOfferMessage
  | ProbeAnswerMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | GameStartedMessage
  | PingMessage
  | PongMessage;

/** Messages the server forwards to the other peer without inspecting them. */
export const RELAYED_TYPES = ["offer", "answer", "ice", "game-started"] as const;

export function isRelayed(msg: SignalMessage): msg is SdpMessage | IceMessage | GameStartedMessage {
  return (RELAYED_TYPES as readonly string[]).includes(msg.type);
}

// --- Host session API (HTTP) -------------------------------------------------
//
// Called by the background service on the gaming PC, never by the streamer or
// the browser. Authenticated with the machine key as `Authorization: Bearer`.
//
//   POST   /api/machines/:id/session  start  SessionStart → 201 SessionGrant
//                                            | 400 bad-request | 409 not-claimed | 409 session-active
//   DELETE /api/machines/:id/session  end    → 204, whether or not one was live
//
// Either answers 500 internal-error when the database fails; try again.
//
// A host session is the PC's side of the platform session a renter claimed,
// under the same id: start names it, and the platform ending it ends this too.
// Every refusal is a SessionError body. Full contract:
// docs/system-design/session-keys.md.

/**
 * The session API path with the machine id encoded as one path segment.
 * Throws URIError if `hostId` contains an unpaired surrogate.
 */
export const sessionPath = (hostId: string) => `/api/machines/${encodeURIComponent(hostId)}/session`;

/** What start is sent: the claimed platform session, from `session-claimed` or a heartbeat. */
export type SessionStart = { sessionId: string };

/** What start returns. */
export type SessionGrant = {
  /** The platform session the key is for: the one start named. */
  sessionId: string;
  /** Hand to the streamer; it sends it in `register`. */
  sessionKey: string;
  /** Unix seconds. After this the key registers nothing; end and start for another. */
  expiresAt: number;
};

export type SessionError = {
  error:
    | "bad-machine-key"
    | "bad-request"
    | "not-claimed"
    | "session-active"
    | "not-configured"
    | "not-found"
    | "internal-error";
};

/**
 * Close code after `denied`. Clients stop reconnecting when they see `denied`:
 * retrying with the same credential gets the same answer, forever.
 */
export const DENIED_CODE = 4003;
