// The signaling wire format. Defined once and imported by both sides — the
// server relays these and the browser sends them, so a change here is a change
// to both or it is a bug.
//
//   host    register ──► registered, session-claimed, peer-joined, answer, ice, peer-left
//   client  join     ──► joined, offer, ice, peer-left
//   both    ping     ──► pong
//   either  refused  ──► denied, then the socket is closed with DENIED_CODE
//
// See access.ts for what `key`, `hostCert`, `sessionKey` and `ticket` are,
// attestation.ts for which of them may host, and
// docs/system-design/session-keys.md for how the PC gets a session key.

/**
 * Sent by the gaming PC to claim its room, with exactly one credential:
 *
 *   key         Its machine key. The phase-1 host app. Hosts only while
 *               hosting does not require attestation (`attestation-required`
 *               otherwise). Refused while the room is in a session
 *               (`session-active`), so it can never displace the streamer
 *               serving a renter.
 *   hostCert    A host certificate from attestation: swiff-hostd in Swiff OS.
 *               Otherwise exactly as the machine key: the PC service's socket.
 *   sessionKey  A session key for this room's live session. The streamer in
 *               the renter's Windows account, which must never hold the
 *               machine key. Replaces any host socket already in the room.
 */
export type RegisterMessage =
  | { type: "register"; hostId: string; key: string; hostCert?: never; sessionKey?: never }
  | { type: "register"; hostId: string; hostCert: string; key?: never; sessionKey?: never }
  | { type: "register"; hostId: string; sessionKey: string; key?: never; hostCert?: never };

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
 *   bad-host-cert    host certificate forged, expired, spent on a session start, or for
 *                    another room; also sent to a registered socket when its certificate expires
 *   attestation-required  a machine-key register while hosting requires attestation
 *   bad-session-key  forged, expired, for another room, or its session ended
 *   session-active   a machine-key or host-certificate register while the room is in a session
 *   session-ended    sent to a session-key host when its session is ended
 *   bad-ticket       renter's ticket forged or expired
 *   room-taken       another renter holds the seat
 */
export type DeniedMessage = {
  type: "denied";
  reason:
    | "bad-machine-key"
    | "bad-host-cert"
    | "attestation-required"
    | "bad-session-key"
    | "session-active"
    | "session-ended"
    | "bad-ticket"
    | "room-taken";
};
/**
 * Pushed to the PC service's socket (machine key or host certificate, never a
 * streamer's) the moment a renter claims its machine, so it need not wait for
 * its next heartbeat. It starts the host session
 * for exactly this `sessionId` (see the session API below). `appid` is the
 * Steam game booked; `minutes` the time booked.
 */
export type SessionClaimedMessage = {
  type: "session-claimed";
  sessionId: string;
  appid: number;
  minutes: number;
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
  | SessionClaimedMessage
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
// the browser. Authenticated as `Authorization: Bearer` with the machine key or
// a host certificate. Starting is hosting: with the machine key it is refused
// 403 attestation-required while hosting requires attestation. Ending is
// control too, so the machine key always may.
//
//   POST   /api/machines/:id/session  start  SessionStart → 201 SessionGrant
//                                            | 400 bad-request | 403 attestation-required
//                                            | 409 not-claimed | 409 session-active
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
    | "bad-host-cert"
    | "attestation-required"
    | "bad-request"
    | "not-claimed"
    | "session-active"
    | "not-configured"
    | "not-found"
    | "internal-error";
};

// --- Attestation API (HTTP) --------------------------------------------------
//
// Called by swiff-hostd in Swiff OS to earn a host certificate; no other
// credential. See attestation.ts.
//
//   POST /api/machines/:id/attest-challenge  → 200 AttestChallengeGrant
//   POST /api/machines/:id/attest  AttestRequest → 200 HostCertGrant
//                                  | 400 bad-request (413 when too large) | 401 bad-nonce
//                                  | 403 attestation-refused | 429 too-many-attempts
//                                  | 503 verifier-unavailable
//
// Either answers 404 not-found for a machine with no key configured, and 503
// not-configured when the server has no ROOM_SECRET or no verifier.

/** A challenge to quote over. */
export type AttestChallengeGrant = {
  /** Opaque. The TPM quote's qualifying data is its SHA-256; send it back as is. */
  nonce: string;
  /** Unix seconds. Attest before this; each nonce is good for one attempt. */
  expiresAt: number;
};

/** What attest is sent. `evidence` is the verifier's to read: quote, event log, EK certificate, AK proof. */
export type AttestRequest = { nonce: string; evidence: unknown };

/** What attest returns: the hosting credential. */
export type HostCertGrant = {
  /** Bearer for the hosting calls, and `hostCert` in `register`. Starts one host session at most. */
  hostCert: string;
  /** How far attestation trusts this machine (D3: a discrete TPM is a lower tier). */
  tier: "attested" | "attested-discrete-tpm";
  /** Unix seconds. A socket registered with it is put out then; attest again for a fresh one. */
  expiresAt: number;
};

export type AttestRefusal = {
  error:
    | "bad-request"
    | "bad-nonce"
    | "attestation-refused"
    | "too-many-attempts"
    | "verifier-unavailable"
    | "not-found"
    | "not-configured";
  /** Why attestation-refused: the verifier rejected the evidence, or the hardware is below the floor. */
  reason?: "evidence-rejected" | "below-hardware-floor";
};

/**
 * Close code after `denied`. Clients stop reconnecting when they see `denied`:
 * retrying with the same credential gets the same answer, forever.
 */
export const DENIED_CODE = 4003;
