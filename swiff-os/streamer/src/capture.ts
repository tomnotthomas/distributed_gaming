// Runs the capture helpers and turns their output into RTP packets.
//
// Picks the encoder once, at start: the first of the candidates (pipeline.ts)
// whose check pipeline encodes a few frames cleanly. Then it keeps one helper
// per medium running for as long as the streamer lives, so the picture is
// ready before the renter connects. A helper that exits — gamescope restarted
// and its PipeWire node went with it, or the sink changed — is started again
// after a short wait; a run that produced packets resets the wait.
//
// Video failing to start at all is the streamer's problem (it cannot serve the
// renter); sound failing is logged and retried, and the picture goes on.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { StreamerConfig } from "./config";
import { readGpus, type Gpu } from "./gpu";
import {
  audioPipeline,
  ENCODER_ELEMENTS,
  encoderCandidates,
  encoderCheckPipeline,
  videoPipeline,
  type Encoder,
} from "./pipeline";
import { createRtpDeframer } from "./rtpFrames";

export type MediaKind = "video" | "audio";

export type Capture = {
  readonly encoder: Encoder;
  /**
   * Settles once the first video packet arrives, or rejects with CaptureError
   * when none has after `firstVideoTimeoutMs`: the source never opened
   * (gamescope's node is missing), and the renter would wait on a black screen.
   */
  readonly videoStarted: Promise<void>;
  /** Ask the encoder for a keyframe; requests closer together than KEYFRAME_GAP_MS are one. */
  requestKeyframe(): void;
  /** Stop every helper and wait for them to exit. */
  stop(): Promise<void>;
};

export type CaptureOptions = {
  config: StreamerConfig;
  onPacket: (kind: MediaKind, packet: Buffer) => void;
  spawn?: typeof nodeSpawn;
  log?: (message: string) => void;
  restartDelayMs?: number;
  firstVideoTimeoutMs?: number;
  /** Aborting stops the start-up: a running check is killed and no helper starts after it. */
  signal?: AbortSignal;
  /** The PC's graphics cards, which decide the encoders' order; read from sysfs when not given. */
  gpus?: readonly Gpu[];
};

/** No working H.264 encoder on this PC, no picture from the source, or start-up aborted. */
export class CaptureError extends Error {}

/** Long enough for gamescope to come up after the streamer, short enough that a renter is not left waiting. */
export const FIRST_VIDEO_TIMEOUT_MS = 30_000;

/** A renter's decoder repeats its PLI until a keyframe lands; one keyframe answers a burst. */
export const KEYFRAME_GAP_MS = 250;
const MAX_RESTART_DELAY_MS = 5_000;
const STOP_GRACE_MS = 2_000;

export async function startCapture({
  config,
  onPacket,
  spawn = nodeSpawn,
  log = (m) => console.error(m),
  restartDelayMs = 500,
  firstVideoTimeoutMs = FIRST_VIDEO_TIMEOUT_MS,
  signal,
  gpus = readGpus(),
}: CaptureOptions): Promise<Capture> {
  const aborted = () => {
    if (signal?.aborted) throw new CaptureError("capture start-up was aborted");
  };
  const helper = join(config.helperDir, "swiff-gst.py");
  const env = {
    ...process.env,
    // The renter's PipeWire, not this user's own (it runs none).
    ...(config.pipewireRemote ? { PIPEWIRE_REMOTE: config.pipewireRemote } : {}),
  };
  const run = (args: string[], stdio: ("pipe" | "ignore" | "inherit")[]) =>
    spawn(config.python, [helper, ...args], { env, stdio });

  /** Run a helper to the end; resolve with its stdout and whether it exited 0. */
  const finish = (args: string[]) =>
    new Promise<{ ok: boolean; stdout: string }>((resolve) => {
      const child = run(args, ["ignore", "pipe", "inherit"]);
      // An abort kills the check now: encoder checks can hang on a bad GPU driver.
      const kill = () => child.kill("SIGKILL");
      signal?.addEventListener("abort", kill, { once: true });
      child.once("close", () => signal?.removeEventListener("abort", kill));
      let stdout = "";
      child.stdout!.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.once("error", () => resolve({ ok: false, stdout }));
      child.once("close", (code) => resolve({ ok: code === 0, stdout }));
    });

  aborted();
  if (config.encoder === "auto") {
    const cards = gpus.map((g) => `${g.vendor} (${g.driver ?? "no driver"})`).join(", ");
    log(`[swiff-streamer] graphics: ${cards || "not read"}`);
  }
  const available =
    config.encoder === "auto"
      ? new Set((await finish(["--probe", ...Object.values(ENCODER_ELEMENTS).flat()])).stdout.split("\n"))
      : new Set<string>();
  let encoder: Encoder | null = null;
  for (const candidate of encoderCandidates(config.encoder, available, gpus)) {
    aborted();
    if ((await finish(["--check", encoderCheckPipeline(config, candidate)])).ok) {
      encoder = candidate;
      break;
    }
    log(`[swiff-streamer] the ${candidate} encoder does not work here`);
  }
  aborted();
  if (!encoder) throw new CaptureError("no H.264 encoder works on this PC");
  log(`[swiff-streamer] encoding with ${encoder}`);

  let stopped = false;
  let firstVideo!: () => void;
  const videoStarted = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new CaptureError(`no picture from the source after ${firstVideoTimeoutMs / 1000} s`)),
      firstVideoTimeoutMs,
    );
    firstVideo = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  // Nobody may be waiting on it yet (the session can end first); a rejection then is not a crash.
  videoStarted.catch(() => {});
  const video = supervise("video", videoPipeline(config, encoder));
  const audioText = audioPipeline(config);
  const audio = audioText ? supervise("audio", audioText) : null;
  let lastKeyframe = -Infinity;

  /** Keep one helper running `pipeline`, starting it again whenever it exits. */
  function supervise(kind: MediaKind, pipeline: string) {
    let child: ChildProcess | null = null;
    let delay = restartDelayMs;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const start = () => {
      timer = null;
      if (stopped) return;
      let produced = false;
      const deframe = createRtpDeframer((packet) => {
        produced = true;
        if (kind === "video") firstVideo();
        onPacket(kind, packet);
      });
      const proc = run([pipeline], ["pipe", "pipe", "inherit"]);
      child = proc;
      // Writes to a helper that just died fail with EPIPE; its exit is handled below.
      proc.stdin!.on("error", () => {});
      proc.stdout!.on("data", deframe);
      proc.once("error", (cause) => log(`[swiff-streamer] ${kind} helper did not start: ${cause.message}`));
      proc.once("close", (code) => {
        if (child === proc) child = null;
        if (stopped) return;
        delay = produced ? restartDelayMs : Math.min(delay * 2, MAX_RESTART_DELAY_MS);
        log(`[swiff-streamer] ${kind} capture stopped (exit ${code}); starting it again`);
        timer = setTimeout(start, delay);
      });
    };
    start();

    return {
      command(line: string) {
        if (child?.stdin?.writable) child.stdin.write(`${line}\n`);
      },
      async stop() {
        if (timer) clearTimeout(timer);
        const proc = child;
        if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
        const exited = new Promise((resolve) => proc.once("close", resolve));
        proc.kill("SIGTERM");
        const killer = setTimeout(() => proc.kill("SIGKILL"), STOP_GRACE_MS);
        await exited;
        clearTimeout(killer);
      },
    };
  }

  return {
    encoder,
    videoStarted,
    requestKeyframe() {
      const now = Date.now();
      if (now - lastKeyframe < KEYFRAME_GAP_MS) return;
      lastKeyframe = now;
      video.command("keyframe");
    },
    async stop() {
      stopped = true;
      await Promise.all([video.stop(), audio?.stop()]);
    },
  };
}
