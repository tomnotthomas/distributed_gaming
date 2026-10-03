// The streamer's window (streamer.cjs): captures the screen and holds the room
// with the session key it was started with, and reports each step of the
// session for the PC to act on (handoff.ts). It decides nothing about the
// session itself: a refusal or the end of the session is reported, and the
// PC says what happens next.

import { DEFAULT_CAPTURE, startHostSession, type HostSession } from "@swiff/rtc";
import type { StreamerCommand, StreamerEvent, StreamerInit } from "./handoff";

/** A command for the window: those of handoff.ts, and the game having been launched. */
export type StreamerWindowCommand =
  Exclude<StreamerCommand, { type: "launch-game" | "stop" }> | { type: "game-launched" };

/** The streamer window's calls (streamer-preload.cjs). */
export type StreamerBridge = {
  /** What the streamer was started with; `testPattern` streams a test pattern instead of the screen. */
  init(): Promise<(StreamerInit & { testPattern?: boolean }) | null>;
  report(event: StreamerEvent): void;
  onCommand(listener: (command: StreamerWindowCommand) => void): () => void;
};

export const streamerBridge = (): StreamerBridge | undefined =>
  (window as { swiffStreamer?: StreamerBridge }).swiffStreamer;

type Deps = {
  bridge: StreamerBridge;
  capture: () => Promise<MediaStream>;
  start: typeof startHostSession;
};

/** The primary screen at the stream's size and rate, with the PC's sound where there is any. */
async function captureScreen(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  const [track] = stream.getVideoTracks();
  await track.applyConstraints({ width: DEFAULT_CAPTURE.width, frameRate: DEFAULT_CAPTURE.frameRate });
  track.contentHint = "motion";
  return stream;
}

/** A moving test pattern in place of the screen, for the end-to-end tests. */
function capturePattern(): MediaStream {
  const canvas = Object.assign(document.createElement("canvas"), { width: 640, height: 360 });
  const ctx = canvas.getContext("2d")!;
  let frame = 0;
  setInterval(() => {
    frame += 1;
    ctx.fillStyle = `hsl(${(frame * 9) % 360} 70% 45%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, 50);
  return canvas.captureStream(20);
}

/** Run the streamer until the window closes. Resolves once it holds the room, or null when it cannot. */
export async function runStreamer({
  bridge,
  capture = captureScreen,
  start = startHostSession,
}: Partial<Deps> & { bridge: StreamerBridge }): Promise<HostSession | null> {
  const init = await bridge.init();
  if (!init) return null;
  const stream = init.testPattern ? capturePattern() : await capture();
  const session = start({
    url: init.url,
    hostId: init.hostId,
    sessionKey: init.sessionKey,
    stream,
    onPeerHere: (here) => {
      if (here) bridge.report({ type: "peer-joined" });
    },
    onPeerLeft: (grace) => bridge.report({ type: "peer-left", grace }),
    onPeerConnection: () => {},
    onFirstFrame: () => bridge.report({ type: "first-frame" }),
    onConnection: (state) => {
      if (state === "registered") bridge.report({ type: "registered" });
    },
    onDenied: (reason) => bridge.report({ type: "denied", ...(reason ? { reason } : {}) }),
  });
  bridge.onCommand((command) => {
    if (command.type === "key") session.rekey(command.sessionKey);
    else if (command.type === "game-launched") {
      session.gameStarted(init.appid);
      bridge.report({ type: "game-started", appid: init.appid });
    }
  });
  return session;
}
