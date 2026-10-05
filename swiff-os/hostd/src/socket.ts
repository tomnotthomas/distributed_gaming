// The machine-key socket: how the agent holds the room while the PC is offered
// and hears of a claim the moment it happens. The phase-1 `register` with the
// machine key (server/src/protocol.ts), kept open the way the host app keeps it:
//
//   open ──► register { hostId, key } ──► registered ... session-claimed
//     ▲                                        │
//   backoff ◄── close (not ours, not denied) ──┘
//
// A `denied` is final: the server hangs up after it and would refuse the same
// key again. The 25 s ping is not optional: Cloudflare closes an idle WebSocket
// after 100 seconds, and a PC waiting for its first renter sends nothing else.

import type { DeniedMessage, SessionClaimedMessage, SignalMessage } from "../../../server/src/protocol.ts";

export type SessionClaim = Omit<SessionClaimedMessage, "type">;

export type SocketEvent =
  | { type: "registered" }
  | { type: "claimed"; claim: SessionClaim }
  | { type: "denied"; reason: DeniedMessage["reason"] }
  /** The socket dropped and is being opened again. */
  | { type: "offline" };

export type MachineSocket = { close(): void };

export type MachineSocketOptions = {
  url: string;
  hostId: string;
  machineKey: string;
  onEvent: (event: SocketEvent) => void;
  pingMs?: number;
};

const PING_MS = 25_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;

export function openMachineSocket({
  url,
  hostId,
  machineKey,
  onEvent,
  pingMs = PING_MS,
}: MachineSocketOptions): MachineSocket {
  let socket: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let backoff = BACKOFF_MIN_MS;
  let over = false;

  const send = (msg: SignalMessage) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  };

  const open = () => {
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => {
      backoff = BACKOFF_MIN_MS;
      send({ type: "register", hostId, key: machineKey });
      pingTimer = setInterval(() => send({ type: "ping" }), pingMs);
    };
    ws.onmessage = (event) => {
      let msg: SignalMessage;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (over) return;
      if (msg.type === "registered") onEvent({ type: "registered" });
      else if (msg.type === "session-claimed") {
        onEvent({
          type: "claimed",
          claim: { sessionId: msg.sessionId, appid: msg.appid, minutes: msg.minutes },
        });
      } else if (msg.type === "denied") {
        over = true;
        onEvent({ type: "denied", reason: msg.reason });
      }
    };
    ws.onerror = () => {
      // A close always follows; it decides what happens next.
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      if (over) return;
      onEvent({ type: "offline" });
      retryTimer = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    };
  };

  open();

  return {
    close: () => {
      over = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      socket?.close();
    },
  };
}
