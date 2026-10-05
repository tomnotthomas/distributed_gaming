// Starting the streamer for a renter session, as its own unprivileged user.
//
// The streamer gets exactly one secret, the session key, and gets it on stdin:
// a command line is readable by every user through /proc. Everything else it
// needs is not secret and comes in its environment:
//
//   SWIFF_SERVER_URL  ws:// or wss:// origin of the signaling server
//   SWIFF_HOST_ID     the machine id, its room
//   SWIFF_APPID       the Steam game booked, when the agent knows it
//
//   stdin             one JSON line { "sessionKey": "...", "expiresAt": <Unix s> }, then closed
//
// It registers with { type: "register", hostId, sessionKey } and serves the
// renter. It exits when the server puts it out (`denied`), whatever the reason:
// the agent decides what follows from where the session stands, never from how
// the streamer ended.

import { spawn } from "node:child_process";
import type { SessionGrant } from "../../../server/src/protocol.ts";
import type { StreamerConfig } from "./config.ts";

export type Streamer = {
  /** Resolves when the process has exited, however it ended. */
  exited: Promise<void>;
  /** Ask it to stop, then make it: SIGTERM, and SIGKILL after the grace period. Resolves once exited. */
  stop(): Promise<void>;
};

/** Start the streamer for one session with its key. */
export type LaunchStreamer = (grant: SessionGrant, appid: number | null) => Streamer;

const STOP_GRACE_MS = 5_000;

export function streamerLauncher(
  config: StreamerConfig,
  serverUrl: string,
  hostId: string,
  stopGraceMs = STOP_GRACE_MS,
): LaunchStreamer {
  return (grant, appid) => {
    const child = spawn(config.command, config.args, {
      uid: config.uid,
      gid: config.gid,
      stdio: ["pipe", "inherit", "inherit"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        SWIFF_SERVER_URL: serverUrl,
        SWIFF_HOST_ID: hostId,
        ...(appid === null ? {} : { SWIFF_APPID: String(appid) }),
      },
    });
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      // A streamer that cannot even start has exited, as far as the agent is concerned.
      child.once("error", (cause) => {
        console.error(`[swiff-hostd] streamer did not start: ${cause.message}`);
        resolve();
      });
    });
    // The key goes to the streamer alone; a streamer that died first has no use for it.
    child.stdin.on("error", () => {});
    child.stdin.end(`${JSON.stringify({ sessionKey: grant.sessionKey, expiresAt: grant.expiresAt })}\n`);

    return {
      exited,
      stop: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        const killer = setTimeout(() => child.kill("SIGKILL"), stopGraceMs);
        await exited;
        clearTimeout(killer);
      },
    };
  };
}
