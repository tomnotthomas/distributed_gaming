// Error reports from the streamer to PostHog's error tracking
// (packages/error-tracking): a failure that ends the session's stream, and what
// nothing caught. swiff-hostd hands on LANTEREL_POSTHOG_KEY, LANTEREL_POSTHOG_HOST
// and DO_NOT_TRACK from its own environment, so the streamer reports to the
// agent's project or not at all. The session key never reaches a report: it is
// a long opaque string, which scrubbing cuts, and the machine id is cut by name.

import {
  createTracker,
  errorTrackingConfig,
  type Send,
  type Tracker,
} from "../../../packages/error-tracking/src/index.ts";

export function streamerTracker(env: NodeJS.ProcessEnv, send?: Send): Tracker {
  return createTracker({
    config: errorTrackingConfig(env),
    service: "swiff-streamer",
    secrets: env.SWIFF_HOST_ID ? [env.SWIFF_HOST_ID] : [],
    ...(send && { send }),
  });
}
