import { describe, expect, it } from "vitest";
import { DEFAULT_WEEK, TIERS, awayWindow, estimate, euros, tier, withArticle, type Week } from "./estimate";

describe("estimate", () => {
  it("reproduces the mockup's worked example for a High-end rig", () => {
    // 30 h away × 55% booked × 4.33 weeks = 71 h; at €1,00 that is €71, less
    // 71 h at 420 W and €0,30/kWh = €9 of electricity.
    expect(estimate(DEFAULT_WEEK)).toEqual({
      weekHours: 30,
      streamedHours: 71,
      gross: 71,
      power: 9,
      net: 62,
      low: 40,
      high: 85,
    });
  });

  it("always prints a sheet that adds up", () => {
    for (const t of TIERS) {
      for (let hoursPerDay = 1; hoursPerDay <= 16; hoursPerDay += 3) {
        for (const electricity of [0.1, 0.27, 0.6]) {
          const e = estimate({ tier: t.id, hoursPerDay, daysPerWeek: 4, electricity });
          expect(e.net).toBe(e.gross - e.power);
        }
      }
    }
  });

  it("earns more on a better rig, a longer week and cheaper power", () => {
    const nets = TIERS.map((t) => estimate({ ...DEFAULT_WEEK, tier: t.id }).net);
    expect(nets).toEqual([...nets].sort((a, b) => a - b));
    expect(new Set(nets).size).toBe(TIERS.length);

    expect(estimate({ ...DEFAULT_WEEK, hoursPerDay: 8 }).net).toBeGreaterThan(estimate(DEFAULT_WEEK).net);
    expect(estimate({ ...DEFAULT_WEEK, daysPerWeek: 7 }).net).toBeGreaterThan(estimate(DEFAULT_WEEK).net);
    expect(estimate({ ...DEFAULT_WEEK, electricity: 0.1 }).net).toBeGreaterThan(estimate(DEFAULT_WEEK).net);
  });

  it("puts the typical month between a quiet one and a busy one", () => {
    const weeks: Week[] = [
      DEFAULT_WEEK,
      { tier: "entry", hoursPerDay: 1, daysPerWeek: 1, electricity: 0.6 },
      { tier: "enthusiast", hoursPerDay: 16, daysPerWeek: 7, electricity: 0.1 },
    ];
    for (const week of weeks) {
      const e = estimate(week);
      expect(e.low).toBeLessThanOrEqual(e.net);
      expect(e.high).toBeGreaterThanOrEqual(e.net);
    }
  });

  it("never goes below nothing, even on the cheapest rig with the dearest power", () => {
    const e = estimate({ tier: "entry", hoursPerDay: 1, daysPerWeek: 1, electricity: 0.6 });
    expect(e.net).toBeGreaterThanOrEqual(0);
    expect(e.low).toBeGreaterThanOrEqual(0);
  });
});

describe("tiers", () => {
  it("build each rate from its example rig's parts", () => {
    for (const t of TIERS) {
      const sum = t.parts.reduce((total, p) => total + p.rate, 0);
      expect(sum).toBeCloseTo(t.rate, 10);
    }
  });

  it("look tiers up by id", () => {
    expect(tier("solid").name).toBe("Solid");
  });
});

describe("formatting", () => {
  it("writes euros with a decimal comma", () => {
    expect(euros(0.45)).toBe("0,45");
    expect(euros(1)).toBe("1,00");
    expect(euros(62, 0)).toBe("62");
  });

  it("names the evening window, wrapping past midnight", () => {
    expect(awayWindow(6)).toBe("20:00 to 02:00");
    expect(awayWindow(2)).toBe("20:00 to 22:00");
    expect(awayWindow(4)).toBe("20:00 to 00:00");
    expect(awayWindow(16)).toBe("20:00 to 12:00");
  });

  it("picks the article for a tier's name", () => {
    expect(withArticle("High-end")).toBe("a High-end");
    expect(withArticle("Entry")).toBe("an Entry");
    expect(withArticle("Enthusiast")).toBe("an Enthusiast");
  });
});
