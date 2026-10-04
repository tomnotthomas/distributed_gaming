import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRenterGrace } from "../grace.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("reconnect grace", () => {
  const recorder = (graceMs = 40) => {
    const expired: [string, string][] = [];
    const grace = createRenterGrace({ graceMs, onExpire: (host, ticket) => expired.push([host, ticket]) });
    return { grace, expired };
  };

  it("ends a renter's grace once it runs out", async () => {
    const { grace, expired } = recorder();
    grace.start("pc-1", "t-1");
    assert.equal(grace.pending("pc-1"), "t-1");
    await wait(80);
    assert.deepEqual(expired, [["pc-1", "t-1"]]);
    assert.equal(grace.pending("pc-1"), null);
  });

  it("says when a room's clock runs out, while it runs", () => {
    const { grace } = recorder(60_000);
    const before = Date.now();
    grace.start("pc-1", "t-1");
    const until = grace.until("pc-1");
    assert.ok(until !== null && until >= before + 60_000 && until <= Date.now() + 60_000);
    assert.equal(grace.until("pc-2"), null);
    grace.cancel("pc-1");
    assert.equal(grace.until("pc-1"), null);
  });

  it("stops the clock when the same renter comes back, and only then", async () => {
    const { grace, expired } = recorder();
    grace.start("pc-1", "t-1");
    assert.equal(grace.cancel("pc-1", "t-2"), false);
    assert.equal(grace.cancel("pc-1", "t-1"), true);
    await wait(80);
    assert.deepEqual(expired, []);
  });

  it("stops the clock with no ticket named, as a session ending does", async () => {
    const { grace, expired } = recorder();
    grace.start("pc-1", "t-1");
    assert.equal(grace.cancel("pc-1"), true);
    assert.equal(grace.cancel("pc-1"), false);
    await wait(80);
    assert.deepEqual(expired, []);
  });

  it("keeps one clock per room, restarted by a later drop", async () => {
    const { grace, expired } = recorder(60);
    grace.start("pc-1", "t-1");
    grace.start("pc-2", "t-9");
    await wait(30);
    grace.start("pc-1", "t-1");
    await wait(45);
    assert.deepEqual(expired, [["pc-2", "t-9"]]);
    await wait(40);
    assert.deepEqual(expired, [
      ["pc-2", "t-9"],
      ["pc-1", "t-1"],
    ]);
  });
});
