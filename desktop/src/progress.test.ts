// How long a measured step has left, as the install's write says it: an
// average rate over the last ten seconds or so, said only once there is
// enough of it and while it holds steady, rounded the way people say it.

import { describe, expect, it } from "vitest";
import { meter, mmss, timeLeft, type RateMeter } from "./progress";

/** A meter fed `rate` bytes a second for `seconds`, a sample every 250 ms. */
function steady(rate: number, seconds: number, from = 0): RateMeter {
  let m: RateMeter | null = null;
  for (let t = 0; t <= seconds * 1000; t += 250) m = meter(m, from + (rate * t) / 1000, t);
  return m!;
}

describe("the write's rate", () => {
  it("settles on a steady rate", () => {
    expect(steady(50e6, 20).rate).toBeCloseTo(50e6, -3);
  });

  it("starts again when the bytes go backwards: another write, or another step", () => {
    const m = meter(steady(50e6, 20), 10, 21_000);
    expect(m).toMatchObject({ since: 21_000, done: 10, rate: null });
  });
});

describe("the time left", () => {
  const total = 9.8e9;

  it("says nothing before five seconds of data", () => {
    expect(timeLeft(null, total)).toBeNull();
    expect(timeLeft(steady(50e6, 4), total)).toBeNull();
    expect(timeLeft(steady(50e6, 6), total)).toBe("About 3 minutes left.");
  });

  it("rounds the way people say it", () => {
    // 9.8 GB at 50 MB/s from 4.1 GB: 114 s left.
    expect(timeLeft(steady(50e6, 10, 4.1e9 - 500e6), total)).toBe("About 2 minutes left.");
    expect(timeLeft(steady(50e6, 10, total - 50e6 * 85 - 500e6), total)).toBe("About 1 minute left.");
    expect(timeLeft(steady(50e6, 10, total - 50e6 * 30 - 500e6), total)).toBe("Less than a minute left.");
    expect(timeLeft(steady(10e6, 10), total)).toBe("About 16 minutes left.");
  });

  it("hides while the rate swings by more than half", () => {
    let m = steady(50e6, 20);
    // The disk stalls: the last couple of seconds write next to nothing.
    for (let t = 20_250; t <= 23_000; t += 250) m = meter(m, m.done + 1e5, t);
    expect(timeLeft(m, total)).toBeNull();
    // It picks up again and holds: the time left comes back.
    for (let t = 23_250; t <= 60_000; t += 250) m = meter(m, m.done + 50e6 / 4, t);
    expect(timeLeft(m, total)).toMatch(/left\.$/);
  });
});

describe("the running clock", () => {
  it("counts minutes and seconds", () => {
    expect(mmss(0)).toBe("0:00");
    expect(mmss(131.7)).toBe("2:11");
    expect(mmss(3600)).toBe("60:00");
    expect(mmss(-3)).toBe("0:00");
  });
});
