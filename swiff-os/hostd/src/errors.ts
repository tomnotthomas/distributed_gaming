// Error reports from swiff-hostd to PostHog's error tracking
// (packages/error-tracking): what nothing in the agent caught, which also ends
// the run, as Node would have. Off unless a project is named
// (LANTEREL_POSTHOG_KEY and LANTEREL_POSTHOG_HOST, in the file Lanterel Host
// writes onto Lanterel OS's ESP at install, or in the service's environment),
// and off with DO_NOT_TRACK.
//
// The streamer gets the same three variables, and only those, so it reports
// to the same project or not at all. None of them is a secret: the key is the
// project's public one.

import { open, rename, writeFile } from "node:fs/promises";
import {
  createTracker,
  errorTrackingConfig,
  projectOf,
  type Send,
  type Tracker,
} from "../../../packages/error-tracking/src/index.ts";

/** What the agent takes from the error-tracking file, and nothing else. */
const FILE_VARIABLES = new Set(["LANTEREL_POSTHOG_KEY", "LANTEREL_POSTHOG_HOST"]);

/** A longer file is not the one Lanterel Host writes. */
const MAX_FILE_BYTES = 4096;

/**
 * LANTEREL_POSTHOG_KEY and LANTEREL_POSTHOG_HOST from the file at `path`
 * (NAME=value lines), and none when there is no such file. The ESP is not
 * verified like the root, and Windows can write it: no other name is taken
 * from it, and errorTrackingConfig takes these only as a project key and an
 * https host on posthog.com.
 */
export async function errorTrackingFile(path: string | undefined): Promise<Record<string, string>> {
  if (!path) return {};
  let text: string;
  try {
    const file = await open(path, "r");
    try {
      if ((await file.stat()).size > MAX_FILE_BYTES) return {};
      text = await file.readFile("utf8");
    } finally {
      await file.close();
    }
  } catch {
    return {};
  }
  return Object.fromEntries(
    text.split(/\r?\n/).flatMap((line) => {
      const at = line.indexOf("=");
      const name = line.slice(0, at).trim();
      return at > 0 && FILE_VARIABLES.has(name) ? [[name, line.slice(at + 1).trim()]] : [];
    }),
  );
}

/** What the agent passes on to the streamer, when it is set. */
export const ERROR_TRACKING_ENV = ["LANTEREL_POSTHOG_KEY", "LANTEREL_POSTHOG_HOST", "DO_NOT_TRACK"] as const;

/** The error-tracking variables set in `env`, and no others. */
export function errorTrackingEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    ERROR_TRACKING_ENV.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])),
  );
}

/**
 * The agent's tracker. `secrets` is the agent's own list of what never leaves
 * the machine (its machine id and key), filled in as it reads them: each
 * report is scrubbed of what the list holds by then.
 */
export function hostdTracker(env: NodeJS.ProcessEnv, secrets: readonly string[], send?: Send): Tracker {
  return createTracker({
    config: errorTrackingConfig(env),
    service: "swiff-hostd",
    secrets,
    ...(send && { send }),
  });
}

/**
 * The renter session's error-tracking environment (NAME=value lines) from the
 * agent's: the project only, checked as the agent checks it, and nothing at
 * all when there is none. swiff-steam-login runs in the renter's session,
 * which cannot read the ESP, so `swiff-hostd session-env` writes this for
 * swiff-session.service to read as root (swiff-error-tracking.service).
 */
export function sessionEnv(env: NodeJS.ProcessEnv): string {
  const config = errorTrackingConfig(env);
  const project = config && projectOf(config);
  if (!project) return "";
  return `LANTEREL_POSTHOG_KEY=${project.key}\nLANTEREL_POSTHOG_HOST=${project.host}\n`;
}

/** Write sessionEnv(env) to `path`, whole or not at all, readable by root alone. */
export async function writeSessionEnv(path: string, env: NodeJS.ProcessEnv): Promise<void> {
  const next = `${path}.next`;
  await writeFile(next, sessionEnv(env), { mode: 0o600 });
  await rename(next, path);
}
