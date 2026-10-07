// Error reports from swiff-hostd to PostHog's error tracking
// (packages/error-tracking): what nothing in the agent caught, which also ends
// the run, as Node would have. Off unless the service's environment names a
// project (LANTEREL_POSTHOG_KEY and LANTEREL_POSTHOG_HOST, from
// /etc/lanterel/error-tracking.env), and off with DO_NOT_TRACK.
//
// The streamer gets the same three variables, and only those, so it reports
// to the same project or not at all. None of them is a secret: the key is the
// project's public one.

import {
  createTracker,
  errorTrackingConfig,
  type Send,
  type Tracker,
} from "../../../packages/error-tracking/src/index.ts";

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
