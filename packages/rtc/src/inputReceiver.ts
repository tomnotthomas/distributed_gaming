// The gaming PC's end of the input channel, minus the operating system.
//
// It decodes what the renter sends, keeps track of every key, mouse button and
// controller the renter is holding, and hands each event to a sink. On Windows
// the sink is SendInput and a virtual controller; in tests it is a list. The
// sink only ever has to replay — deciding when to let go is done here, once:
//
//   - the renter says so (their tab lost focus, was hidden, or disconnected)
//   - the channel closes or errors, which is all a dropped connection says
//   - nothing at all arrives for `timeoutMs` while something is held. The
//     renter sends a heartbeat, so silence means the renter is gone even
//     when the connection has not noticed yet.
//
// "Held" is the receiver's own record of what it told the sink, so it cannot
// disagree with the sink. Every key-down it passes on is followed by exactly one
// key-up; a repeated down for a held key and an up for a key not held are
// dropped rather than replayed.

import {
  decodeInput,
  isNeutralGamepad,
  NEUTRAL_GAMEPAD,
  type GamepadState,
  type InputMessage,
  type MouseButton,
  type ReleaseReason,
} from "./input";

/** What the PC does with the renter's input. Called synchronously, in order. */
export type InputSink = {
  /** Absolute position, 0..1 across the streamed screen. */
  move(x: number, y: number): void;
  /** Relative motion in mouse counts, while the renter's pointer is locked. */
  moveBy(dx: number, dy: number): void;
  /** In 1/120 of a notch; positive is down and right, as in the DOM. */
  wheel(dx: number, dy: number): void;
  button(button: MouseButton, down: boolean): void;
  /** A physical key, by `KeyboardEvent.code`. */
  key(code: string, down: boolean): void;
  /** The whole controller. A neutral state is how a controller is released. */
  gamepad(index: number, state: GamepadState): void;
};

/** Why the receiver let go of everything: the renter's reason, or its own. */
export type ReceiverReleaseReason = ReleaseReason | "closed" | "timeout";

/** The slice of RTCDataChannel the receiver uses, so a test can hand it a fake. */
export type InputChannelLike = {
  binaryType: BinaryType;
  addEventListener(type: "message" | "close" | "error", listener: (event: Event) => void): void;
  removeEventListener(type: "message" | "close" | "error", listener: (event: Event) => void): void;
};

export type InputReceiverOptions = {
  sink: InputSink;
  /** Release everything after this long without a message while anything is held. */
  timeoutMs?: number;
  /** Called after each release that let go of something. */
  onRelease?: (reason: ReceiverReleaseReason) => void;
};

export type HeldInput = { keys: string[]; buttons: MouseButton[]; gamepads: number[] };

export type InputReceiver = {
  /** Feed one message from the channel. Malformed messages are dropped. */
  receive(data: ArrayBuffer | ArrayBufferView): void;
  /** Let go of everything held. Safe to call at any time, any number of times. */
  releaseAll(reason: ReceiverReleaseReason): void;
  /** Read messages from a channel, and release when it closes. Returns detach. */
  attach(channel: InputChannelLike): () => void;
  held(): HeldInput;
  /** Release everything and stop the watchdog. The receiver is done after this. */
  close(): void;
};

/**
 * Four heartbeats' worth. Short enough that a vanished renter's key is let go
 * before it matters, long enough that one slow frame on the renter's side does
 * not drop a key they are really holding.
 */
export const DEFAULT_INPUT_TIMEOUT_MS = 1_000;

/**
 * Decode input into a synchronous sink, tracking held keys, buttons and controllers.
 * Releases held input on release messages, attached channel closure or errors,
 * inactivity and close. Duplicate key and mouse-button transitions are ignored.
 */
export function createInputReceiver({
  sink,
  timeoutMs = DEFAULT_INPUT_TIMEOUT_MS,
  onRelease,
}: InputReceiverOptions): InputReceiver {
  const keys = new Set<string>();
  const buttons = new Set<MouseButton>();
  const gamepads = new Set<number>();
  let lastSeen = Date.now();
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const holding = () => keys.size + buttons.size + gamepads.size > 0;

  // Runs only while something is held: an idle receiver owns no timer.
  const arm = () => {
    if (watchdog || closed) return;
    watchdog = setInterval(
      () => {
        if (Date.now() - lastSeen >= timeoutMs) guardedReleaseAll("timeout");
      },
      Math.max(10, Math.floor(timeoutMs / 4)),
    );
  };
  const disarm = () => {
    if (!watchdog) return;
    clearInterval(watchdog);
    watchdog = null;
  };

  const apply = (msg: InputMessage) => {
    switch (msg.type) {
      case "move":
        return sink.move(msg.x, msg.y);
      case "move-by":
        return sink.moveBy(msg.dx, msg.dy);
      case "wheel":
        return sink.wheel(msg.dx, msg.dy);
      case "button":
        if (msg.down === buttons.has(msg.button)) return;
        if (msg.down) buttons.add(msg.button);
        else buttons.delete(msg.button);
        return sink.button(msg.button, msg.down);
      case "key":
        if (msg.down === keys.has(msg.code)) return;
        if (msg.down) keys.add(msg.code);
        else keys.delete(msg.code);
        return sink.key(msg.code, msg.down);
      case "gamepad": {
        const neutral = isNeutralGamepad(msg.state);
        if (neutral && !gamepads.has(msg.index)) return;
        if (neutral) gamepads.delete(msg.index);
        else gamepads.add(msg.index);
        return sink.gamepad(msg.index, msg.state);
      }
      case "release":
        return releaseAll(msg.reason);
      case "heartbeat":
        return;
    }
  };

  /**
   * Every release is attempted even if the sink throws on one: a failure to
   * lift one key must not leave the others down. The first error is rethrown
   * once everything has been tried.
   */
  function releaseAll(reason: ReceiverReleaseReason) {
    disarm();
    if (!holding()) return;
    const releases: (() => void)[] = [
      ...[...keys].map((code) => () => sink.key(code, false)),
      ...[...buttons].map((button) => () => sink.button(button, false)),
      ...[...gamepads].map((index) => () => sink.gamepad(index, NEUTRAL_GAMEPAD)),
    ];
    keys.clear();
    buttons.clear();
    gamepads.clear();

    let failure: unknown = null;
    for (const release of releases) {
      try {
        release();
      } catch (cause) {
        failure ??= cause;
      }
    }
    onRelease?.(reason);
    if (failure) throw failure;
  }

  function guardedReleaseAll(reason: ReceiverReleaseReason) {
    try {
      releaseAll(reason);
    } catch (cause) {
      console.warn("[swiff] could not release input", cause);
    }
  }

  const receive = (data: ArrayBuffer | ArrayBufferView) => {
    if (closed) return;
    lastSeen = Date.now();
    const msg = decodeInput(data);
    if (!msg) return;
    try {
      apply(msg);
    } finally {
      if (holding()) arm();
      else disarm();
    }
  };

  return {
    receive,
    releaseAll,
    attach(channel) {
      channel.binaryType = "arraybuffer";
      const onMessage = (event: Event) => {
        const { data } = event as MessageEvent;
        // Text frames are not part of the protocol.
        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) receive(data);
      };
      const onGone = () => guardedReleaseAll("closed");
      channel.addEventListener("message", onMessage);
      channel.addEventListener("close", onGone);
      channel.addEventListener("error", onGone);
      return () => {
        channel.removeEventListener("message", onMessage);
        channel.removeEventListener("close", onGone);
        channel.removeEventListener("error", onGone);
      };
    },
    held: () => ({ keys: [...keys], buttons: [...buttons], gamepads: [...gamepads] }),
    close() {
      if (closed) return;
      closed = true;
      releaseAll("closed");
    },
  };
}
