// Error reports from swiff-steam-login to PostHog's error tracking
// (packages/error-tracking): Steam that does not start, and what nothing
// caught. Off unless the session's environment names a project
// (LANTEREL_POSTHOG_KEY and LANTEREL_POSTHOG_HOST, which swiff-session.service
// takes from swiff-error-tracking.service), and off with DO_NOT_TRACK.
// The renter's Steam account never reaches a report: scrubbing cuts Steam IDs,
// and the home directory's user name out of every path.

import {
  createTracker,
  errorTrackingConfig,
  type Send,
  type Tracker,
} from "../../../packages/error-tracking/src/index.ts";

export function steamLoginTracker(env: NodeJS.ProcessEnv, send?: Send): Tracker {
  return createTracker({
    config: errorTrackingConfig(env),
    service: "swiff-steam-login",
    ...(send && { send }),
  });
}
