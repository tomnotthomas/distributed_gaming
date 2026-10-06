// What may pass between a player and a crewmate watching them (relayWatch in
// index.ts). Their connection is relay-only: both sides gather nothing but
// TURN candidates (iceTransportPolicy "relay"), so neither learns the other's
// IP address, only the relay's. The server holds them to it: a frame is
// rebuilt from the fields its peer needs, an ICE candidate that is not a relay
// one is dropped, and an SDP keeps only its relay candidates and no address.
// None of it is ever logged.
//
//   offer / answer  { type, sdp: { type, sdp: relaySdp(sdp) }, watchId }
//   ice             { type, candidate: { candidate, sdpMid, sdpMLineIndex }, watchId }, relay or end only,
//                   with the related address (raddr: where the relay saw the user from) blanked
//   crew            { type, data: roster or voice, field by field, watchId }
//
// Without a TURN server there is no relay to use, so there is no watching
// (api.ts refuses the ask): never a fallback to direct candidates.

import type { CrewSignal, SignalMessage, VoicePerson } from "./protocol.js";

/** The longest SDP passed on. A real one is a few kilobytes. */
export const MAX_SDP_BYTES = 64_000;
/** The longest name in a roster passed on. */
const MAX_NAME = 64;

/** Whether an ICE candidate line is a relay one (`typ relay`). Host, srflx and prflx carry a user's own address. */
export function isRelayCandidate(candidate: string): boolean {
  return /\styp\s+relay(\s|$)/.test(candidate);
}

/**
 * A relay candidate with its related address (`raddr`, `rport`) blanked: that
 * is where the relay first saw the user from, their own address. Nothing
 * needs it to connect.
 */
export function blankRelated(candidate: string): string {
  return candidate.replace(/\sraddr\s+\S+\s+rport\s+\d+/, " raddr 0.0.0.0 rport 0");
}

/**
 * `sdp` with every candidate that is not a relay one taken out, the relay
 * ones' related addresses and the connection addresses blanked: what a
 * relay-only peer would have sent anyway, whatever this one sent.
 */
export function relaySdp(sdp: string): string {
  return sdp
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("a=candidate:") || isRelayCandidate(line))
    .map((line) => {
      if (line.startsWith("a=candidate:")) return blankRelated(line);
      if (/^c=IN IP4 /.test(line)) return "c=IN IP4 0.0.0.0";
      if (/^c=IN IP6 /.test(line)) return "c=IN IP6 ::";
      if (/^a=rtcp:\d+ IN IP4 /.test(line)) return line.replace(/ IN IP4 .*$/, " IN IP4 0.0.0.0");
      if (/^a=rtcp:\d+ IN IP6 /.test(line)) return line.replace(/ IN IP6 .*$/, " IN IP6 ::");
      return line;
    })
    .join("\r\n");
}

/** One voice-chat person, field by field, or null when it is not one. */
function voicePerson(value: unknown): VoicePerson | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  if (typeof p.id !== "string" || p.id.length > MAX_NAME) return null;
  if (p.name !== null && (typeof p.name !== "string" || p.name.length > MAX_NAME)) return null;
  if (p.mid !== null && (typeof p.mid !== "string" || p.mid.length > 8)) return null;
  if (
    typeof p.inVoice !== "boolean" ||
    typeof p.muted !== "boolean" ||
    typeof p.mutedByPlayer !== "boolean"
  ) {
    return null;
  }
  return {
    id: p.id,
    name: p.name,
    mid: p.mid,
    inVoice: p.inVoice,
    muted: p.muted,
    mutedByPlayer: p.mutedByPlayer,
  };
}

/** The voice chat's talk, field by field, or null when it is not that. */
function crewSignal(value: unknown): CrewSignal | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (data.kind === "voice") {
    if (typeof data.inVoice !== "boolean" || typeof data.muted !== "boolean") return null;
    return { kind: "voice", inVoice: data.inVoice, muted: data.muted };
  }
  if (data.kind === "roster" && Array.isArray(data.people) && data.people.length <= 8) {
    const people = data.people.map(voicePerson);
    return people.every((p) => p !== null) ? { kind: "roster", people: people as VoicePerson[] } : null;
  }
  return null;
}

/**
 * The frame `msg` as its peer gets it on watch `watchId`: rebuilt from the
 * fields that peer needs, relay candidates only. Null when nothing of it may
 * pass: a host or srflx candidate, or a frame that is not what it says.
 */
export function watchFrame(msg: SignalMessage, watchId: string): SignalMessage | null {
  switch (msg.type) {
    case "offer":
    case "answer": {
      const sdp = msg.sdp;
      if (!sdp || typeof sdp.sdp !== "string" || sdp.type !== msg.type) return null;
      if (sdp.sdp.length > MAX_SDP_BYTES) return null;
      return { type: msg.type, sdp: { type: msg.type, sdp: relaySdp(sdp.sdp) }, watchId };
    }
    case "ice": {
      const c = msg.candidate;
      if (!c || typeof c.candidate !== "string") return null;
      // The empty candidate is the end of candidates: no address in it.
      if (c.candidate !== "" && !isRelayCandidate(c.candidate)) return null;
      const candidate: RTCIceCandidateInit = { candidate: blankRelated(c.candidate) };
      if (typeof c.sdpMid === "string") candidate.sdpMid = c.sdpMid;
      if (typeof c.sdpMLineIndex === "number") candidate.sdpMLineIndex = c.sdpMLineIndex;
      return { type: "ice", candidate, watchId };
    }
    case "crew": {
      const data = crewSignal(msg.data);
      return data ? { type: "crew", data, watchId } : null;
    }
    default:
      return null;
  }
}
