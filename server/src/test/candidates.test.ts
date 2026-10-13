import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_MAX_RTT_MS } from "@swiff/rank";
import { maxRttMsFromEnv } from "../candidates.js";

describe("the latency gate from the environment", () => {
  it("takes a positive whole number of ms", () => {
    assert.equal(maxRttMsFromEnv("120"), 120);
    assert.equal(maxRttMsFromEnv("1"), 1);
  });

  it("keeps rank()'s default when unset", () => {
    assert.equal(maxRttMsFromEnv(undefined), DEFAULT_MAX_RTT_MS);
    assert.equal(maxRttMsFromEnv(""), DEFAULT_MAX_RTT_MS);
  });

  it("refuses anything else, for the server to warn and keep the default", () => {
    for (const value of ["0", "-5", "abc", "12.5", "Infinity", "1e400"]) {
      assert.equal(maxRttMsFromEnv(value), null, `for ${value}`);
    }
  });
});
