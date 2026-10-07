// Paid gaming (features.ts): the PostHog flag "paid-gaming", asked with the
// project's public key, kept a while, off whenever PostHog cannot say, and
// overridden by PAID_GAMING.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createFeatures,
  FLAG_TTL_MS,
  featuresOptionsFromEnv,
  withFeatures,
  type FeaturesOptions,
} from "../features.js";

/** A PostHog flags endpoint answering `body` (or failing), and the calls it got. */
function posthog(answer: () => unknown) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    const body = answer();
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const on = { flags: { "paid-gaming": { key: "paid-gaming", enabled: true } } };
const off = { flags: { "paid-gaming": { key: "paid-gaming", enabled: false } } };
const base: FeaturesOptions = { override: null, key: "phc_test", host: "https://eu.i.posthog.com" };

describe("paid gaming", () => {
  it("is on when PostHog has the flag on, asked with the public key", async () => {
    const ph = posthog(() => on);
    assert.deepEqual(await createFeatures({ ...base, fetch: ph.fetch }).current(), { paidGaming: true });
    assert.equal(ph.calls[0]!.url, "https://eu.i.posthog.com/flags/?v=2");
    assert.deepEqual(ph.calls[0]!.body, { api_key: "phc_test", distinct_id: "lanterel-server" });
  });

  it("is off when PostHog has it off, has not got it, or answers the older shape with it off", async () => {
    for (const answer of [off, { flags: {} }, { featureFlags: { "paid-gaming": false } }, {}]) {
      const ph = posthog(() => answer);
      assert.deepEqual(await createFeatures({ ...base, fetch: ph.fetch }).current(), { paidGaming: false });
    }
    const older = posthog(() => ({ featureFlags: { "paid-gaming": true } }));
    assert.equal((await createFeatures({ ...base, fetch: older.fetch }).current()).paidGaming, true);
  });

  it("is off while PostHog cannot be reached, and asks again later", async () => {
    let t = 0;
    let answer: unknown = new Error("unreachable");
    const ph = posthog(() => answer);
    const features = createFeatures({ ...base, fetch: ph.fetch, now: () => t });
    assert.equal((await features.current()).paidGaming, false);
    answer = on;
    t += FLAG_TTL_MS;
    // The stale answer is used while a fresh one is asked for; the next ask has it.
    assert.equal((await features.current()).paidGaming, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await features.current()).paidGaming, true);
  });

  it("keeps an answer for a while instead of asking PostHog on every page", async () => {
    let t = 0;
    const ph = posthog(() => on);
    const features = createFeatures({ ...base, fetch: ph.fetch, now: () => t });
    await Promise.all([features.current(), features.current()]);
    t += FLAG_TTL_MS - 1;
    await features.current();
    assert.equal(ph.calls.length, 1);
  });

  it("follows PAID_GAMING over PostHog, and is off with no key at all", async () => {
    const ph = posthog(() => on);
    assert.equal(
      (await createFeatures({ ...base, override: false, fetch: ph.fetch }).current()).paidGaming,
      false,
    );
    const phOff = posthog(() => off);
    assert.equal(
      (await createFeatures({ ...base, override: true, fetch: phOff.fetch }).current()).paidGaming,
      true,
    );
    assert.equal((await createFeatures({ ...base, key: null, fetch: ph.fetch }).current()).paidGaming, false);
    assert.equal(ph.calls.length + phOff.calls.length, 0);
  });

  it("reads its settings from the environment, the web build's PostHog key included", () => {
    assert.deepEqual(featuresOptionsFromEnv({}), {
      override: null,
      key: null,
      host: "https://eu.i.posthog.com",
    });
    assert.deepEqual(
      featuresOptionsFromEnv({
        PAID_GAMING: "On",
        VITE_POSTHOG_KEY: "phc_x",
        VITE_POSTHOG_HOST: "https://x.test",
      }),
      { override: true, key: "phc_x", host: "https://x.test" },
    );
    assert.equal(featuresOptionsFromEnv({ PAID_GAMING: "off", POSTHOG_KEY: "phc_y" }).override, false);
  });

  it("tells the web app in the page's head", () => {
    assert.equal(
      withFeatures("<head><title>L</title></head>", { paidGaming: false }),
      '<head><title>L</title><meta name="paid-gaming" content="off"></head>',
    );
  });
});
