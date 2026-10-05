// From the server's raw history (uptime totals and ended sessions) to the
// stability bucket, at each threshold's boundary.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addQos,
  splitByDay,
  stabilityFrom,
  stabilityStats,
  type EndedSession,
  type EndReason,
  type UptimeTotals,
} from "../stability.js";

const HOUR = 3_600_000;

/** A hundred offered hours, every one of them seen, no drops. */
const UPTIME: UptimeTotals = { offeredMs: 100 * HOUR, seenMs: 100 * HOUR, drops: 0 };

/** `count` sessions the renter ended, with no QoS. */
const sessions = (count: number, endReason: EndReason = "renter"): EndedSession[] =>
  Array.from({ length: count }, () => ({ endReason, packetLoss: null }));

/** Twenty sessions, `bad` of them ended by `reason`. */
const withBad = (bad: number, reason: EndReason = "host_offline") => [
  ...sessions(20 - bad),
  ...sessions(bad, reason),
];

/** Twenty sessions whose median loss is `loss`. */
const withLoss = (loss: number) => sessions(20).map((s) => ({ ...s, packetLoss: loss }));

const bucket = (uptime: Partial<UptimeTotals>, ended: EndedSession[] = sessions(20)) =>
  stabilityFrom({ ...UPTIME, ...uptime }, ended).stability;

describe("stabilityStats", () => {
  it("reads coverage, drops per hour, completion and median loss from the raw history", () => {
    const stats = stabilityStats({ offeredMs: 50 * HOUR, seenMs: 49 * HOUR, drops: 5 }, [
      { endReason: "renter", packetLoss: 0.02 },
      { endReason: "time_up", packetLoss: 0.001 },
      { endReason: "grace_expired", packetLoss: null },
      { endReason: "host_offline", packetLoss: 0.5 },
      { endReason: "owner_kill", packetLoss: 0.01 },
      { endReason: "host_end", packetLoss: 0.03 },
    ]);
    assert.deepEqual(stats, {
      heartbeatCoverage: 0.98,
      dropsPerHour: 0.1,
      sessionCompletion: 0.5,
      packetLoss: 0.02,
      sessions: 6,
      offeredHours: 50,
    });
  });

  it("is perfect with nothing to judge, which New then overrides", () => {
    assert.deepEqual(stabilityStats({ offeredMs: 0, seenMs: 0, drops: 0 }, []), {
      heartbeatCoverage: 1,
      dropsPerHour: 0,
      sessionCompletion: 1,
      packetLoss: 0,
      sessions: 0,
      offeredHours: 0,
    });
    assert.equal(stabilityFrom({ offeredMs: 0, seenMs: 0, drops: 0 }, []).stability, "new");
  });
});

describe("stability bucket from the raw history", () => {
  it("is Steady with a clean week", () => {
    assert.equal(bucket({}), "steady");
  });

  it("holds Steady at 99.5% coverage and drops to OK below it", () => {
    assert.equal(bucket({ seenMs: 99.5 * HOUR }), "steady");
    assert.equal(bucket({ seenMs: 99.4 * HOUR }), "ok");
  });

  it("holds OK at 97% coverage and turns Shaky below it", () => {
    assert.equal(bucket({ seenMs: 97 * HOUR }), "ok");
    assert.equal(bucket({ seenMs: 96.9 * HOUR }), "shaky");
  });

  it("holds Steady at 0.1 drops an hour, OK at 0.5, and Shaky past it", () => {
    assert.equal(bucket({ drops: 10 }), "steady");
    assert.equal(bucket({ drops: 11 }), "ok");
    assert.equal(bucket({ drops: 50 }), "ok");
    assert.equal(bucket({ drops: 51 }), "shaky");
  });

  it("holds Steady at 95% completion, OK at 80%, and Shaky below it", () => {
    assert.equal(bucket({}, withBad(1)), "steady");
    assert.equal(bucket({}, withBad(2)), "ok");
    assert.equal(bucket({}, withBad(4, "owner_kill")), "ok");
    assert.equal(bucket({}, withBad(5, "owner_kill")), "shaky");
  });

  it("counts the renter leaving and time running out as completed", () => {
    const ended = [...sessions(5, "renter"), ...sessions(5, "time_up")];
    assert.equal(stabilityStats(UPTIME, ended).sessionCompletion, 1);
  });

  it("leaves a renter who never arrived or never came back out of completion, but counts it as a session", () => {
    const ended = [
      ...sessions(19, "renter"),
      ...sessions(1, "host_offline"),
      ...sessions(10, "grace_expired"),
    ];
    const stats = stabilityStats(UPTIME, ended);
    assert.equal(stats.sessionCompletion, 0.95);
    assert.equal(stats.sessions, 30);
  });

  it("leaves a host's early end out of completion, but counts it as a session", () => {
    const ended = [...sessions(19, "renter"), ...sessions(1, "host_offline"), ...sessions(10, "host_end")];
    const stats = stabilityStats(UPTIME, ended);
    assert.equal(stats.sessionCompletion, 0.95);
    assert.equal(stats.sessions, 30);
    assert.equal(stabilityStats(UPTIME, sessions(5, "host_end")).sessionCompletion, 1);
  });

  it("is Steady under 1% median loss, OK from 1% to 3%, and Shaky past it", () => {
    assert.equal(bucket({}, withLoss(0.0099)), "steady");
    assert.equal(bucket({}, withLoss(0.01)), "ok");
    assert.equal(bucket({}, withLoss(0.03)), "ok");
    assert.equal(bucket({}, withLoss(0.031)), "shaky");
  });

  it("takes the median loss, so one bad session does not make a machine Shaky", () => {
    const ended = [...withLoss(0).slice(0, 4), { endReason: "renter" as const, packetLoss: 0.4 }];
    assert.equal(stabilityStats(UPTIME, ended).packetLoss, 0);
  });

  it("is New under 5 sessions or 10 offered hours, however bad the rest", () => {
    const shaky = { seenMs: 50 * HOUR, drops: 100 };
    assert.equal(bucket(shaky, sessions(4, "host_offline")), "new");
    assert.equal(bucket(shaky, sessions(5, "host_offline")), "shaky");
    assert.equal(bucket({ offeredMs: 9.99 * HOUR, seenMs: 9.99 * HOUR }, sessions(5)), "new");
    assert.equal(bucket({ offeredMs: 10 * HOUR, seenMs: 10 * HOUR }, sessions(5)), "steady");
  });
});

describe("addQos", () => {
  it("keeps a running mean of every number and counts the reports", () => {
    const first = addQos(null, { fps: 60, bitrate: 20e6, rttMs: 10, packetLoss: 0 });
    assert.deepEqual(first, { reports: 1, fps: 60, bitrate: 20e6, rttMs: 10, packetLoss: 0 });
    const second = addQos(first, { fps: 30, bitrate: 10e6, rttMs: 30, packetLoss: 0.02 });
    assert.deepEqual(second, { reports: 2, fps: 45, bitrate: 15e6, rttMs: 20, packetLoss: 0.01 });
  });
});

describe("splitByDay", () => {
  it("splits an interval at UTC midnight and counts seen time up to its end", () => {
    const midnight = Date.UTC(2026, 9, 1);
    assert.deepEqual(splitByDay(midnight - 10_000, midnight + 20_000, midnight + 5_000), [
      { day: "2026-09-30", offeredMs: 10_000, seenMs: 10_000 },
      { day: "2026-10-01", offeredMs: 20_000, seenMs: 5_000 },
    ]);
  });

  it("is empty for an empty or backwards interval", () => {
    assert.deepEqual(splitByDay(10, 10, 20), []);
    assert.deepEqual(splitByDay(10, 5, 20), []);
  });
});
