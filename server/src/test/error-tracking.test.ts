import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { errorTrackingFromEnv } from "../error-tracking.js";

describe("errorTrackingFromEnv", () => {
  it("serves the web app's project: its public key and host, the host's trailing slash trimmed", () => {
    assert.deepEqual(
      errorTrackingFromEnv({
        VITE_POSTHOG_KEY: " phc_abc123 ",
        VITE_POSTHOG_HOST: "https://eu.i.posthog.com/",
      }),
      { key: "phc_abc123", host: "https://eu.i.posthog.com" },
    );
  });

  it("serves none without both, or with a key or host that is not PostHog's", () => {
    const on = { VITE_POSTHOG_KEY: "phc_abc123", VITE_POSTHOG_HOST: "https://eu.i.posthog.com" };
    assert.equal(errorTrackingFromEnv({}), null);
    assert.equal(errorTrackingFromEnv({ VITE_POSTHOG_KEY: on.VITE_POSTHOG_KEY }), null);
    assert.equal(errorTrackingFromEnv({ ...on, VITE_POSTHOG_KEY: "phx_personal_api_key" }), null);
    assert.equal(errorTrackingFromEnv({ ...on, VITE_POSTHOG_HOST: "http://eu.i.posthog.com" }), null);
    assert.equal(
      errorTrackingFromEnv({ ...on, VITE_POSTHOG_HOST: "https://posthog.com.evil.example" }),
      null,
    );
  });
});
