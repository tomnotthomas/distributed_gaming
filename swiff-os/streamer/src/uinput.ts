// The virtual input devices: helpers/swiff-uinput.py, fed by uinputEvents.ts.
//
// Started once per streamer, before any renter connects, so the session has
// seen the keyboard and mouse appear long before the first key. Stopping it
// removes the devices, which lets go of anything still held.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { InputSink } from "@swiff/rtc";
import type { StreamerConfig } from "./config";
import { KEYBOARD_KEYS } from "./keymap";
import { createUinputSink } from "./uinputEvents";

export type VirtualInput = { sink: InputSink; stop(): Promise<void> };

const RESTART_DELAY_MS = 1_000;
const MAX_RESTART_DELAY_MS = 30_000;
const STOP_GRACE_MS = 2_000;

export function startVirtualInput({
  config,
  spawn = nodeSpawn,
  log = (m) => console.error(m),
}: {
  config: Pick<StreamerConfig, "python" | "helperDir">;
  spawn?: typeof nodeSpawn;
  log?: (message: string) => void;
}): VirtualInput {
  const helper = join(config.helperDir, "swiff-uinput.py");
  let child: ChildProcess | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = RESTART_DELAY_MS;
  let started = false;

  // Backpressure: a full pipe stops the writes until it drains (see createUinputSink).
  const sink = createUinputSink((records) => {
    if (!child?.stdin?.writable) return true; // no helper: dropped, nothing to wait for
    return child.stdin.write(records);
  });

  const start = () => {
    timer = null;
    if (stopped) return;
    const proc = spawn(config.python, [helper, "--keys", KEYBOARD_KEYS.join(",")], {
      stdio: ["pipe", "ignore", "inherit"],
    });
    child = proc;
    proc.stdin!.on("error", () => {});
    proc.stdin!.on("drain", () => sink.drained());
    // A restarted helper has fresh devices: press again whatever the renter still holds.
    if (started) sink.reset();
    started = true;
    proc.once("error", (cause) => log(`[swiff-streamer] input helper did not start: ${cause.message}`));
    const startedAt = Date.now();
    proc.once("close", (code) => {
      if (child === proc) child = null;
      if (stopped) return;
      // Most likely no access to /dev/uinput: the renter sees the picture but cannot play.
      // A helper that ran a while gets a quick restart; one that cannot start, a slower one.
      delay =
        Date.now() - startedAt > MAX_RESTART_DELAY_MS
          ? RESTART_DELAY_MS
          : Math.min(delay * 2, MAX_RESTART_DELAY_MS);
      log(`[swiff-streamer] input helper stopped (exit ${code}); starting it again in ${delay / 1000} s`);
      timer = setTimeout(start, delay);
    });
  };
  start();

  return {
    sink,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      const proc = child;
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
      const exited = new Promise((resolve) => proc.once("close", resolve));
      // Closing stdin is the helper's cue to remove its devices and exit.
      proc.stdin!.end();
      const killer = setTimeout(() => proc.kill("SIGKILL"), STOP_GRACE_MS);
      await exited;
      clearTimeout(killer);
    },
  };
}
