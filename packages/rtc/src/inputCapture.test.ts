// The renter's browser, end to end against a fake PC.
//
// Real DOM events go into `startInputCapture`, the bytes it sends cross a
// loopback channel into the real receiver, and a recording sink stands where
// SendInput will. The assertion throughout is the one the product promises:
// every key-down the PC sees is followed by its key-up — whether the renter
// lets go, clicks away, hides the tab, disconnects or simply drops off.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeInput, NEUTRAL_GAMEPAD } from "./input";
import { gamepadState, startInputCapture, videoPoint } from "./inputCapture";
import { createInputReceiver } from "./inputReceiver";
import { assertEveryPressReleased, loopbackChannel, recordingSink } from "./test/fakes";

let video: HTMLVideoElement;
let pads: (Gamepad | null)[];
let frames: (() => void)[];

beforeEach(() => {
  vi.useFakeTimers();
  video = document.createElement("video");
  document.body.append(video);
  pads = [];
  frames = [];
  setVisibility("visible");
});

afterEach(() => {
  video.remove();
  vi.useRealTimers();
  Object.defineProperty(document, "pointerLockElement", { configurable: true, value: null });
});

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
}

function lockPointer(element: Element | null) {
  Object.defineProperty(document, "pointerLockElement", { configurable: true, value: element });
}

/** Renter's browser → keys and motion channels → PC receiver → recording sink. */
function session() {
  const channel = loopbackChannel();
  const motion = loopbackChannel();
  const sink = recordingSink();
  const receiver = createInputReceiver({ sink });
  receiver.attach(channel);
  receiver.attach(motion);
  const capture = startInputCapture({
    target: video,
    channels: { keys: channel, motion },
    getGamepads: () => pads,
    requestFrame: (fn) => frames.push(fn),
    cancelFrame: () => {},
  });
  const nextFrame = () => frames.splice(0).forEach((fn) => fn());
  return { channel, motion, sink, receiver, capture, nextFrame };
}

const key = (type: "keydown" | "keyup", code: string, init: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...init }));

const keys = (sink: ReturnType<typeof recordingSink>) =>
  sink.events
    .filter((e) => e.kind === "key")
    .map((e) => (e.kind === "key" ? `${e.code}${e.down ? "↓" : "↑"}` : ""));

function mouse(type: string, init: MouseEventInit & { movementX?: number; movementY?: number } = {}) {
  const { movementX, movementY, ...rest } = init;
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...rest });
  // jsdom does not take movement in the constructor.
  Object.defineProperty(event, "movementX", { value: movementX ?? 0 });
  Object.defineProperty(event, "movementY", { value: movementY ?? 0 });
  return event;
}

function fakePad(index: number, pressed: number[] = [], axes = [0, 0, 0, 0]): Gamepad {
  const buttons = Array.from({ length: 17 }, (_, i) => ({
    pressed: pressed.includes(i),
    touched: pressed.includes(i),
    value: pressed.includes(i) ? 1 : 0,
  }));
  return { index, connected: true, buttons, axes, mapping: "standard" } as unknown as Gamepad;
}

describe("startInputCapture", () => {
  it("sends keys only while the stream has focus, by physical code", () => {
    const { sink, capture } = session();

    key("keydown", "KeyQ"); // nothing focused: the page keeps it
    video.focus();
    key("keydown", "KeyW", { key: "z" }); // an AZERTY renter's W is still KeyW
    key("keydown", "KeyW", { repeat: true });
    key("keyup", "KeyW");

    expect(keys(sink)).toEqual(["KeyW↓", "KeyW↑"]);
    capture.stop();
    assertEveryPressReleased(sink.events);
  });

  it("stops the browser acting on captured keys", () => {
    const { capture } = session();
    video.focus();
    const tab = new KeyboardEvent("keydown", { code: "Tab", cancelable: true });
    window.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    capture.stop();
  });

  it("sends the key-up even when focus moved off the stream first", () => {
    const { sink, capture } = session();
    video.focus();
    key("keydown", "KeyW");
    video.blur(); // focus went to another element on the page, not away from the window
    key("keyup", "KeyW");
    expect(keys(sink)).toEqual(["KeyW↓", "KeyW↑"]);
    capture.stop();
  });

  it("releases every held key when the window loses focus", () => {
    const { sink, capture } = session();
    video.focus();
    key("keydown", "KeyW");
    key("keydown", "ShiftLeft");
    window.dispatchEvent(new Event("blur"));

    assertEveryPressReleased(sink.events);
    // The real key-up that the renter's browser delivers later changes nothing.
    key("keyup", "KeyW");
    assertEveryPressReleased(sink.events);
    capture.stop();
  });

  it("releases every held key when the tab is hidden", () => {
    const { sink, capture } = session();
    video.focus();
    key("keydown", "KeyA");
    video.dispatchEvent(mouse("mousedown", { button: 0 }));

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    assertEveryPressReleased(sink.events);
    capture.stop();
  });

  it("releases every held key when the renter disconnects", () => {
    const { sink, channel, capture } = session();
    video.focus();
    key("keydown", "KeyW");
    video.dispatchEvent(mouse("mousedown", { button: 2 }));

    capture.stop();

    assertEveryPressReleased(sink.events);
    // And says so, so the PC lets go even of anything it thinks is still held.
    const last = decodeInput(channel.sent.at(-1)!);
    expect(last).toEqual({ type: "release", reason: "disconnect" });
    // Nothing is sent after stop.
    const count = channel.sent.length;
    key("keydown", "KeyE");
    vi.advanceTimersByTime(5_000);
    expect(channel.sent).toHaveLength(count);
  });

  it.each(["keys", "motion"] as const)(
    "releases every held key on the PC when the %s channel just closes",
    (lane) => {
      const { sink, channel, motion, capture } = session();
      video.focus();
      key("keydown", "KeyW");

      // The connection is gone; no key-up can be sent any more.
      (lane === "keys" ? channel : motion).drop();

      assertEveryPressReleased(sink.events);
      // The renter's side must not throw on the dead channel either.
      expect(() => key("keyup", "KeyW")).not.toThrow();
      capture.stop();
    },
  );

  it("releases every held key when pointer lock ends", () => {
    const { sink, channel, capture } = session();
    lockPointer(video);
    document.dispatchEvent(new Event("pointerlockchange"));
    key("keydown", "KeyW");
    video.dispatchEvent(mouse("mousedown", { button: 0 }));

    // Escape: the browser takes the pointer back.
    lockPointer(null);
    document.dispatchEvent(new Event("pointerlockchange"));

    assertEveryPressReleased(sink.events);
    expect(decodeInput(channel.sent.at(-1)!)).toEqual({ type: "release", reason: "unlock" });
    capture.stop();
  });

  it("releases on the PC when the renter's browser falls silent", () => {
    const channel = loopbackChannel();
    const motion = loopbackChannel();
    const sink = recordingSink();
    const receiver = createInputReceiver({ sink, timeoutMs: 1_000 });
    receiver.attach(channel);
    receiver.attach(motion);
    // The capture sends into channels that stop carrying anything, as a
    // stalled connection does before it is declared dead.
    let delivering = true;
    const stalling = (inner: ReturnType<typeof loopbackChannel>) => ({
      ...inner,
      send: (data: Uint8Array<ArrayBuffer>) => delivering && inner.send(data),
    });
    const capture = startInputCapture({
      target: video,
      channels: { keys: stalling(channel), motion: stalling(motion) },
      requestFrame: () => 0,
      cancelFrame: () => {},
    });

    video.focus();
    key("keydown", "KeyW");
    vi.advanceTimersByTime(3_000); // heartbeats keep it held
    expect(receiver.held().keys).toEqual(["KeyW"]);

    delivering = false;
    vi.advanceTimersByTime(1_500);
    assertEveryPressReleased(sink.events);
    capture.stop();
  });

  it("holds up across a long random session of presses, releases, blurs and hides", () => {
    const { sink, capture } = session();
    let seed = 42;
    const random = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    const codes = ["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ControlLeft", "Digit1"];

    video.focus();
    for (let step = 0; step < 2_000; step++) {
      const roll = random(100);
      if (roll < 40) key("keydown", codes[random(codes.length)]);
      else if (roll < 80) key("keyup", codes[random(codes.length)]);
      else if (roll < 88) video.dispatchEvent(mouse("mousedown", { button: random(3) }));
      else if (roll < 95) window.dispatchEvent(mouse("mouseup", { button: random(3) }));
      else if (roll < 97) window.dispatchEvent(new Event("blur"));
      else if (roll < 99) {
        setVisibility("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
        setVisibility("visible");
      } else vi.advanceTimersByTime(300);
      if (step % 100 === 0) video.focus();
    }
    capture.stop();

    expect(sink.events.length).toBeGreaterThan(500);
    assertEveryPressReleased(sink.events);
  });

  it("clicks lock the pointer, and locked motion is sent as relative counts", () => {
    const requestPointerLock = vi.fn();
    video.requestPointerLock = requestPointerLock;
    const { sink, capture, channel, motion } = session();

    video.dispatchEvent(mouse("mousedown", { button: 0 }));
    expect(requestPointerLock).toHaveBeenCalledOnce();
    window.dispatchEvent(mouse("mouseup", { button: 0 }));

    lockPointer(video);
    const sentOnKeys = channel.sent.length;
    document.dispatchEvent(mouse("pointermove", { movementX: 0.6, movementY: -3 }));
    document.dispatchEvent(mouse("pointermove", { movementX: 0.6, movementY: 0 }));

    // Fractions are carried, not lost: 0.6 + 0.6 is one whole count.
    expect(sink.events.filter((e) => e.kind === "moveBy")).toEqual([
      { kind: "moveBy", dx: 0, dy: -3 },
      { kind: "moveBy", dx: 1, dy: 0 },
    ]);
    // Motion rides its own channel, never the reliable one.
    expect(motion.sent).toHaveLength(2);
    expect(channel.sent).toHaveLength(sentOnKeys);

    // Keys are captured while locked, even without focus.
    video.blur();
    key("keydown", "KeyR");
    expect(keys(sink)).toEqual(["KeyR↓"]);
    capture.stop();
    assertEveryPressReleased(sink.events);
  });

  it("sends every coalesced movement, not just one per frame", () => {
    const { sink, capture } = session();
    lockPointer(video);
    const event = mouse("pointermove", { movementX: 9, movementY: 9 });
    const parts = [
      mouse("pointermove", { movementX: 4 }),
      mouse("pointermove", { movementX: 5, movementY: 9 }),
    ];
    Object.defineProperty(event, "getCoalescedEvents", { value: () => parts });
    document.dispatchEvent(event);

    expect(sink.events).toEqual([
      { kind: "moveBy", dx: 4, dy: 0 },
      { kind: "moveBy", dx: 5, dy: 9 },
    ]);
    capture.stop();
  });

  it("drops motion rather than queueing it on a backed-up link, but never a key", () => {
    const { sink, capture, channel, motion } = session();
    lockPointer(video);
    motion.bufferedAmount = 1 << 20;
    channel.bufferedAmount = 1 << 20;

    document.dispatchEvent(mouse("pointermove", { movementX: 10 }));
    key("keydown", "KeyW");

    expect(sink.events).toEqual([{ kind: "key", code: "KeyW", down: true }]);
    capture.stop();
    assertEveryPressReleased(sink.events);
  });

  it("holds a controller's movement back on a backed-up link, but not its release", () => {
    const { sink, capture, channel, nextFrame } = session();
    pads = [fakePad(0, [0])];
    nextFrame();
    expect(sink.events).toHaveLength(1);

    channel.bufferedAmount = 1 << 20;
    pads = [fakePad(0, [0, 1])];
    nextFrame();
    expect(sink.events).toHaveLength(1);

    pads = [];
    nextFrame();
    assertEveryPressReleased(sink.events);
    capture.stop();
  });

  it("sends wheel notches in 1/120 units whatever the browser reports", () => {
    const { sink, capture } = session();
    video.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, deltaMode: 0, cancelable: true })); // Chrome: px
    video.dispatchEvent(new WheelEvent("wheel", { deltaY: 3, deltaMode: 1, cancelable: true })); // Firefox: lines
    expect(sink.events).toEqual([
      { kind: "wheel", dx: 0, dy: 120 },
      { kind: "wheel", dx: 0, dy: 120 },
    ]);
    capture.stop();
  });

  it("polls controllers each frame, sends only changes, and releases one that disconnects", () => {
    const { sink, capture, nextFrame } = session();

    pads = [fakePad(0, [0], [0.5, 0, 0, 0])];
    nextFrame();
    nextFrame(); // unchanged: nothing new
    expect(sink.events.filter((e) => e.kind === "gamepad")).toHaveLength(1);

    pads = [];
    nextFrame();
    const last = sink.events.at(-1);
    expect(last).toEqual({ kind: "gamepad", index: 0, state: NEUTRAL_GAMEPAD });
    capture.stop();
    assertEveryPressReleased(sink.events);
  });

  it("releases a controller held when the window loses focus", () => {
    const { sink, capture, nextFrame } = session();
    pads = [null, fakePad(1, [4])];
    nextFrame();
    window.dispatchEvent(new Event("blur"));
    assertEveryPressReleased(sink.events);
    capture.stop();
  });

  it.each([
    ["the window loses focus", () => window.dispatchEvent(new Event("blur"))],
    [
      "the tab is hidden",
      () => {
        setVisibility("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      },
    ],
  ])("keeps a controller held through %s released until focus returns", (_, leave) => {
    const { sink, capture, nextFrame } = session();
    const padEvents = () => sink.events.filter((e) => e.kind === "gamepad");
    pads = [fakePad(0, [7])];
    nextFrame();
    expect(padEvents()).toHaveLength(1);

    leave();
    nextFrame();
    nextFrame();
    expect(padEvents()).toHaveLength(2);
    assertEveryPressReleased(sink.events);

    setVisibility("visible");
    window.dispatchEvent(new Event("focus"));
    nextFrame();
    expect(padEvents()).toHaveLength(3);
    expect(padEvents().at(-1)).toEqual(padEvents()[0]);
    capture.stop();
    assertEveryPressReleased(sink.events);
  });
});

describe("videoPoint", () => {
  function sized(width: number, height: number, videoWidth: number, videoHeight: number) {
    const el = document.createElement("video");
    el.getBoundingClientRect = () => ({ left: 100, top: 50, width, height }) as DOMRect;
    Object.defineProperty(el, "videoWidth", { value: videoWidth });
    Object.defineProperty(el, "videoHeight", { value: videoHeight });
    return el;
  }

  it("maps the picture's corners to 0 and 1", () => {
    const el = sized(1600, 900, 1920, 1080);
    expect(videoPoint(el, 100, 50)).toEqual({ x: 0, y: 0 });
    expect(videoPoint(el, 1700, 950)).toEqual({ x: 1, y: 1 });
    expect(videoPoint(el, 900, 500)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("leaves the letterbox bars off the PC's screen", () => {
    // A 16:9 stream in a 4:3 box: 1200×675, with 112.5px bars top and bottom.
    const el = sized(1200, 900, 1920, 1080);
    expect(videoPoint(el, 700, 100)).toBeNull();
    expect(videoPoint(el, 100, 50 + 112.5)).toEqual({ x: 0, y: 0 });
  });
});

describe("gamepadState", () => {
  it("reads the standard layout's buttons, sticks and analogue triggers", () => {
    const pad = fakePad(0, [0, 7, 16], [0.1, -0.2, 0.3, -0.4]);
    expect(gamepadState(pad)).toEqual({
      buttons: (1 << 0) | (1 << 7) | (1 << 16),
      axes: [0.1, -0.2, 0.3, -0.4],
      triggers: [0, 1],
    });
  });
});
