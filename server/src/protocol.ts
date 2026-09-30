// The signaling wire format. Defined once and imported by both sides — the
// server relays these and the browser sends them, so a change here is a change
// to both or it is a bug.
//
//   host    register ──► registered, peer-joined, answer, ice, peer-left
//   client  join     ──► joined, offer, ice, peer-left
//   both    ping     ──► pong
//   either  refused  ──► denied, then the socket is closed with DENIED_CODE
//
// See access.ts for what `key` and `ticket` are.

/** Sent by the gaming PC to claim its room. `key` is its machine key. */
export type RegisterMessage = { type: "register"; hostId: string; key: string };

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
/** Why a register or join was refused. The server closes the socket after it. */
export type DeniedMessage = {
  type: "denied";
  reason: "bad-machine-key" | "bad-ticket" | "room-taken";
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

/**
 * Close code after `denied`. Clients stop reconnecting when they see `denied`:
 * retrying with the same credential gets the same answer, forever.
 */
export const DENIED_CODE = 4003;
