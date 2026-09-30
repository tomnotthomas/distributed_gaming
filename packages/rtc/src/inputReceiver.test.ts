// The PC's receiver: it alone decides when a held key is let go, so every way a
// renter can vanish is driven here and has to end with nothing held.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeInput, NEUTRAL_GAMEPAD, type InputMessage } from "./input";
import { createInputReceiver } from "./inputReceiver";
import { createInputSender } from "./inputSender";
import { assertEveryPressReleased, loopbackChannel, recordingSink } from "./test/fakes";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Create a recording receiver with a release spy and a helper to feed encoded messages. */
function setup(timeoutMs = 1_000) {
  const sink = recordingSink();
  const onRelease = vi.fn();
  const receiver = createInputReceiver({ sink, timeoutMs, onRelease });
  const feed = (...msgs: InputMessage[]) => msgs.forEach((m) => receiver.receive(encodeInput(m)));
  return { sink, receiver, feed, onRelease };
}

const pad = { buttons: 1, axes: [0.5, 0, 0, 0], triggers: [0, 0] } as {
  buttons: number;
  axes: [number, number, number, number];
  triggers: [number, number];
};

describe("createInputReceiver", () => {
  it("replays motion, wheel, buttons, keys and controllers to the sink in order", () => {
    const { sink, feed } = setup();
    feed(
      { type: "move", x: 0, y: 1 },
      { type: "move-by", dx: 3, dy: -4 },
      { type: "wheel", dx: 0, dy: 120 },
      { type: "button", button: 2, down: true },
      { type: "key", code: "KeyW", down: true },
      { type: "gamepad", index: 0, state: pad },
    );
    expect(sink.events.map((e) => e.kind)).toEqual(["move", "moveBy", "wheel", "button", "key", "gamepad"]);
  });

  it("drops a repeated down and an up for a key that is not held", () => {
    const { sink, feed } = setup();
    feed(
      { type: "key", code: "KeyA", down: false },
      { type: "key", code: "KeyW", down: true },
      { type: "key", code: "KeyW", down: true },
      { type: "key", code: "KeyW", down: false },
      { type: "key", code: "KeyW", down: false },
    );
    expect(sink.events).toEqual([
      { kind: "key", code: "KeyW", down: true },
      { kind: "key", code: "KeyW", down: false },
    ]);
  });

  it("lets go of everything when the renter says so", () => {
    const { sink, feed, receiver, onRelease } = setup();
    feed(
      { type: "key", code: "KeyW", down: true },
      { type: "key", code: "ShiftLeft", down: true },
      { type: "button", button: 0, down: true },
      { type: "gamepad", index: 2, state: pad },
      { type: "release", reason: "blur" },
    );
    assertEveryPressReleased(sink.events);
    expect(sink.events.at(-1)).toEqual({ kind: "gamepad", index: 2, state: NEUTRAL_GAMEPAD });
    expect(receiver.held()).toEqual({ keys: [], buttons: [], gamepads: [] });
    expect(onRelease).toHaveBeenCalledWith("blur");
  });

  it("lets go of everything when the channel closes", () => {
    const { sink, receiver, onRelease } = setup();
    const channel = loopbackChannel();
    receiver.attach(channel);
    channel.send(encodeInput({ type: "key", code: "KeyD", down: true }));
    expect(receiver.held().keys).toEqual(["KeyD"]);

    channel.drop();

    assertEveryPressReleased(sink.events);
    expect(onRelease).toHaveBeenCalledWith("closed");
  });

  it("lets go of everything after a second of silence, but not while heartbeats arrive", () => {
    const { sink, feed, onRelease } = setup(1_000);
    feed({ type: "key", code: "KeyW", down: true });

    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(250);
      feed({ type: "heartbeat" });
    }
    expect(sink.events).toEqual([{ kind: "key", code: "KeyW", down: true }]);

    vi.advanceTimersByTime(1_300);
    assertEveryPressReleased(sink.events);
    expect(onRelease).toHaveBeenCalledWith("timeout");
  });

  it("owns no timer while nothing is held", () => {
    const { feed } = setup();
    feed({ type: "key", code: "KeyW", down: true });
    expect(vi.getTimerCount()).toBe(1);
    feed({ type: "key", code: "KeyW", down: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a key-up that arrives after the timeout already released it", () => {
    const { sink, feed } = setup(1_000);
    feed({ type: "key", code: "KeyW", down: true });
    vi.advanceTimersByTime(2_000);
    feed({ type: "key", code: "KeyW", down: false });
    expect(sink.events).toEqual([
      { kind: "key", code: "KeyW", down: true },
      { kind: "key", code: "KeyW", down: false },
    ]);
  });

  it("still releases every key when the sink fails on one", () => {
    const released: string[] = [];
    const sink = {
      ...recordingSink(),
      key(code: string, down: boolean) {
        if (!down && code === "KeyA") throw new Error("SendInput failed");
        if (!down) released.push(code);
      },
    };
    const receiver = createInputReceiver({ sink });
    for (const code of ["KeyA", "KeyB", "KeyC"])
      receiver.receive(encodeInput({ type: "key", code, down: true }));

    expect(() => receiver.releaseAll("closed")).toThrow("SendInput failed");
    expect(released).toEqual(["KeyB", "KeyC"]);
    expect(receiver.held().keys).toEqual([]);
  });

  it.each(["timeout", "close", "error"] as const)(
    "contains and reports sink failures during automatic %s releases",
    (trigger) => {
      const { sink, receiver, feed, onRelease } = setup();
      const channel = loopbackChannel();
      const listen = vi.spyOn(channel, "addEventListener");
      receiver.attach(channel);
      feed(
        { type: "key", code: "KeyW", down: true },
        { type: "button", button: 0, down: true },
        { type: "gamepad", index: 0, state: pad },
      );
      const failure = new Error("SendInput failed");
      vi.spyOn(sink, "key").mockImplementation(() => {
        throw failure;
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(() => {
        if (trigger === "timeout") vi.advanceTimersByTime(1_000);
        else listen.mock.calls.find(([type]) => type === trigger)![1](new Event(trigger));
      }).not.toThrow();

      expect(warn).toHaveBeenCalledExactlyOnceWith("[swiff] could not release input", failure);
      expect(onRelease).toHaveBeenCalledExactlyOnceWith(trigger === "timeout" ? "timeout" : "closed");
      expect(sink.events.slice(-2)).toEqual([
        { kind: "button", button: 0, down: false },
        { kind: "gamepad", index: 0, state: NEUTRAL_GAMEPAD },
      ]);
      expect(receiver.held()).toEqual({ keys: [], buttons: [], gamepads: [] });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps receiving from a channel when the sink fails on one message", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sink = recordingSink();
    const failing = {
      ...sink,
      key(code: string, down: boolean) {
        if (code === "KeyA" && down) throw new Error("SendInput failed");
        sink.key(code, down);
      },
    };
    const receiver = createInputReceiver({ sink: failing });
    const channel = loopbackChannel();
    receiver.attach(channel);

    // The failure stays inside the listener instead of escaping to the channel.
    expect(() => channel.send(encodeInput({ type: "key", code: "KeyA", down: true }))).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();

    channel.send(encodeInput({ type: "key", code: "KeyW", down: true }));
    expect(receiver.held().keys).toEqual(["KeyA", "KeyW"]);

    // A key whose press failed is still released, along with the rest.
    channel.drop();
    expect(sink.events).toEqual([
      { kind: "key", code: "KeyW", down: true },
      { kind: "key", code: "KeyA", down: false },
      { kind: "key", code: "KeyW", down: false },
    ]);
    warn.mockRestore();
  });

  it("does nothing after close", () => {
    const { sink, receiver, feed } = setup();
    feed({ type: "key", code: "KeyW", down: true });
    receiver.close();
    feed({ type: "key", code: "KeyS", down: true });
    assertEveryPressReleased(sink.events);
    expect(sink.events).toHaveLength(2);
  });

  it("survives garbage on the channel", () => {
    const { sink, receiver } = setup();
    const channel = loopbackChannel();
    receiver.attach(channel);
    channel.send(Uint8Array.from([5, 1, 200, 1]));
    channel.send(Uint8Array.from([]));
    expect(sink.events).toEqual([]);
  });
});

describe("createInputSender", () => {
  it("sends each key-up for what it pressed, then a release", () => {
    const sent: Uint8Array[] = [];
    const sink = recordingSink();
    const receiver = createInputReceiver({ sink });
    const sender = createInputSender((bytes) => {
      receiver.receive(bytes);
      sent.push(bytes);
    });

    sender.key("KeyW", true);
    sender.key("KeyW", true); // auto-repeat: not sent twice
    sender.button(0, true);
    sender.gamepad(1, pad);
    sender.gamepad(1, pad); // unchanged poll: not sent
    sender.releaseAll("hidden");

    // Three presses, their three releases, and the release message itself.
    expect(sent).toHaveLength(7);
    assertEveryPressReleased(sink.events);
    sender.close();
  });

  it("sends a heartbeat while open, and nothing at all once closed", () => {
    const sent: Uint8Array[] = [];
    const sender = createInputSender((bytes) => sent.push(bytes), { heartbeatMs: 250 });
    vi.advanceTimersByTime(1_000);
    expect(sent).toHaveLength(4);
    expect(sent.every((b) => b.length === 1 && b[0] === 8)).toBe(true);

    sender.close();
    const atClose = sent.length;
    vi.advanceTimersByTime(1_000);
    sender.key("KeyW", true);
    expect(sent).toHaveLength(atClose);
  });

  it.each([false, true])("finishes closing after a failed send (holding input: %s)", (holding) => {
    const send = vi.fn();
    const sender = createInputSender(send);
    if (holding) sender.key("KeyW", true);
    send.mockClear();
    send.mockImplementation(() => {
      throw new Error("channel closed");
    });

    expect(() => sender.close()).not.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    send.mockClear();
    vi.advanceTimersByTime(1_000);
    sender.key("KeyS", true);
    sender.move(0.5, 0.5);
    sender.releaseAll("blur");
    sender.close();
    expect(send).not.toHaveBeenCalled();
  });

  it("still propagates send failures from a direct releaseAll call", () => {
    const failure = new Error("channel closed");
    const sender = createInputSender(() => {
      throw failure;
    });
    expect(() => sender.releaseAll("blur")).toThrow(failure);
    sender.close();
  });

  it("releases a controller that disconnects mid-press", () => {
    const sink = recordingSink();
    const receiver = createInputReceiver({ sink });
    const sender = createInputSender((bytes) => receiver.receive(bytes));
    sender.gamepad(0, pad);
    sender.gamepad(0, null);
    assertEveryPressReleased(sink.events);
    sender.close();
  });

  it("skips keys with no physical code", () => {
    const sent: Uint8Array[] = [];
    const sender = createInputSender((bytes) => sent.push(bytes));
    sender.key("", true);
    sender.key("Unidentified!", true);
    expect(sent).toEqual([]);
    sender.close();
  });
});
