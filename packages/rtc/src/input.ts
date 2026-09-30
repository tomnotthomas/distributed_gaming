// The input protocol: mouse, keyboard and gamepad from the renter to the PC.
//
// Defined once, here, for both ends. The renter's browser encodes with it and
// the gaming PC decodes with it, so the Windows side never parses bytes itself:
// it feeds each message to `createInputReceiver` and replays what comes out.
//
// Two data channels, both created by the host (it makes the offer) so they are
// part of the first negotiation — phase 1 has no renegotiation path:
//
//   keys    reliable, ordered. Keys, buttons, wheel, controllers, releases and
//           the heartbeat. A lost key-up is exactly the failure this protocol
//           exists to prevent, and a key-up overtaking its key-down leaves the
//           key held.
//   motion  unordered, never retransmitted. Mouse motion, and nothing else. A
//           stale delta is worthless and a lost one is a nudge nobody notices,
//           while waiting for one would stall every movement queued behind it.
//
// Wire format: one binary message per event, little-endian, first byte the op.
//
//   op  message    body                                            bytes
//   1   move       u16 x, u16 y   0..65535 across the streamed screen  5
//   2   move-by    i16 dx, i16 dy  mouse counts, under pointer lock    5
//   3   button     u8 button, u8 down                                  3
//   4   wheel      i16 dx, i16 dy  1/120 of a notch, DOM direction     5
//   5   key        u8 down, u8 length, ASCII KeyboardEvent.code      3+n
//   6   gamepad    u8 index, u32 buttons, i16 ×4 axes, u8 ×2 triggers 16
//   7   release    u8 reason — let go of everything                    2
//   8   heartbeat  —                                                   1
//
// Keys travel as their physical code ("KeyW", "ShiftLeft"), not the character
// they type: a game binds to the key's position, and the renter's keyboard
// layout is not the PC's.

/** Set on both channels so a renter never speaks an older or newer protocol by accident. */
export const INPUT_PROTOCOL = "swiff-input/1";

export type InputLane = "keys" | "motion";

/** Channel label and settings per lane, for `createDataChannel`. */
export const INPUT_CHANNELS: Record<InputLane, { label: string; init: RTCDataChannelInit }> = {
  keys: { label: "input-keys", init: { ordered: true, protocol: INPUT_PROTOCOL } },
  motion: {
    label: "input-motion",
    init: { ordered: false, maxRetransmits: 0, protocol: INPUT_PROTOCOL },
  },
};

/** Which lane a message travels on. */
export function laneOf(msg: InputMessage): InputLane {
  return msg.type === "move" || msg.type === "move-by" ? "motion" : "keys";
}

/** The lane a channel label belongs to, or null if it is not an input channel. */
export function inputLane(label: string): InputLane | null {
  if (label === INPUT_CHANNELS.keys.label) return "keys";
  if (label === INPUT_CHANNELS.motion.label) return "motion";
  return null;
}

/** `MouseEvent.button`: left, middle, right, back, forward. */
export type MouseButton = 0 | 1 | 2 | 3 | 4;

/**
 * One controller, in the W3C "standard" gamepad layout.
 *
 * `buttons` is a bitmask of pressed buttons 0..16 in standard order (A, B, X,
 * Y, LB, RB, LT, RT, Back, Start, LS, RS, up, down, left, right, Guide).
 * Axes are left X, left Y, right X, right Y in -1..1; triggers are 0..1.
 */
export type GamepadState = {
  buttons: number;
  axes: [number, number, number, number];
  triggers: [number, number];
};

/** Why the renter let go of everything. */
export type ReleaseReason = "blur" | "hidden" | "unlock" | "disconnect";

export type InputMessage =
  | { type: "move"; x: number; y: number }
  | { type: "move-by"; dx: number; dy: number }
  | { type: "button"; button: MouseButton; down: boolean }
  | { type: "wheel"; dx: number; dy: number }
  | { type: "key"; code: string; down: boolean }
  | { type: "gamepad"; index: number; state: GamepadState }
  | { type: "release"; reason: ReleaseReason }
  | { type: "heartbeat" };

/** Four players is what XInput, and so almost every PC game, supports. */
export const MAX_GAMEPADS = 4;
/** Buttons 0..16 of the standard layout. */
export const GAMEPAD_BUTTONS = 17;
/** One wheel notch, in the units `wheel` carries — Windows' WHEEL_DELTA. */
export const WHEEL_NOTCH = 120;

export const NEUTRAL_GAMEPAD: GamepadState = { buttons: 0, axes: [0, 0, 0, 0], triggers: [0, 0] };

const OP = {
  move: 1,
  "move-by": 2,
  button: 3,
  wheel: 4,
  key: 5,
  gamepad: 6,
  release: 7,
  heartbeat: 8,
} as const;

// Wire order: append only.
const REASONS: ReleaseReason[] = ["blur", "hidden", "disconnect", "unlock"];

// Letters and digits only: every KeyboardEvent.code is, and anything else is
// either a bug or someone probing the PC's injector with garbage.
const KEY_CODE = /^[A-Za-z0-9]{1,32}$/;

export function isKeyCode(code: string): boolean {
  return KEY_CODE.test(code);
}

export function isNeutralGamepad(state: GamepadState): boolean {
  return state.buttons === 0 && state.axes.every((a) => a === 0) && state.triggers.every((t) => t === 0);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const i16 = (v: number) => clamp(Math.round(v), -32768, 32767);
const unit16 = (v: number) => Math.round(clamp(v, 0, 1) * 65535);
const axis16 = (v: number) => Math.round(clamp(v, -1, 1) * 32767);
const unit8 = (v: number) => Math.round(clamp(v, 0, 1) * 255);

export function encodeInput(msg: InputMessage): Uint8Array<ArrayBuffer> {
  switch (msg.type) {
    case "move": {
      const view = frame(5, OP.move);
      view.setUint16(1, unit16(msg.x), true);
      view.setUint16(3, unit16(msg.y), true);
      return bytes(view);
    }
    case "move-by":
    case "wheel": {
      const view = frame(5, OP[msg.type]);
      view.setInt16(1, i16(msg.dx), true);
      view.setInt16(3, i16(msg.dy), true);
      return bytes(view);
    }
    case "button": {
      const view = frame(3, OP.button);
      view.setUint8(1, msg.button);
      view.setUint8(2, msg.down ? 1 : 0);
      return bytes(view);
    }
    case "key": {
      if (!isKeyCode(msg.code)) throw new RangeError(`not a key code: ${JSON.stringify(msg.code)}`);
      const view = frame(3 + msg.code.length, OP.key);
      view.setUint8(1, msg.down ? 1 : 0);
      view.setUint8(2, msg.code.length);
      for (let i = 0; i < msg.code.length; i++) view.setUint8(3 + i, msg.code.charCodeAt(i));
      return bytes(view);
    }
    case "gamepad": {
      if (!(msg.index >= 0 && msg.index < MAX_GAMEPADS)) throw new RangeError(`no gamepad slot ${msg.index}`);
      const view = frame(16, OP.gamepad);
      view.setUint8(1, msg.index);
      view.setUint32(2, msg.state.buttons & ((1 << GAMEPAD_BUTTONS) - 1), true);
      msg.state.axes.forEach((a, i) => view.setInt16(6 + i * 2, axis16(a), true));
      view.setUint8(14, unit8(msg.state.triggers[0]));
      view.setUint8(15, unit8(msg.state.triggers[1]));
      return bytes(view);
    }
    case "release": {
      const view = frame(2, OP.release);
      view.setUint8(1, REASONS.indexOf(msg.reason));
      return bytes(view);
    }
    case "heartbeat":
      return Uint8Array.of(OP.heartbeat);
  }
}

/**
 * Decode one message, or null if it is not a well-formed one.
 *
 * Never throws: the PC runs this on bytes from a stranger, and a malformed
 * message must cost that message, not the session.
 */
export function decodeInput(data: ArrayBuffer | ArrayBufferView): InputMessage | null {
  const view =
    data instanceof ArrayBuffer
      ? new DataView(data)
      : new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.byteLength < 1) return null;
  const length = view.byteLength;

  switch (view.getUint8(0)) {
    case OP.move:
      if (length !== 5) return null;
      return { type: "move", x: view.getUint16(1, true) / 65535, y: view.getUint16(3, true) / 65535 };
    case OP["move-by"]:
      if (length !== 5) return null;
      return { type: "move-by", dx: view.getInt16(1, true), dy: view.getInt16(3, true) };
    case OP.wheel:
      if (length !== 5) return null;
      return { type: "wheel", dx: view.getInt16(1, true), dy: view.getInt16(3, true) };
    case OP.button: {
      if (length !== 3) return null;
      const button = view.getUint8(1);
      const down = view.getUint8(2);
      if (button > 4 || down > 1) return null;
      return { type: "button", button: button as MouseButton, down: down === 1 };
    }
    case OP.key: {
      if (length < 3) return null;
      const down = view.getUint8(1);
      const size = view.getUint8(2);
      if (down > 1 || length !== 3 + size) return null;
      let code = "";
      for (let i = 0; i < size; i++) code += String.fromCharCode(view.getUint8(3 + i));
      if (!isKeyCode(code)) return null;
      return { type: "key", code, down: down === 1 };
    }
    case OP.gamepad: {
      if (length !== 16) return null;
      const index = view.getUint8(1);
      const buttons = view.getUint32(2, true);
      if (index >= MAX_GAMEPADS || buttons >= 1 << GAMEPAD_BUTTONS) return null;
      const axis = (i: number) => Math.max(-1, view.getInt16(6 + i * 2, true) / 32767);
      return {
        type: "gamepad",
        index,
        state: {
          buttons,
          axes: [axis(0), axis(1), axis(2), axis(3)],
          triggers: [view.getUint8(14) / 255, view.getUint8(15) / 255],
        },
      };
    }
    case OP.release: {
      if (length !== 2) return null;
      const reason = REASONS[view.getUint8(1)];
      return reason ? { type: "release", reason } : null;
    }
    case OP.heartbeat:
      return length === 1 ? { type: "heartbeat" } : null;
    default:
      return null;
  }
}

function frame(size: number, op: number): DataView<ArrayBuffer> {
  const view = new DataView(new ArrayBuffer(size));
  view.setUint8(0, op);
  return view;
}

function bytes(view: DataView<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return new Uint8Array(view.buffer);
}
