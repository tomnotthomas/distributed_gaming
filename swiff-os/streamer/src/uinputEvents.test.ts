import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NEUTRAL_GAMEPAD } from "@swiff/rtc";
import { KEYBOARD_KEYS, linuxKey } from "./keymap";
import { createUinputSink, DEVICE, RECORD_BYTES } from "./uinputEvents";

type Ev = [device: number, type: number, code: number, value: number];

/** Every event a sink wrote, decoded from the records. */
function recorder() {
  const events: Ev[] = [];
  const batches: Buffer[] = [];
  const sink = createUinputSink((buf) => {
    batches.push(buf);
    for (let at = 0; at < buf.length; at += RECORD_BYTES)
      events.push([
        buf.readUInt8(at),
        buf.readUInt16LE(at + 1),
        buf.readUInt16LE(at + 3),
        buf.readInt32LE(at + 5),
      ]);
  });
  return { sink, events, batches };
}

const SYN = (device: number): Ev => [device, 0, 0, 0];

describe("keymap", () => {
  it("maps physical keys to Linux keys, whatever the renter's layout", () => {
    expect(linuxKey("KeyW")).toBe(17);
    expect(linuxKey("KeyZ")).toBe(44);
    expect(linuxKey("Space")).toBe(57);
    expect(linuxKey("ShiftLeft")).toBe(42);
    expect(linuxKey("IntlBackslash")).toBe(86);
    expect(linuxKey("F12")).toBe(88);
    expect(linuxKey("ArrowUp")).toBe(103);
  });

  it("refuses the keys that would act on the PC rather than the game", () => {
    // Power and Sleep switch the PC off through logind; PrintScreen is SysRq.
    for (const code of ["Power", "Sleep", "WakeUp", "PrintScreen", "Eject", "BrowserHome", "toString"])
      expect(linuxKey(code)).toBeNull();
    for (const key of [116, 142, 143, 99]) expect(KEYBOARD_KEYS).not.toContain(key);
  });
});

describe("createUinputSink", () => {
  it("writes each call as one batch ending in SYN_REPORT", () => {
    const { sink, events, batches } = recorder();
    sink.key("KeyW", true);
    sink.key("KeyW", false);
    sink.button(2, true);
    sink.moveBy(5, -3);
    expect(batches).toHaveLength(4);
    expect(events).toEqual([
      [DEVICE.keyboard, 1, 17, 1], SYN(DEVICE.keyboard),
      [DEVICE.keyboard, 1, 17, 0], SYN(DEVICE.keyboard),
      [DEVICE.mouse, 1, 0x111, 1], SYN(DEVICE.mouse), // right button
      [DEVICE.mouse, 2, 0, 5], [DEVICE.mouse, 2, 1, -3], SYN(DEVICE.mouse),
    ]); // prettier-ignore
  });

  it("drops a key it does not map, rather than guessing", () => {
    const { sink, batches } = recorder();
    sink.key("Power", true);
    expect(batches).toHaveLength(0);
  });

  it("puts an absolute move on the pointer, across 0..65535", () => {
    const { sink, events } = recorder();
    sink.move(0.5, 1.2);
    expect(events).toEqual([
      [DEVICE.pointer, 3, 0, 32768],
      [DEVICE.pointer, 3, 1, 65535],
      SYN(DEVICE.pointer),
    ]);
  });

  it("turns the DOM's wheel into Linux's: up is positive, and whole notches add up", () => {
    const { sink, events } = recorder();
    sink.wheel(0, 60); // half a notch down
    sink.wheel(0, 60); // the other half
    expect(events).toEqual([
      [DEVICE.mouse, 2, 11, -60], SYN(DEVICE.mouse),
      [DEVICE.mouse, 2, 11, -60], [DEVICE.mouse, 2, 8, -1], SYN(DEVICE.mouse),
    ]); // prettier-ignore
  });

  it("sends a controller's whole state to its own device, an Xbox 360 layout", () => {
    const { sink, events } = recorder();
    // A held, d-pad left, left stick full right, right trigger half.
    sink.gamepad(1, { buttons: (1 << 0) | (1 << 14), axes: [1, 0, 0, -1], triggers: [0, 0.5] });
    const pad = events.filter(([d]) => d === DEVICE.gamepad0 + 1);
    expect(pad).toContainEqual([4, 1, 0x130, 1]); // BTN_SOUTH
    expect(pad).toContainEqual([4, 1, 0x131, 0]); // BTN_EAST
    expect(pad).toContainEqual([4, 3, 0, 32767]); // ABS_X
    expect(pad).toContainEqual([4, 3, 4, -32767]); // ABS_RY
    expect(pad).toContainEqual([4, 3, 5, 128]); // ABS_RZ
    expect(pad).toContainEqual([4, 3, 16, -1]); // ABS_HAT0X
    expect(pad.at(-1)).toEqual(SYN(4));
  });

  it("releases a controller by sending it neutral, and ignores one past the fourth", () => {
    const { sink, events } = recorder();
    sink.gamepad(4, { ...NEUTRAL_GAMEPAD, buttons: 1 });
    expect(events).toHaveLength(0);
    sink.gamepad(0, NEUTRAL_GAMEPAD);
    expect(events.filter(([, type, , value]) => type !== 0 && value !== 0)).toHaveLength(0);
  });
});

// The helper reads what the sink writes: one format, two languages. Run it in
// dry-run mode (no /dev/uinput, no root) and check it saw the same events.
const HELPER = join(fileURLToPath(new URL(".", import.meta.url)), "..", "helpers", "swiff-uinput.py");
const python = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(!python)("swiff-uinput.py", () => {
  it("replays the sink's records on the devices they name, and only what each device can do", () => {
    const { sink, batches } = recorder();
    sink.key("KeyA", true);
    sink.button(0, true);
    sink.gamepad(0, { ...NEUTRAL_GAMEPAD, buttons: 1 << 3 });
    const out = spawnSync("python3", [HELPER, "--keys", KEYBOARD_KEYS.join(","), "--dry-run"], {
      input: Buffer.concat(batches),
      encoding: "utf8",
    });
    expect(out.status).toBe(0);
    const lines = out.stdout.trim().split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "create Swiff virtual keyboard",
      "create Swiff virtual mouse",
      "create Swiff virtual pointer",
    ]);
    expect(lines).toContain("Swiff virtual keyboard 1 30 1");
    expect(lines).toContain("Swiff virtual mouse 1 272 1");
    // A controller appears only once the renter uses one.
    expect(lines.indexOf("create Microsoft X-Box 360 pad")).toBeGreaterThan(
      lines.indexOf("Swiff virtual mouse 1 272 1"),
    );
    expect(lines).toContain("Microsoft X-Box 360 pad 1 308 1"); // Y is BTN_WEST
    expect(lines.slice(-4)).toEqual([
      "destroy Swiff virtual keyboard",
      "destroy Swiff virtual mouse",
      "destroy Swiff virtual pointer",
      "destroy Microsoft X-Box 360 pad",
    ]);
  });

  it("drops events a device was not given, such as a key the keymap leaves out", () => {
    const records = Buffer.alloc(9);
    records.writeUInt8(0, 0);
    records.writeUInt16LE(1, 1);
    records.writeUInt16LE(116, 3); // KEY_POWER
    records.writeInt32LE(1, 5);
    const out = spawnSync("python3", [HELPER, "--keys", KEYBOARD_KEYS.join(","), "--dry-run"], {
      input: records,
      encoding: "utf8",
    });
    expect(out.status).toBe(0);
    expect(out.stdout).not.toContain(" 1 116 ");
  });
});
