// The gaming PC's side of a renter's latency probe: a peer connection with one
// data channel and no media, answered alongside whatever the PC is doing. It
// never touches the seat: a probe is not a join, adds no track and takes no
// input, and the renter in the room (if any) never hears of it.
//
//   probe-offer ──► answer with every candidate ──► probe-answer ──► echo each message
//
// The renter opens the channel and times its messages coming back. A probe
// is small and short: a few open at once, a few messages each, closed after
// PROBE_MAX_MS whatever happens. Wire format: server/src/protocol.ts.

import { createPeerConnection } from "./peer";
import type { SignalMessage } from "./signaling";

type ProbeOffer = Extract<SignalMessage, { type: "probe-offer" }>;

/** The longest a probe stays open, whatever happens on it. */
export const PROBE_MAX_MS = 15_000;
/** Probes open at once; an offer past this is left unanswered, and the renter's probe times out. */
export const MAX_OPEN_PROBES = 4;
/** Messages echoed per probe. A latency probe needs a handful; more is someone borrowing the PC's upload. */
export const MAX_PROBE_MESSAGES = 64;
/** The largest message echoed. A timestamp and a sequence number fit many times over. */
export const MAX_PROBE_MESSAGE_BYTES = 256;
/** How long the answer waits for its candidates before it is sent with those it has. */
const GATHER_MS = 3_000;
/** The largest offer answered. A data-channel offer with every candidate is a few KB. */
const MAX_OFFER_CHARS = 16 * 1024;

export type ProbeResponderOptions = {
  /** The ICE servers to answer with, read per probe: TURN credentials change while the app runs. */
  iceServers: () => RTCIceServer[];
  /** For tests. */
  createPeer?: (iceServers: RTCIceServer[]) => RTCPeerConnection;
  maxMs?: number;
};

export type ProbeResponder = {
  /** Answer one probe-offer through `send`. Malformed or surplus offers are dropped. */
  answer(offer: ProbeOffer, send: (msg: SignalMessage) => void): void;
  /** Close every open probe. */
  closeAll(): void;
};

/** Whether `offer` is a probe-offer this PC will answer. */
function wellFormed(offer: ProbeOffer): boolean {
  return (
    typeof offer.probeId === "string" &&
    offer.probeId.length > 0 &&
    offer.probeId.length <= 64 &&
    offer.sdp?.type === "offer" &&
    typeof offer.sdp.sdp === "string" &&
    offer.sdp.sdp.length <= MAX_OFFER_CHARS
  );
}

/** Resolve once `pc` has gathered its candidates, or after `ms`, whichever is first. */
function gathered(pc: RTCPeerConnection, ms: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, ms);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

/** The size of a data-channel message, in bytes. */
const sizeOf = (data: unknown): number =>
  typeof data === "string"
    ? new TextEncoder().encode(data).length
    : data instanceof ArrayBuffer
      ? data.byteLength
      : ArrayBuffer.isView(data)
        ? data.byteLength
        : data instanceof Blob
          ? data.size
          : Infinity;

export function createProbeResponder({
  iceServers,
  createPeer = (servers) => createPeerConnection({ iceServers: servers }),
  maxMs = PROBE_MAX_MS,
}: ProbeResponderOptions): ProbeResponder {
  const open = new Set<() => void>();

  const answer = (offer: ProbeOffer, send: (msg: SignalMessage) => void) => {
    if (!wellFormed(offer) || open.size >= MAX_OPEN_PROBES) return;
    const pc = createPeer(iceServers());
    let echoed = 0;
    const close = () => {
      if (!open.delete(close)) return;
      clearTimeout(timer);
      pc.close();
    };
    open.add(close);
    const timer = setTimeout(close, maxMs);

    pc.ondatachannel = ({ channel }) => {
      channel.binaryType = "arraybuffer";
      channel.onmessage = ({ data }) => {
        if (echoed >= MAX_PROBE_MESSAGES || sizeOf(data) > MAX_PROBE_MESSAGE_BYTES) return close();
        echoed++;
        if (channel.readyState === "open") channel.send(data);
      };
      channel.onclose = close;
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") close();
    };

    void (async () => {
      await pc.setRemoteDescription(offer.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc, GATHER_MS);
      if (!open.has(close) || !pc.localDescription) return;
      send({ type: "probe-answer", probeId: offer.probeId, sdp: pc.localDescription.toJSON() });
    })().catch((cause: unknown) => {
      console.warn(
        "[swiff] could not answer a latency probe:",
        cause instanceof Error ? cause.name : "error",
      );
      close();
    });
  };

  return {
    answer,
    closeAll: () => [...open].forEach((close) => close()),
  };
}
