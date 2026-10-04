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

/** An InputSink that writes each call to the helper as one batch of records. */
export function createUinputSink(write: (records: Buffer) => void): InputSink {
  // Wheel travel below a whole notch, per axis, carried into the next event so
  // a touchpad's small steps add up to notches for games that count only those.
  let restX = 0;
  let restY = 0;

  const emit = (device: number, events: [type: number, code: number, value: number][]) => {
    if (!events.length) return;
    write(encodeRecords([...events, [EV_SYN, SYN_REPORT, 0]].map((e) => [device, ...e] as Event)));
  };

  return {
    move(x, y) {
      emit(DEVICE.pointer, [
        [EV_ABS, ABS_X, Math.round(clamp(x, 0, 1) * ABS_MAX)],
        [EV_ABS, ABS_Y, Math.round(clamp(y, 0, 1) * ABS_MAX)],
      ]);
    },
    moveBy(dx, dy) {
      const events: [number, number, number][] = [];
      if (dx) events.push([EV_REL, REL_X, Math.trunc(dx)]);
      if (dy) events.push([EV_REL, REL_Y, Math.trunc(dy)]);
      emit(DEVICE.mouse, events);
    },
    wheel(dx, dy) {
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
      emit(DEVICE.mouse, [[EV_KEY, MOUSE_BUTTONS[button], down ? 1 : 0]]);
    },
    key(code, down) {
      const key = linuxKey(code);
      if (key !== null) emit(DEVICE.keyboard, [[EV_KEY, key, down ? 1 : 0]]);
    },
    gamepad(index, state) {
      if (!Number.isInteger(index) || index < 0 || index >= MAX_GAMEPADS) return;
      emit(DEVICE.gamepad0 + index, gamepadEvents(state));
    },
  };
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
