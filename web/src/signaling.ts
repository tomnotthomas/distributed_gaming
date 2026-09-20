// One WebSocket client, used by both peers.
//
// The host and the renter differ only in the message they send on open
// (register vs join), so everything else lives here rather than being written
// twice.
//
//   connect() ──► open ──► onOpen() sends register/join
//        ▲                      │
//        │                  onMessage(msg)
//        │                      │
//   backoff timer ◄── close ────┘
//
// The 25s ping is not optional: Cloudflare closes an idle WebSocket after 100
// seconds, and a host waiting for its first renter sends nothing at all.

import { SIGNALING_URL } from "./config";

const PING_MS = 25_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;

export type SignalMessage = {
  type: string;
  hostId?: string;
  hostOnline?: boolean;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

export type SignalingOptions = {
  onOpen: (send: (msg: SignalMessage) => void) => void;
  onMessage: (msg: SignalMessage, send: (msg: SignalMessage) => void) => void;
  onStatus?: (status: "connecting" | "open" | "closed") => void;
};

export type Signaling = {
  send: (msg: SignalMessage) => void;
  close: () => void;
};

export function connectSignaling({ onOpen, onMessage, onStatus }: SignalingOptions): Signaling {
  let socket: WebSocket | null = null;
  let pingTimer: number | undefined;
  let retryTimer: number | undefined;
  let backoff = BACKOFF_MIN_MS;
  let closedByUs = false;

  const send = (msg: SignalMessage) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  };

  const open = () => {
    onStatus?.("connecting");
    socket = new WebSocket(SIGNALING_URL);

    socket.onopen = () => {
      backoff = BACKOFF_MIN_MS;
      onStatus?.("open");
      onOpen(send);
      pingTimer = window.setInterval(() => send({ type: "ping" }), PING_MS);
    };

    socket.onmessage = (event) => {
      let msg: SignalMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "pong") return;
      onMessage(msg, send);
    };

    socket.onclose = () => {
      window.clearInterval(pingTimer);
      onStatus?.("closed");
      if (closedByUs) return;
      retryTimer = window.setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    };
  };

  open();

  return {
    send,
    close: () => {
      closedByUs = true;
      window.clearInterval(pingTimer);
      window.clearTimeout(retryTimer);
      socket?.close();
    },
  };
}
