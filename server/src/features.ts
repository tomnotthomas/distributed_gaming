// Product switches, decided here and told to the web app and the host app
// (GET /api/features, and a meta tag in every page of the web app). Neither
// app asks PostHog itself: they read the server's decision.
//
// Paid gaming turns on the paid marketplace: the game wall as the app's start
// page, PCs of people you don't know, and everything about earning money with
// your PC. Off, Lanterel is crews only: "/" is the start page (marketing.ts,
// createStartPages), signed-in players land on their crew, and the host app
// shows nothing about money.
//
// It is the PostHog feature flag "paid-gaming", evaluated here with the
// project's public key (POSTHOG_KEY, or the web build's VITE_POSTHOG_KEY; the
// host from POSTHOG_HOST or VITE_POSTHOG_HOST, EU by default) and kept for
// FLAG_TTL_MS. PAID_GAMING=on or off in the environment overrides PostHog.
// Without a key, or until PostHog has answered once, it is off; when PostHog
// cannot be reached later, its last answer stays.

/** The switches, as GET /api/features answers them. */
export type Features = { paidGaming: boolean };

/** The PostHog flag that is paid gaming. */
export const PAID_GAMING_FLAG = "paid-gaming";

/** How long a PostHog answer is used before it is asked again. */
export const FLAG_TTL_MS = 60_000;

/** How long one PostHog call may take before the switch counts as off. */
export const FLAG_TIMEOUT_MS = 2_000;

/** Who the server asks PostHog as: the switch is the same for everyone. */
const DISTINCT_ID = "lanterel-server";

export type FeaturesOptions = {
  /** PAID_GAMING from the environment: true or false overrides PostHog, null leaves it to PostHog. */
  override: boolean | null;
  /** The project's public key; null: no PostHog, so off. */
  key: string | null;
  /** PostHog's ingestion host, e.g. https://eu.i.posthog.com. */
  host: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

/** The options from the environment. */
export function featuresOptionsFromEnv(env: NodeJS.ProcessEnv): FeaturesOptions {
  const set = env.PAID_GAMING?.trim().toLowerCase();
  const key = (env.POSTHOG_KEY ?? env.VITE_POSTHOG_KEY)?.trim() || null;
  const host = (env.POSTHOG_HOST ?? env.VITE_POSTHOG_HOST)?.trim() || "https://eu.i.posthog.com";
  return { override: set === "on" ? true : set === "off" ? false : null, key, host };
}

/** Whether PostHog's v2 flags answer ({ flags }) has the flag on. */
function flagOn(body: unknown, flag: string): boolean {
  if (typeof body !== "object" || body === null) return false;
  const { flags } = body as { flags?: unknown };
  if (typeof flags !== "object" || flags === null) return false;
  const entry = (flags as Record<string, unknown>)[flag];
  return typeof entry === "object" && entry !== null && (entry as { enabled?: unknown }).enabled === true;
}

/**
 * The switches, as they are now. The first ask waits for PostHog (at most
 * FLAG_TIMEOUT_MS); after that an answer up to FLAG_TTL_MS old is used at
 * once, and an older one is used while a fresh one is asked for, so no page
 * waits on PostHog twice. A failed ask keeps the last answer PostHog gave,
 * and is off only when it never gave one.
 */
export function createFeatures({
  override,
  key,
  host,
  fetch = (...args) => globalThis.fetch(...args),
  now = Date.now,
}: FeaturesOptions) {
  let known: { value: Features; at: number } | null = null;
  let asking: Promise<Features> | null = null;

  async function ask(): Promise<Features> {
    let value = known?.value ?? { paidGaming: false };
    try {
      const res = await fetch(`${host.replace(/\/+$/, "")}/flags/?v=2`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: key, distinct_id: DISTINCT_ID }),
        signal: AbortSignal.timeout(FLAG_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`PostHog answered ${res.status}`);
      value = { paidGaming: flagOn(await res.json(), PAID_GAMING_FLAG) };
    } catch {
      // Unreachable, failing, too slow or not JSON: the last answer, or off.
    }
    known = { value, at: now() };
    return value;
  }

  function refresh(): Promise<Features> {
    asking ??= ask().finally(() => (asking = null));
    return asking;
  }

  return {
    async current(): Promise<Features> {
      if (override !== null) return { paidGaming: override };
      if (!key) return { paidGaming: false };
      if (!known) return refresh();
      if (now() - known.at >= FLAG_TTL_MS) void refresh();
      return known.value;
    },
  };
}

export type FeatureSwitches = ReturnType<typeof createFeatures>;

/** The meta tag the web app reads its switches from (web/src/swiff/features.ts). */
export const featuresMeta = (features: Features): string =>
  `<meta name="paid-gaming" content="${features.paidGaming ? "on" : "off"}">`;

/** `html` (the web app's index.html) with the switches in its head. */
export const withFeatures = (html: string, features: Features): string =>
  html.replace("</head>", `${featuresMeta(features)}</head>`);
