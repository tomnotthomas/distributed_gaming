// The real posthog-js, started the way posthog.ts starts it, on a pairing
// address: nothing it sends the PostHog host carries the pairing hash.

import { afterEach, expect, test, vi } from "vitest";

const HASH = "3f9a2c".padEnd(64, "0");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("no PostHog request carries the pairing hash, flags included", async () => {
  history.replaceState(null, "", `/pair?k=${HASH}`);
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_test");
  vi.stubEnv("VITE_POSTHOG_HOST", "https://ph.test");
  const sent: { url: string; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = init?.body;
      sent.push({
        url: String(url),
        body: body instanceof Blob ? await body.text() : String(body ?? ""),
      });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );

  const { default: posthog } = await import("./posthog");
  posthog.capture("$pageview");
  await vi.waitFor(() => expect(sent.some((r) => r.url.includes("/flags"))).toBe(true));

  for (const request of sent) {
    expect(request.url).not.toContain(HASH);
    expect(request.body).not.toContain(HASH);
  }
});
