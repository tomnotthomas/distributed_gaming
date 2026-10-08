// The real posthog-js, started the way posthog.ts starts it, on a pairing
// address: nothing it sends the PostHog host carries the pairing hash.

import { gunzipSync } from "node:zlib";
import { afterEach, expect, test, vi } from "vitest";

const HASH = "3f9a2c".padEnd(64, "0");

/** A request body as text: events go out as bytes, gzipped when compressed. */
async function bodyText(body: BodyInit | null | undefined): Promise<string> {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  const bytes = Buffer.from(
    body instanceof Blob
      ? await body.arrayBuffer()
      : body instanceof ArrayBuffer
        ? body
        : ArrayBuffer.isView(body)
          ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
          : new TextEncoder().encode(String(body)).buffer,
  );
  return (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString("utf8");
}

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
      sent.push({ url: String(url), body: await bodyText(init?.body) });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );

  const { default: posthog } = await import("./posthog");
  posthog.capture("$pageview");
  // Both the flags request and the pageview itself, read as sent, before anything is checked.
  await vi.waitFor(() => {
    expect(sent.some((r) => r.url.includes("/flags"))).toBe(true);
    expect(sent.some((r) => r.body.includes('"$pageview"'))).toBe(true);
  });

  for (const request of sent) {
    expect(request.url).not.toContain(HASH);
    expect(request.body).not.toContain(HASH);
  }
});
