// The input wire format. Both ends run this one module, so what is pinned here
// is that a message survives the trip, stays small, and that bytes from a
// stranger can never crash the PC's decoder.

import { describe, expect, it } from "vitest";
import {
  decodeInput,
  encodeInput,
  INPUT_CHANNELS,
  INPUT_PROTOCOL,
  inputLane,
  laneOf,
  NEUTRAL_GAMEPAD,
  type InputMessage,
} from "./input";

const roundTrip = (msg: InputMessage) => decodeInput(encodeInput(msg));

describe("input encoding", () => {
  it.each<InputMessage>([
    { type: "move-by", dx: -12, dy: 340 },
    { type: "wheel", dx: 0, dy: -240 },
    { type: "button", button: 0, down: true },
    { type: "button", button: 4, down: false },
    { type: "key", code: "KeyW", down: true },
    { type: "key", code: "ShiftLeft", down: false },
    { type: "key", code: "NumpadEnter", down: true },
    { type: "release", reason: "blur" },
    { type: "release", reason: "hidden" },
    { type: "release", reason: "unlock" },
    { type: "release", reason: "disconnect" },
    { type: "heartbeat" },
    { type: "gamepad", index: 3, state: NEUTRAL_GAMEPAD },
    {
      type: "gamepad",
      index: 0,
      state: { buttons: 0b1_0000_0000_0000_0001, axes: [1, -1, 0, 0], triggers: [1, 0] },
    },
  ])("round-trips $type exactly: %o", (msg) => {
    expect(roundTrip(msg)).toEqual(msg);
  });

  it("round-trips an absolute position to within one step of 1/65535", () => {
    const back = roundTrip({ type: "move", x: 0.25, y: 0.8125 });
    expect(back?.type).toBe("move");
    if (back?.type !== "move") return;
    expect(back.x).toBeCloseTo(0.25, 4);
    expect(back.y).toBeCloseTo(0.8125, 4);
  });

  it("round-trips analogue sticks and triggers to within their resolution", () => {
    const state = { buttons: 0b1010, axes: [0.5, -0.25, 0.1, -0.9], triggers: [0.5, 0.2] } as const;
    const back = roundTrip({
      type: "gamepad",
      index: 1,
      state: { ...state, axes: [...state.axes], triggers: [...state.triggers] },
    });
    if (back?.type !== "gamepad") throw new Error(`decoded ${JSON.stringify(back)}`);
    expect(back.index).toBe(1);
    expect(back.state.buttons).toBe(0b1010);
    back.state.axes.forEach((a, i) => expect(a).toBeCloseTo(state.axes[i], 4));
    back.state.triggers.forEach((t, i) => expect(t).toBeCloseTo(state.triggers[i], 2));
  });

  it("clamps what does not fit rather than wrapping it", () => {
    expect(roundTrip({ type: "move-by", dx: 100_000, dy: -100_000 })).toEqual({
      type: "move-by",
      dx: 32767,
      dy: -32768,
    });
    const back = roundTrip({ type: "move", x: 1.5, y: -2 });
    expect(back).toEqual({ type: "move", x: 1, y: 0 });
  });

  it("keeps every message small — mouse motion, the hot path, is five bytes", () => {
    expect(encodeInput({ type: "move", x: 0.5, y: 0.5 })).toHaveLength(5);
    expect(encodeInput({ type: "move-by", dx: 1, dy: 1 })).toHaveLength(5);
    expect(encodeInput({ type: "button", button: 0, down: true })).toHaveLength(3);
    expect(encodeInput({ type: "key", code: "KeyW", down: true })).toHaveLength(7);
    expect(encodeInput({ type: "gamepad", index: 0, state: NEUTRAL_GAMEPAD })).toHaveLength(16);
    expect(encodeInput({ type: "heartbeat" })).toHaveLength(1);
  });

  it("refuses to encode a key with no physical code", () => {
    expect(() => encodeInput({ type: "key", code: "", down: true })).toThrow(RangeError);
    expect(() => encodeInput({ type: "key", code: "Key W", down: true })).toThrow(RangeError);
  });

  it("names the protocol version the channels are opened with", () => {
    expect(INPUT_PROTOCOL).toBe("swiff-input/1");
    expect(INPUT_CHANNELS.keys.init.protocol).toBe(INPUT_PROTOCOL);
    expect(INPUT_CHANNELS.motion.init.protocol).toBe(INPUT_PROTOCOL);
  });

  it("puts only mouse motion on the lossy channel", () => {
    expect(INPUT_CHANNELS.motion.init).toMatchObject({ ordered: false, maxRetransmits: 0 });
    expect(INPUT_CHANNELS.keys.init).toMatchObject({ ordered: true });
    expect(INPUT_CHANNELS.keys.init.maxRetransmits).toBeUndefined();

    expect(laneOf({ type: "move", x: 0, y: 0 })).toBe("motion");
    expect(laneOf({ type: "move-by", dx: 1, dy: 0 })).toBe("motion");
    const reliable: InputMessage[] = [
      { type: "key", code: "KeyW", down: false },
      { type: "button", button: 0, down: false },
      { type: "wheel", dx: 0, dy: 120 },
      { type: "gamepad", index: 0, state: NEUTRAL_GAMEPAD },
      { type: "release", reason: "blur" },
      { type: "heartbeat" },
    ];
    for (const msg of reliable) expect(laneOf(msg)).toBe("keys");

    expect(inputLane(INPUT_CHANNELS.keys.label)).toBe("keys");
    expect(inputLane(INPUT_CHANNELS.motion.label)).toBe("motion");
    expect(inputLane("chat")).toBeNull();
  });
});

describe("input decoding of hostile bytes", () => {
  it.each([
    ["empty", []],
    ["unknown op", [99]],
    ["truncated move", [1, 0, 0]],
    ["overlong heartbeat", [8, 0]],
    ["button 5", [3, 5, 1]],
    ["button down = 2", [3, 0, 2]],
    ["key length past the end", [5, 1, 10, 75]],
    ["key with a space", [5, 1, 2, 75, 32]],
    ["key with no code", [5, 1, 0]],
    ["gamepad slot 4", [6, 4, ...new Array(14).fill(0)]],
    ["gamepad button 17", [6, 0, 0, 0, 2, 0, ...new Array(10).fill(0)]],
    ["unknown release reason", [7, 9]],
  ])("drops %s", (_name, bytes) => {
    expect(decodeInput(Uint8Array.from(bytes))).toBeNull();
  });

  it("never throws on random bytes", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 5000; i++) {
      const bytes = Uint8Array.from({ length: Math.floor(random() * 20) }, () => Math.floor(random() * 256));
      expect(() => decodeInput(bytes)).not.toThrow();
    }
  });

  it("reads a view into a larger buffer at its own offset", () => {
    const encoded = encodeInput({ type: "key", code: "KeyA", down: true });
    const padded = new Uint8Array(encoded.length + 8);
    padded.set(encoded, 4);
    expect(decodeInput(padded.subarray(4, 4 + encoded.length))).toEqual({
      type: "key",
      code: "KeyA",
      down: true,
    });
  });
});
