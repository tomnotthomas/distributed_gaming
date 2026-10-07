// The real server as a child process, for the tests that need one, and the
// waits those tests share. Every wait is on the event itself, bounded
// generously, so a loaded machine is slower but never fails a test, and a
// stuck child or socket fails it with a reason instead of hanging the file.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../index.js", import.meta.url));

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `promise`'s value, or `timedOut` if it has not settled within `ms`. Its
 * timer goes with it: one left running would hold the file open after its
 * last test.
 */
export async function within<T, U>(promise: Promise<T>, ms: number, timedOut: U): Promise<T | U> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<U>((resolve) => (timer = setTimeout(() => resolve(timedOut), ms)));
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Poll `check` until it holds; fail with `what` if it has not within `ms`. */
export async function until(check: () => boolean, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`not within ${ms / 1000} s: ${what}`);
    await wait(10);
  }
}

/** Ports given out in this file: each child gets its own. */
const usedPorts = new Set<number>();

/**
 * Start the real server with `env` on a port in [`from`, `from + span`), and
 * resolve once this child says it listens, not once the port answers: another
 * file's or another run's server on the same port answers too. A child that
 * exits first, as one does on a taken port, or cannot be spawned, is retried
 * on another port; one still silent after 60 s is stuck on its own startup, so
 * it fails at once. Its output is read to the end, so a full pipe never stalls
 * it, and the end of its stderr is kept: a child that never listens fails with
 * why.
 */
export async function startServer(
  env: Record<string, string>,
  { from, span }: { from: number; span: number },
): Promise<{ child: ChildProcess; port: number }> {
  /** How the last attempt ended, for the failure message. */
  let last = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    let port: number;
    do port = from + Math.floor(Math.random() * span);
    while (usedPorts.has(port));
    usedPorts.add(port);
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, ...env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let heard = "";
    let errors = "";
    /** Why the child could not be started at all, when it could not: it then may never exit. */
    const spawned: { error?: Error } = {};
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => (errors = (errors + chunk).slice(-2048)));
    const listening = new Promise<boolean>((resolve) => {
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        if (heard.length < 4096) heard += chunk;
        if (heard.includes(`localhost:${port} `)) resolve(true);
      });
      child.once("exit", () => resolve(false));
      child.on("error", (error) => {
        spawned.error ??= error;
        resolve(false);
      });
    });
    // Up to 60 s: it opens its database before it listens, slow on a loaded machine.
    if (await within(listening, 60_000, false)) return { child, port };
    const exited = child.exitCode !== null || child.signalCode !== null;
    await stopServer(child);
    const tail = errors ? `; stderr:\n${errors}` : "";
    if (!spawned.error && !exited)
      assert.fail(`the server on port ${port} was not listening after 60 s${tail}`);
    last = spawned.error
      ? `port ${port}: could not start: ${spawned.error.message}${tail}`
      : `port ${port}: exited with code ${child.exitCode}, signal ${child.signalCode}${tail}`;
  }
  assert.fail(`the server did not listen on any of five ports; last attempt ${last}`);
}

/** Stop a child server: SIGTERM, then SIGKILL if it has not gone within 5 s. */
export async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null || server.pid === undefined) return;
  const gone = new Promise<boolean>((resolve) => {
    server.once("exit", () => resolve(true));
    server.once("error", () => resolve(true));
  });
  server.kill("SIGTERM");
  if (await within(gone, 5_000, false)) return;
  server.kill("SIGKILL");
  await within(gone, 5_000, false);
}
