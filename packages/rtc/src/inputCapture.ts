// The renter's mouse, keyboard and controllers, read off the page.
//
// Mouse: clicking the stream locks the pointer, and while it is locked motion
// is sent as relative counts — what a game's camera wants. Before that, the
// pointer's position over the picture is sent as an absolute point, which is
// enough to click through a launcher or a menu. Every coalesced event is sent,
// so a 1000 Hz mouse is not cut down to the display's frame rate.
//
// Keyboard: taken only while the stream has the pointer locked or has focus,
// so typing anywhere else on the page stays on the page. A key-up is always
// sent for a key that went down, wherever focus has gone since.
//
// Controllers: polled once per frame, as the Gamepad API requires, and sent
// only when something changed. Not while the window is away: a controller
// held through a blur stays released until the renter comes back.
//
// And the one rule the whole thing is for: nothing stays held. Losing focus,
// hiding the tab, leaving pointer lock and stopping all release everything the
// renter is holding.

import {
  isNeutralGamepad,
  MAX_GAMEPADS,
  WHEEL_NOTCH,
  type GamepadState,
  type InputLane,
  type MouseButton,
} from "./input";
import { createInputSender, type InputSender } from "./inputSender";

/** The slice of RTCDataChannel the capture sends on. */
export type InputSendChannel = {
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  send(data: Uint8Array<ArrayBuffer>): void;
};

// Past these, the link is not keeping up. Motion is dropped rather than queued
// — a queue of stale deltas replays as the camera swinging on its own seconds
// later — and a controller's next state waits for a later frame. Keys, buttons
// and releases are never dropped.
const MOTION_BACKLOG = 8 * 1024;
const GAMEPAD_BACKLOG = 64 * 1024;

export type InputCaptureOptions = {
  /** The stream's video element. It is made focusable so it can take keys. */
  target: HTMLVideoElement;
  channels: Record<InputLane, InputSendChannel>;
  heartbeatMs?: number;
  /** Test seams; the browser's own by default. */
  getGamepads?: () => ArrayLike<Gamepad | null>;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
};

export type InputCapture = {
  /** Release everything held, then stop listening. Idempotent. */
  stop(): void;
};

export function startInputCapture({
  target,
  channels,
  heartbeatMs,
  getGamepads = () => navigator.getGamepads?.() ?? [],
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (handle) => cancelAnimationFrame(handle),
}: InputCaptureOptions): InputCapture {
  const doc = target.ownerDocument;
  const win = doc.defaultView ?? window;

  const sender: InputSender = createInputSender(
    (bytes, lane) => {
      const channel = channels[lane];
      // A channel that is closing takes nothing; the PC's receiver releases on
      // the close itself.
      if (channel.readyState !== "open") return;
      if (lane === "motion" && channel.bufferedAmount > MOTION_BACKLOG) return;
      channel.send(bytes);
    },
    { heartbeatMs },
  );

  if (target.tabIndex < 0) target.tabIndex = 0;

  const locked = () => doc.pointerLockElement === target;
  const capturingKeys = () => locked() || doc.activeElement === target;

  // Sub-count motion and sub-unit wheel deltas are carried over rather than
  // rounded away, or a slow drag would never move at all.
  const motion = remainder();
  const scroll = remainder();

  const onPointerMove = (event: PointerEvent) => {
    if (locked()) {
      for (const each of coalesced(event)) {
        const [dx, dy] = motion(each.movementX ?? 0, each.movementY ?? 0);
        sender.moveBy(dx, dy);
      }
    } else if (event.target === target) {
      // Only the latest position matters for an absolute pointer.
      const point = videoPoint(target, event.clientX, event.clientY);
      if (point) sender.move(point.x, point.y);
    }
  };

  const onMouseDown = (event: MouseEvent) => {
    if (!isMouseButton(event.button)) return;
    event.preventDefault();
    // preventDefault above also cancels the focus a click would give; take it.
    target.focus();
    if (!locked()) {
      const point = videoPoint(target, event.clientX, event.clientY);
      if (point) sender.move(point.x, point.y);
      lockPointer(target);
    }
    sender.button(event.button, true);
  };

  // On the window, not the video: the button can be let go anywhere.
  const onMouseUp = (event: MouseEvent) => {
    if (isMouseButton(event.button)) sender.button(event.button, false);
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const unit = wheelUnit(event.deltaMode);
    const [dx, dy] = scroll(event.deltaX * unit, event.deltaY * unit);
    sender.wheel(dx, dy);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!capturingKeys()) return;
    // The browser's own shortcuts (Tab, Space scrolling, F5) belong to the game now.
    event.preventDefault();
    // Auto-repeat is the PC's business, not the network's.
    if (!event.repeat) sender.key(event.code, true);
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (capturingKeys()) event.preventDefault();
    sender.key(event.code, false);
  };

  // Escape (or the browser) ended pointer lock. Whatever was held when the
  // renter bailed out of the game is let go with it.
  let wasLocked = false;
  const onLockChange = () => {
    if (wasLocked && !locked()) sender.releaseAll("unlock");
    wasLocked = locked();
  };

  let away = false;
  const onBlur = () => {
    away = true;
    sender.releaseAll("blur");
  };
  const onFocus = () => {
    away = false;
  };
  const onVisibility = () => {
    if (doc.visibilityState !== "hidden") return;
    away = true;
    sender.releaseAll("hidden");
  };
  const onContextMenu = (event: Event) => event.preventDefault();

  doc.addEventListener("pointermove", onPointerMove);
  doc.addEventListener("pointerlockchange", onLockChange);
  target.addEventListener("mousedown", onMouseDown);
  win.addEventListener("mouseup", onMouseUp);
  target.addEventListener("wheel", onWheel, { passive: false });
  target.addEventListener("contextmenu", onContextMenu);
  win.addEventListener("keydown", onKeyDown);
  win.addEventListener("keyup", onKeyUp);
  win.addEventListener("blur", onBlur);
  win.addEventListener("focus", onFocus);
  doc.addEventListener("visibilitychange", onVisibility);

  // Controllers that were connected at the last poll, so one that vanishes is
  // released rather than left mid-press.
  const seen = new Set<number>();
  const poll = () => {
    frame = requestFrame(poll);
    if (away) return;
    const present = new Set<number>();
    const pads = getGamepads();
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (!pad?.connected || pad.index >= MAX_GAMEPADS) continue;
      present.add(pad.index);
      const state = gamepadState(pad);
      // A backed-up link skips a frame of stick movement, never a release.
      if (channels.keys.bufferedAmount > GAMEPAD_BACKLOG && !isNeutralGamepad(state)) continue;
      sender.gamepad(pad.index, state);
    }
    for (const index of seen) if (!present.has(index)) sender.gamepad(index, null);
    seen.clear();
    present.forEach((index) => seen.add(index));
  };
  let frame = requestFrame(poll);

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      cancelFrame(frame);
      doc.removeEventListener("pointermove", onPointerMove);
      doc.removeEventListener("pointerlockchange", onLockChange);
      target.removeEventListener("mousedown", onMouseDown);
      win.removeEventListener("mouseup", onMouseUp);
      target.removeEventListener("wheel", onWheel);
      target.removeEventListener("contextmenu", onContextMenu);
      win.removeEventListener("keydown", onKeyDown);
      win.removeEventListener("keyup", onKeyUp);
      win.removeEventListener("blur", onBlur);
      win.removeEventListener("focus", onFocus);
      doc.removeEventListener("visibilitychange", onVisibility);
      if (locked()) doc.exitPointerLock?.();
      sender.close();
    },
  };
}

/**
 * Where a point on the page falls on the streamed picture, 0..1 each way, or
 * null when it is on the letterbox bars around it.
 *
 * The video is drawn `object-fit: contain`, so a 16:9 stream in a box of any
 * other shape has bars; those are not part of the PC's screen.
 */
export function videoPoint(
  video: HTMLVideoElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const box = video.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  const sourceW = video.videoWidth || box.width;
  const sourceH = video.videoHeight || box.height;
  const scale = Math.min(box.width / sourceW, box.height / sourceH);
  const width = sourceW * scale;
  const height = sourceH * scale;
  const x = (clientX - box.left - (box.width - width) / 2) / width;
  const y = (clientY - box.top - (box.height - height) / 2) / height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/** A controller's state, in the protocol's terms. */
export function gamepadState(pad: Gamepad): GamepadState {
  let buttons = 0;
  for (let i = 0; i < Math.min(pad.buttons.length, 17); i++) {
    if (pad.buttons[i]?.pressed) buttons |= 1 << i;
  }
  const axis = (i: number) => pad.axes[i] ?? 0;
  return {
    buttons,
    axes: [axis(0), axis(1), axis(2), axis(3)],
    // Standard layout: buttons 6 and 7 are the triggers, and carry how far.
    triggers: [pad.buttons[6]?.value ?? 0, pad.buttons[7]?.value ?? 0],
  };
}

// Chrome coalesces pointer events to one per frame and keeps the rest here;
// each carries its own movement. Browsers without it report the sum on the
// event itself.
function coalesced(event: PointerEvent): MouseEvent[] {
  const all = event.getCoalescedEvents?.();
  return all?.length ? all : [event];
}

function isMouseButton(button: number): button is MouseButton {
  return Number.isInteger(button) && button >= 0 && button <= 4;
}

// What one unit of `deltaY` is worth in 1/120 notches. Chrome and Edge report
// pixels, 100 to a notch; Firefox reports lines, 3 to a notch.
function wheelUnit(deltaMode: number): number {
  if (deltaMode === 1) return WHEEL_NOTCH / 3; // DOM_DELTA_LINE
  if (deltaMode === 2) return WHEEL_NOTCH; // DOM_DELTA_PAGE
  return WHEEL_NOTCH / 100; // DOM_DELTA_PIXEL
}

/** Accumulates fractional deltas and hands out whole ones. */
function remainder() {
  let restX = 0;
  let restY = 0;
  return (dx: number, dy: number): [number, number] => {
    restX += dx;
    restY += dy;
    const x = Math.trunc(restX);
    const y = Math.trunc(restY);
    restX -= x;
    restY -= y;
    return [x, y];
  };
}

// Chrome can lock without mouse acceleration, which is what games expect; a
// browser without that option, or one that refuses the lock outright, still
// gets absolute motion, so a refusal is not an error.
function lockPointer(target: HTMLElement) {
  if (!target.requestPointerLock) return;
  try {
    const attempt = (
      target.requestPointerLock as (options?: { unadjustedMovement?: boolean }) => Promise<void> | void
    ).call(target, { unadjustedMovement: true });
    if (attempt instanceof Promise) {
      attempt.catch(() => {
        const retry = target.requestPointerLock() as Promise<void> | void;
        if (retry instanceof Promise) retry.catch(() => {});
      });
    }
  } catch {
    // Older browsers throw synchronously on an unknown option; nothing to do.
  }
}
