// The signaling wire format. Defined once and imported by both sides — the
// server relays these and the browser sends them, so a change here is a change
// to both or it is a bug.
//
//   host    register ──► registered, peer-joined, answer, ice, peer-left
//   client  join     ──► joined, offer, ice, peer-left
//   both    ping     ──► pong

/** Sent by the gaming PC to claim its room. */
export type RegisterMessage = { type: "register"; hostId: string };

/** Sent by the renter to join a room. */
export type JoinMessage = { type: "join"; hostId: string };

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
  | PeerJoinedMessage
  | PeerLeftMessage
  | PingMessage
  | PongMessage;

/** Messages the server forwards to the other peer without inspecting them. */
export const RELAYED_TYPES = ["offer", "answer", "ice"] as const;

export function isRelayed(msg: SignalMessage): msg is SdpMessage | IceMessage {
  return (RELAYED_TYPES as readonly string[]).includes(msg.type);
}
