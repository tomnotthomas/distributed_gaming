// Test doubles: a sink that writes down everything the PC would have done, a
// data channel that delivers straight to a receiver, and a WebSocket a test
// opens, feeds and drops by hand.

import type { GamepadState, MouseButton } from "../input";
import type { InputChannelLike, InputSink } from "../inputReceiver";
import type { SignalMessage } from "../signaling";

export type SinkEvent =
  | { kind: "key"; code: string; down: boolean }
  | { kind: "button"; button: MouseButton; down: boolean }
  | { kind: "gamepad"; index: number; state: GamepadState }
  | { kind: "move"; x: number; y: number }
  | { kind: "moveBy"; dx: number; dy: number }
  | { kind: "wheel"; dx: number; dy: number };

/** The fake PC: records every event instead of injecting it. */
export function recordingSink(): InputSink & { events: SinkEvent[] } {
  const events: SinkEvent[] = [];
  return {
    events,
    move: (x, y) => events.push({ kind: "move", x, y }),
    moveBy: (dx, dy) => events.push({ kind: "moveBy", dx, dy }),
    wheel: (dx, dy) => events.push({ kind: "wheel", dx, dy }),
    button: (button, down) => events.push({ kind: "button", button, down }),
    key: (code, down) => events.push({ kind: "key", code, down }),
    gamepad: (index, state) => events.push({ kind: "gamepad", index, state }),
  };
}

/**
 * Checks the one promise the input path makes: every down is followed by
 * exactly one up, never an up without a down, and nothing is held at the end.
 * Throws on the first violation with the offending position.
 */
export function assertEveryPressReleased(events: SinkEvent[]): void {
  const held = new Set<string>();
  events.forEach((event, i) => {
    let id: string;
    let down: boolean;
    if (event.kind === "key") [id, down] = [`key:${event.code}`, event.down];
    else if (event.kind === "button") [id, down] = [`button:${event.button}`, event.down];
    else if (event.kind === "gamepad") {
      const s = event.state;
      const neutral = s.buttons === 0 && s.axes.every((a) => a === 0) && s.triggers.every((t) => t === 0);
      // A controller is "down" from its first non-neutral state to a neutral one.
      id = `pad:${event.index}`;
      if (!neutral) {
        held.add(id);
        return;
      }
      down = false;
    } else return;

    if (down) {
      if (held.has(id)) throw new Error(`event ${i}: ${id} pressed twice without a release`);
      held.add(id);
    } else {
      if (!held.has(id)) throw new Error(`event ${i}: ${id} released without being pressed`);
      held.delete(id);
    }
  });
  if (held.size) throw new Error(`still held at the end: ${[...held].join(", ")}`);
}

type Listener = (event: Event) => void;

/**
 * One data channel, both ends: `send` on the renter's side lands as a
 * `message` on the PC's side, synchronously, as a copy — as a real channel
 * would deliver it.
 */
export function loopbackChannel() {
  const listeners = new Map<string, Set<Listener>>();
  const fire = (type: string, event: Event) => listeners.get(type)?.forEach((fn) => fn(event));
  const sent: Uint8Array[] = [];

  const channel = {
    readyState: "open" as RTCDataChannelState,
    binaryType: "blob" as BinaryType,
    /** Set by a test to play a congested link. */
    bufferedAmount: 0,
    send(data: Uint8Array<ArrayBuffer>) {
      if (channel.readyState !== "open") throw new Error("send on a channel that is not open");
      sent.push(data.slice());
      fire("message", new MessageEvent("message", { data: data.slice().buffer }));
    },
    addEventListener(type: string, fn: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn);
    },
    /** The connection dropped: nothing more gets through, and both ends see `close`. */
    drop() {
      channel.readyState = "closed";
      fire("close", new Event("close"));
    },
    sent,
  };
  return channel satisfies InputChannelLike & { send(data: Uint8Array<ArrayBuffer>): void };
}

/** Minimal stand-in for the browser WebSocket, with the hooks a test needs. */
export class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closeCalls = 0;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = FakeSocket.CLOSED;
  }

  // --- test helpers ---
  accept() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(msg: unknown) {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }

  drop() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  get messages(): SignalMessage[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}
