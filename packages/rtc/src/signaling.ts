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
// it) and is dropped and opened again rather than waited on. With `onRtt`, each
// ping is also timed to its pong, the round trip to the server, and a few
// more go out in the first seconds so the first figures come quickly.

// The wire format lives with the server that relays it — one definition, so a
// protocol change cannot land on one side only. Type-only import: nothing from
// the server package ends up in the browser bundle.
export type { SignalMessage, VoicePerson } from "../../../server/src/protocol";
import type { SignalMessage } from "../../../server/src/protocol";

const PING_MS = 25_000;
/** Silence past this, with a ping out every round, is a socket that no longer reaches the server. */
const SILENT_MS = 2 * PING_MS + 5_000;
/** Pings sent one a second after the socket opens, for the first round trips. */
const RTT_BURST = 3;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;

export type SignalingOptions = {
  /** ws:// or wss:// origin of the signaling server. The Electron host cannot
   *  derive this from `location`, so every caller passes it in. */
  url: string;
  onOpen: (send: (msg: SignalMessage) => void) => void;
  onMessage: (msg: SignalMessage, send: (msg: SignalMessage) => void) => void;
  onStatus?: (status: "connecting" | "open" | "closed") => void;
  /** Each ping's round trip to the server, in ms. */
  onRtt?: (ms: number) => void;
};

export type Signaling = {
  send: (msg: SignalMessage) => void;
  close: () => void;
};

/**
 * Open the signaling socket at `url` and keep it open: it reconnects with
 * backoff until closed or denied, and pings the server so a half-open socket is
 * noticed (and, with `onRtt`, each round trip timed).
 */
export function connectSignaling({ url, onOpen, onMessage, onStatus, onRtt }: SignalingOptions): Signaling {
  let socket: WebSocket | null = null;
  // Bare timers, not window's: the Swiff OS streamer runs this in Node.
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let burstTimers: ReturnType<typeof setTimeout>[] = [];
  /** When the ping awaiting its pong went out. One is timed at a time, so each pong is matched. */
  let pingAt: number | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let backoff = BACKOFF_MIN_MS;
  let closedByUs = false;
  let denied = false;

  /** Send `msg` on the open socket; dropped while it is not open. */
  const send = (msg: SignalMessage) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  };

  /** Ping the server, timing the round trip when none is awaited. */
  const ping = () => {
    if (onRtt && pingAt === null) pingAt = performance.now();
    send({ type: "ping" });
  };

  /** Stop pinging the socket that was open. */
  const stopPinging = () => {
    clearInterval(pingTimer);
    burstTimers.forEach((timer) => clearTimeout(timer));
    burstTimers = [];
    pingAt = null;
  };

  /** Open a socket and wire its events; its close goes to `closed`. */
  const open = () => {
    onStatus?.("connecting");
    socket = new WebSocket(url);
    let heardAt = Date.now();

    socket.onopen = () => {
      backoff = BACKOFF_MIN_MS;
      heardAt = Date.now();
      onStatus?.("open");
      onOpen(send);
      pingTimer = setInterval(() => {
        if (Date.now() - heardAt > SILENT_MS) return drop();
        ping();
      }, PING_MS);
      if (onRtt) {
        for (let i = 1; i <= RTT_BURST; i++) burstTimers.push(setTimeout(ping, i * 1_000));
      }
    };

    socket.onmessage = (event) => {
      heardAt = Date.now();
      let msg: SignalMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "pong") {
        if (pingAt !== null) onRtt?.(performance.now() - pingAt);
        pingAt = null;
        return;
      }
      if (msg.type === "denied") denied = true;
      onMessage(msg, send);
    };

    socket.onclose = closed;
  };

  /** The socket is gone: try again after the backoff, unless it was closed or refused for good. */
  const closed = () => {
    stopPinging();
    onStatus?.("closed");
    if (closedByUs || denied) return;
    retryTimer = setTimeout(open, backoff);
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
      stopPinging();
      clearTimeout(retryTimer);
      socket?.close();
    },
  };
}
