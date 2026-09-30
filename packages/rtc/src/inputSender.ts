// The renter's end of the input channel, minus the DOM.
//
// It mirrors the receiver: it remembers every key, button and controller it
// has reported down, so it can report each one up again. `releaseAll` sends
// those key-ups explicitly and then a `release` message, so the PC lets go even
// if the two sides somehow disagree about what is held. And while it is open it
// sends a heartbeat, which is how the PC tells a renter holding a key still
// from a renter who is gone.

import {
  encodeInput,
  isKeyCode,
  laneOf,
  MAX_GAMEPADS,
  NEUTRAL_GAMEPAD,
  type GamepadState,
  type InputLane,
  type InputMessage,
  type MouseButton,
  type ReleaseReason,
} from "./input";

export type InputSender = {
  move(x: number, y: number): void;
  moveBy(dx: number, dy: number): void;
  wheel(dx: number, dy: number): void;
  button(button: MouseButton, down: boolean): void;
  key(code: string, down: boolean): void;
  /** The controller's state, or null when it disconnected. */
  gamepad(index: number, state: GamepadState | null): void;
  /** Report everything held as released, then tell the PC to let go. */
  releaseAll(reason: ReleaseReason): void;
  /** Release everything and stop the heartbeat. Nothing is sent after this. */
  close(): void;
};

/** A quarter of the receiver's default timeout: three can go missing first. */
export const DEFAULT_HEARTBEAT_MS = 250;

/**
 * Create a sender that encodes input onto its lane and sends periodic heartbeats.
 * Tracks held input and suppresses duplicate states; close releases everything
 * before stopping the heartbeat and preventing further sends.
 */
export function createInputSender(
  send: (bytes: Uint8Array<ArrayBuffer>, lane: InputLane) => void,
  { heartbeatMs = DEFAULT_HEARTBEAT_MS }: { heartbeatMs?: number } = {},
): InputSender {
  const keys = new Set<string>();
  const buttons = new Set<MouseButton>();
  // The last state sent per controller, so an unchanged poll sends nothing.
  const pads = new Map<number, string>();
  let closed = false;

  const post = (msg: InputMessage) => {
    if (!closed) send(encodeInput(msg), laneOf(msg));
  };
  const heartbeat = setInterval(() => post({ type: "heartbeat" }), heartbeatMs);

  const releaseAll = (reason: ReleaseReason) => {
    for (const code of keys) post({ type: "key", code, down: false });
    for (const button of buttons) post({ type: "button", button, down: false });
    for (const [index, last] of pads) {
      if (last !== NEUTRAL) post({ type: "gamepad", index, state: NEUTRAL_GAMEPAD });
    }
    keys.clear();
    buttons.clear();
    pads.clear();
    post({ type: "release", reason });
  };

  return {
    move: (x, y) => post({ type: "move", x, y }),
    moveBy: (dx, dy) => {
      if (dx || dy) post({ type: "move-by", dx, dy });
    },
    wheel: (dx, dy) => {
      if (dx || dy) post({ type: "wheel", dx, dy });
    },
    button(button, down) {
      if (closed || down === buttons.has(button)) return;
      if (down) buttons.add(button);
      else buttons.delete(button);
      post({ type: "button", button, down });
    },
    key(code, down) {
      // Some keys have no code (an IME, an on-screen keyboard); they have no
      // physical position to press on the PC either.
      if (closed || !isKeyCode(code) || down === keys.has(code)) return;
      if (down) keys.add(code);
      else keys.delete(code);
      post({ type: "key", code, down });
    },
    gamepad(index, state) {
      if (closed || index < 0 || index >= MAX_GAMEPADS) return;
      const next = state ?? NEUTRAL_GAMEPAD;
      const key = stateKey(next);
      if ((pads.get(index) ?? NEUTRAL) === key) {
        if (!state) pads.delete(index);
        return;
      }
      if (state) pads.set(index, key);
      else pads.delete(index);
      post({ type: "gamepad", index, state: next });
    },
    releaseAll: (reason) => {
      if (!closed) releaseAll(reason);
    },
    close() {
      if (closed) return;
      try {
        releaseAll("disconnect");
      } catch {
        // Best effort: the channel may already be gone.
      } finally {
        closed = true;
        clearInterval(heartbeat);
      }
    },
  };
}

/**
 * Compared as encoded bytes: two states that quantise to the same message are
 * the same state as far as the PC can ever tell.
 */
function stateKey(state: GamepadState): string {
  return encodeInput({ type: "gamepad", index: 0, state }).join(",");
}

const NEUTRAL = stateKey(NEUTRAL_GAMEPAD);
