// The renter's input as Linux input events, for the virtual devices
// helpers/swiff-uinput.py creates.
//
// This is the InputSink of @swiff/rtc's input receiver: the receiver decides
// what is held and when to let go, and this only translates. Each call becomes
// one batch of events ending in SYN_REPORT, written to the helper as fixed
// records:
//
//   u8 device, u16 type, u16 code, i32 value   (little-endian, 9 bytes)
//
// Devices, as the helper numbers them:
//
//   0      keyboard          only the keys keymap.ts maps
//   1      mouse             relative motion, five buttons, wheels
//   2      absolute pointer  0..65535 across the screen, for a renter without pointer lock
//   3..6   controllers 0..3  Xbox 360 layout, created on first use

import { MAX_GAMEPADS, type GamepadState, type InputSink, type MouseButton } from "@swiff/rtc";
import { linuxKey } from "./keymap";

export const DEVICE = { keyboard: 0, mouse: 1, pointer: 2, gamepad0: 3 } as const;
export const RECORD_BYTES = 9;

// linux/input-event-codes.h
const EV_SYN = 0;
const EV_KEY = 1;
const EV_REL = 2;
const EV_ABS = 3;
const SYN_REPORT = 0;
const REL_X = 0;
const REL_Y = 1;
const REL_HWHEEL = 6;
const REL_WHEEL = 8;
const REL_WHEEL_HI_RES = 11;
const REL_HWHEEL_HI_RES = 12;
const ABS_X = 0;
const ABS_Y = 1;
const ABS_Z = 2;
const ABS_RX = 3;
const ABS_RY = 4;
const ABS_RZ = 5;
const ABS_HAT0X = 16;
const ABS_HAT0Y = 17;

/** MouseEvent.button to BTN_LEFT, BTN_MIDDLE, BTN_RIGHT, BTN_SIDE, BTN_EXTRA. */
const MOUSE_BUTTONS: Record<MouseButton, number> = { 0: 0x110, 1: 0x112, 2: 0x111, 3: 0x113, 4: 0x114 };

/**
 * Standard-layout buttons with a key of their own, by bit: A, B, X, Y, LB, RB,
 * Back, Start, LS, RS, Guide. LT and RT (6, 7) are the analogue triggers and the
 * d-pad (12–15) is the hat, as on an Xbox 360 pad under xpad.
 */
const PAD_BUTTONS: [bit: number, code: number][] = [
  [0, 0x130], // BTN_SOUTH
  [1, 0x131], // BTN_EAST
  [2, 0x133], // BTN_NORTH, xpad's BTN_X
  [3, 0x134], // BTN_WEST, xpad's BTN_Y
  [4, 0x136], // BTN_TL
  [5, 0x137], // BTN_TR
  [8, 0x13a], // BTN_SELECT
  [9, 0x13b], // BTN_START
  [10, 0x13d], // BTN_THUMBL
  [11, 0x13e], // BTN_THUMBR
  [16, 0x13c], // BTN_MODE
];

export const ABS_MAX = 65535;
const STICK_MAX = 32767;
const TRIGGER_MAX = 255;
const NOTCH = 120;

const CTRL = ["ControlLeft", "ControlRight"];
const ALT = ["AltLeft", "AltRight"];
const F_KEYS = new Set(Array.from({ length: 24 }, (_, i) => `F${i + 1}`));

/**
 * Whether pressing `code` with `held` down would act on the PC rather than the
 * game, as the kernel's default keymap has it: Ctrl+Alt+Delete reboots, and
 * Alt+F<n>, Ctrl+Alt+F<n> and Alt+Left/Right switch the virtual console.
 */
function actsOnPc(code: string, held: ReadonlySet<string>): boolean {
  const alt = ALT.some((k) => held.has(k));
  if (!alt) return false;
  if (code === "Delete" || code === "NumpadDecimal") return CTRL.some((k) => held.has(k));
  return F_KEYS.has(code) || code === "ArrowLeft" || code === "ArrowRight";
}

type Event = [device: number, type: number, code: number, value: number];

/** Pack events into the helper's records. */
export function encodeRecords(events: Event[]): Buffer {
  const buf = Buffer.alloc(events.length * RECORD_BYTES);
  events.forEach(([device, type, code, value], i) => {
    const at = i * RECORD_BYTES;
    buf.writeUInt8(device, at);
    buf.writeUInt16LE(type, at + 1);
    buf.writeUInt16LE(code, at + 3);
    buf.writeInt32LE(value, at + 5);
  });
  return buf;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const bit = (mask: number, n: number) => (mask >>> n) & 1;

/** The sink, plus what the helper's pipe tells it. */
export type UinputSink = InputSink & {
  /** The helper has taken everything written: catch it up on what changed meanwhile. */
  drained(): void;
  /** The helper was started again with fresh devices, on which nothing is pressed. */
  reset(): void;
};

/**
 * An InputSink that writes each call to the helper as one batch of records.
 *
 * `write` returns false when the helper's pipe is full (Node's backpressure).
 * From then until `drained`, nothing more is written: a renter sending faster
 * than the helper reads must not grow the streamer's memory. The sink keeps
 * the state the devices should be in instead — keys and buttons held, the
 * pointer's position, each controller — and on `drained` writes only what
 * differs, so every release still lands. Relative motion and wheel steps from
 * that interval are dropped: they are stale by the time the pipe clears.
 */
export function createUinputSink(write: (records: Buffer) => boolean): UinputSink {
  // Wheel travel below a whole notch, per axis, carried into the next event so
  // a touchpad's small steps add up to notches for games that count only those.
  let restX = 0;
  let restY = 0;
  // Keys whose press was sent, and keys whose press was dropped as acting on
  // the PC; a dropped press drops its release too.
  const held = new Set<string>();
  const dropped = new Set<string>();

  let blocked = false;
  // [device, code] pairs as "device:code": what should be pressed, and what the helper was told.
  const wanted = new Set<string>();
  const written = new Set<string>();
  let pointer: [number, number] | null = null;
  const pads = new Map<number, GamepadState>();
  const padsPending = new Set<number>();

  const emit = (device: number, events: [type: number, code: number, value: number][]) => {
    if (!events.length) return;
    const records = encodeRecords([...events, [EV_SYN, SYN_REPORT, 0]].map((e) => [device, ...e] as Event));
    if (!write(records)) blocked = true;
  };

  /** A key or button: remembered always, written now unless the pipe is full. */
  const press = (device: number, code: number, down: boolean) => {
    const id = `${device}:${code}`;
    if (down) wanted.add(id);
    else wanted.delete(id);
    if (blocked) return;
    if (down) written.add(id);
    else written.delete(id);
    emit(device, [[EV_KEY, code, down ? 1 : 0]]);
  };

  const catchUp = () => {
    blocked = false;
    // A bounded diff (at most every mapped key, five buttons, the pointer and four
    // controllers), written in full even if the pipe fills again on the way.
    for (const id of [...written].filter((id) => !wanted.has(id))) {
      const [device, code] = id.split(":").map(Number) as [number, number];
      written.delete(id);
      emit(device, [[EV_KEY, code, 0]]);
    }
    for (const id of [...wanted].filter((id) => !written.has(id))) {
      const [device, code] = id.split(":").map(Number) as [number, number];
      written.add(id);
      emit(device, [[EV_KEY, code, 1]]);
    }
    if (pointer) emit(DEVICE.pointer, pointerEvents(...pointer));
    pointer = null;
    for (const index of padsPending) emit(DEVICE.gamepad0 + index, gamepadEvents(pads.get(index)!));
    padsPending.clear();
  };

  return {
    move(x, y) {
      if (blocked) pointer = [x, y];
      else emit(DEVICE.pointer, pointerEvents(x, y));
    },
    moveBy(dx, dy) {
      if (blocked) return;
      const events: [number, number, number][] = [];
      if (dx) events.push([EV_REL, REL_X, Math.trunc(dx)]);
      if (dy) events.push([EV_REL, REL_Y, Math.trunc(dy)]);
      emit(DEVICE.mouse, events);
    },
    wheel(dx, dy) {
      if (blocked) return;
      // The DOM's positive dy is down; Linux's positive wheel is up.
      const events: [number, number, number][] = [];
      if (dy) {
        events.push([EV_REL, REL_WHEEL_HI_RES, -Math.trunc(dy)]);
        restY -= dy;
        const notches = Math.trunc(restY / NOTCH);
        if (notches) events.push([EV_REL, REL_WHEEL, notches]);
        restY -= notches * NOTCH;
      }
      if (dx) {
        events.push([EV_REL, REL_HWHEEL_HI_RES, Math.trunc(dx)]);
        restX += dx;
        const notches = Math.trunc(restX / NOTCH);
        if (notches) events.push([EV_REL, REL_HWHEEL, notches]);
        restX -= notches * NOTCH;
      }
      emit(DEVICE.mouse, events);
    },
    button(button, down) {
      press(DEVICE.mouse, MOUSE_BUTTONS[button], down);
    },
    key(code, down) {
      const key = linuxKey(code);
      if (key === null) return;
      if (down) {
        if (dropped.has(code)) return;
        if (!held.has(code) && actsOnPc(code, held)) {
          dropped.add(code);
          return;
        }
        held.add(code);
      } else {
        if (dropped.delete(code)) return;
        held.delete(code);
      }
      press(DEVICE.keyboard, key, down);
    },
    gamepad(index, state) {
      if (!Number.isInteger(index) || index < 0 || index >= MAX_GAMEPADS) return;
      pads.set(index, state);
      if (blocked) padsPending.add(index);
      else emit(DEVICE.gamepad0 + index, gamepadEvents(state));
    },
    drained() {
      if (blocked) catchUp();
    },
    reset() {
      // Fresh devices: press again what the renter still holds, and restore each controller.
      written.clear();
      for (const index of pads.keys()) padsPending.add(index);
      catchUp();
    },
  };
}

function pointerEvents(x: number, y: number): [number, number, number][] {
  return [
    [EV_ABS, ABS_X, Math.round(clamp(x, 0, 1) * ABS_MAX)],
    [EV_ABS, ABS_Y, Math.round(clamp(y, 0, 1) * ABS_MAX)],
  ];
}

/** The whole controller as events. The kernel drops the ones that did not change. */
function gamepadEvents({ buttons, axes, triggers }: GamepadState): [number, number, number][] {
  const stick = (v: number) => Math.round(clamp(v, -1, 1) * STICK_MAX);
  const trigger = (v: number) => Math.round(clamp(v, 0, 1) * TRIGGER_MAX);
  return [
    ...PAD_BUTTONS.map(([n, code]): [number, number, number] => [EV_KEY, code, bit(buttons, n)]),
    [EV_ABS, ABS_X, stick(axes[0])],
    [EV_ABS, ABS_Y, stick(axes[1])],
    [EV_ABS, ABS_RX, stick(axes[2])],
    [EV_ABS, ABS_RY, stick(axes[3])],
    [EV_ABS, ABS_Z, trigger(triggers[0])],
    [EV_ABS, ABS_RZ, trigger(triggers[1])],
    [EV_ABS, ABS_HAT0X, bit(buttons, 15) - bit(buttons, 14)],
    [EV_ABS, ABS_HAT0Y, bit(buttons, 13) - bit(buttons, 12)],
  ];
}
