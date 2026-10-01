// The per-renter budget of discovery reads, against a clock moved by hand.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { RequestBudget } from "../budget.js";

describe("request budget", () => {
  let now: number;
  let budget: RequestBudget;

  beforeEach(() => {
    now = 1_000_000;
    budget = new RequestBudget({ burst: 3, refillMs: 1_000, now: () => now });
  });

  it("lets a burst through, then says how long until the next request may go", () => {
    for (let i = 0; i < 3; i++) assert.equal(budget.take("a"), 0);
    assert.equal(budget.take("a"), 1_000);
    now += 400;
    assert.equal(budget.take("a"), 600);
    now += 600;
    assert.equal(budget.take("a"), 0);
    assert.equal(budget.take("a"), 1_000);
  });

  it("spends nothing on a refused request", () => {
    for (let i = 0; i < 3; i++) budget.take("a");
    for (let i = 0; i < 5; i++) assert.ok(budget.take("a") > 0);
    now += 1_000;
    assert.equal(budget.take("a"), 0);
  });

  it("refills to the burst and no further", () => {
    for (let i = 0; i < 3; i++) budget.take("a");
    now += 60_000;
    for (let i = 0; i < 3; i++) assert.equal(budget.take("a"), 0);
    assert.ok(budget.take("a") > 0);
  });

  it("keeps each renter's budget separate", () => {
    for (let i = 0; i < 3; i++) budget.take("a");
    assert.ok(budget.take("a") > 0);
    assert.equal(budget.take("b"), 0);
  });

  it("starts a renter who was forgotten among many others from a full bucket", () => {
    for (let i = 0; i < 3; i++) budget.take("a");
    now += 3_000;
    for (let i = 0; i < 10_001; i++) budget.take(`renter-${i}`);
    for (let i = 0; i < 3; i++) assert.equal(budget.take("a"), 0);
    assert.ok(budget.take("a") > 0);
  });

  it("never tracks more renters than its cap", () => {
    budget = new RequestBudget({ burst: 3, refillMs: 1_000, now: () => now, maxTracked: 10 });
    for (let i = 0; i < 1_000; i++) {
      budget.take(`renter-${i}`);
      assert.ok(budget.tracked <= 10);
    }
  });

  it("makes room a tenth of the cap at a time, forgetting the least recently active first", () => {
    budget = new RequestBudget({ burst: 3, refillMs: 1_000, now: () => now, maxTracked: 100 });
    for (let i = 0; i < 100; i++) budget.take(`renter-${i}`);
    budget.take("renter-0"); // active again: now the most recent
    budget.take("new-0");
    assert.equal(budget.tracked, 91);
    for (let i = 1; i < 10; i++) budget.take(`new-${i}`);
    assert.equal(budget.tracked, 100);

    // renter-0 kept its spent budget; renter-1, the least recently active, was forgotten.
    assert.equal(budget.take("renter-0"), 0);
    assert.ok(budget.take("renter-0") > 0);
    for (let i = 0; i < 3; i++) assert.equal(budget.take("renter-1"), 0);
  });
});
