import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

  it("takes the same projects as @swiff/error-tracking's projectOf, on its table of cases", () => {
    const cases = JSON.parse(
      readFileSync(new URL("../../../packages/error-tracking/src/project-cases.json", import.meta.url), "utf8"),
    ) as { what: string; key: string; host: string; origin: string | null }[];
    for (const { what, key, host, origin } of cases)
      assert.deepEqual(
        errorTrackingFromEnv({ VITE_POSTHOG_KEY: key, VITE_POSTHOG_HOST: host }),
        origin === null ? null : { key, host: origin },
        what,
      );
  });
});
