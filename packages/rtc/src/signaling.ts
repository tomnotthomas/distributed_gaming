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
// A `denied` is final: the server hangs up after it, and the same credential
// would be refused again, so the client stops instead of retrying forever.
//
// The 25s ping is not optional: Cloudflare closes an idle WebSocket after 100
// seconds, and a host waiting for its first renter sends nothing at all. Its
// pong is how this side knows the socket still reaches the server: one that
// has heard nothing for two rounds is half-open (a sleep, a NAT that forgot
// it) and is dropped and opened again rather than waited on.

// The wire format lives with the server that relays it — one definition, so a
// protocol change cannot land on one side only. Type-only import: nothing from
// the server package ends up in the browser bundle.
export type { SignalMessage } from "../../../server/src/protocol";
import type { SignalMessage } from "../../../server/src/protocol";

const PING_MS = 25_000;
/** Silence past this, with a ping out every round, is a socket that no longer reaches the server. */
const SILENT_MS = 2 * PING_MS + 5_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;

export type SignalingOptions = {
  /** ws:// or wss:// origin of the signaling server. The Electron host cannot
   *  derive this from `location`, so every caller passes it in. */
  url: string;
  onOpen: (send: (msg: SignalMessage) => void) => void;
  onMessage: (msg: SignalMessage, send: (msg: SignalMessage) => void) => void;
  onStatus?: (status: "connecting" | "open" | "closed") => void;
};

export type Signaling = {
  send: (msg: SignalMessage) => void;
  close: () => void;
};

export function connectSignaling({ url, onOpen, onMessage, onStatus }: SignalingOptions): Signaling {
  let socket: WebSocket | null = null;
  let pingTimer: number | undefined;
  let retryTimer: number | undefined;
  let backoff = BACKOFF_MIN_MS;
  let closedByUs = false;
  let denied = false;

  const send = (msg: SignalMessage) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  };

  const open = () => {
    onStatus?.("connecting");
    socket = new WebSocket(url);
    let heardAt = Date.now();

    socket.onopen = () => {
      backoff = BACKOFF_MIN_MS;
      heardAt = Date.now();
      onStatus?.("open");
      onOpen(send);
      pingTimer = window.setInterval(() => {
        if (Date.now() - heardAt > SILENT_MS) return drop();
        send({ type: "ping" });
      }, PING_MS);
    };

    socket.onmessage = (event) => {
      heardAt = Date.now();
      let msg: SignalMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "pong") return;
      if (msg.type === "denied") denied = true;
      onMessage(msg, send);
    };

    socket.onclose = closed;
  };

  /** The socket is gone: try again after the backoff, unless it was closed or refused for good. */
  const closed = () => {
    window.clearInterval(pingTimer);
    onStatus?.("closed");
    if (closedByUs || denied) return;
    retryTimer = window.setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  };

  /** Give up on a socket that has gone quiet: a half-open one may take minutes to report its close. */
  const drop = () => {
    const quiet = socket;
    if (!quiet) return;
    quiet.onopen = quiet.onmessage = quiet.onclose = null;
    quiet.close();
    closed();
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
