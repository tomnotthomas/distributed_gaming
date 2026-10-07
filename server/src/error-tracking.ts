// The PostHog project Lanterel Host and Lanterel OS report their errors to
// (packages/error-tracking), served to the host app at GET /api/error-tracking
// so an installer needs no key built in: the host app asks the server it
// already talks to, and writes the answer onto Lanterel OS's ESP at install.
//
// It is the web app's own project, from the same VITE_POSTHOG_KEY and
// VITE_POSTHOG_HOST: a public client key, which every page that loads the web
// app carries anyway. Only a PostHog project key and an https host on
// posthog.com are served; anything else serves none.

export type ErrorTracking = { key: string; host: string };

const KEY = /^phc_\w{1,100}$/;
const HOST = /^https:\/\/(?:[a-z0-9-]+\.)*posthog\.com$/;

/** The project from the environment, or null when it names none, or names one that is not PostHog's. */
export function errorTrackingFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ErrorTracking | null {
  const key = env.VITE_POSTHOG_KEY?.trim() ?? "";
  const host = env.VITE_POSTHOG_HOST?.trim().replace(/\/+$/, "") ?? "";
  return KEY.test(key) && HOST.test(host) ? { key, host } : null;
}
