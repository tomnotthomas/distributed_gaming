// The PostHog project Lanterel Host and Lanterel OS report their errors to
// (packages/error-tracking), served to the host app at GET /api/error-tracking
// so an installer needs no key built in: the host app asks the server it
// already talks to, and writes the answer onto Lanterel OS's ESP at install.
//
// It is the web app's own project, from the same VITE_POSTHOG_KEY and
// VITE_POSTHOG_HOST: a public client key, which every page that loads the web
// app carries anyway. Only a PostHog project key and an https origin on
// posthog.com are served; anything else serves none. The rule is projectOf in
// packages/error-tracking, the source of truth, copied here so the server needs
// no dependency on it; error-tracking.test.ts runs both on the same cases
// (packages/error-tracking/src/project-cases.json).

export type ErrorTracking = { key: string; host: string };

const KEY = /^phc_\w{1,100}$/;

/** `host` as an https origin on posthog.com, lower-case and without a trailing slash, or null. */
function posthogOrigin(host: string): string | null {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return null;
  }
  const onPosthog = url.hostname === "posthog.com" || url.hostname.endsWith(".posthog.com");
  const bare =
    !url.username && !url.password && !url.port && url.pathname === "/" && !url.search && !url.hash;
  return url.protocol === "https:" && onPosthog && bare ? url.origin : null;
}

/** The project from the environment, or null when it names none, or names one that is not PostHog's. */
export function errorTrackingFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ErrorTracking | null {
  const key = env.VITE_POSTHOG_KEY?.trim() ?? "";
  const host = posthogOrigin(env.VITE_POSTHOG_HOST?.trim() ?? "");
  return KEY.test(key) && host ? { key, host } : null;
}
