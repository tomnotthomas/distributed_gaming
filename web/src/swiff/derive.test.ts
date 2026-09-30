import { describe, expect, it } from "vitest";
import { GAMES, MACHINES, type Machine } from "./data";
import {
  closeCall,
  feel,
  fmtLeft,
  freeFor,
  lasts,
  machinesFor,
  meters,
  minsLeft,
  reason,
  requirementsOf,
  wallOrder,
} from "./derive";

const elden = GAMES.find((g) => g.id === "er")!; // nova, glass, tide, ember

const at = (until: string, over: Partial<Machine> = {}): Machine => ({
  ...MACHINES.glass!,
  until,
  ...over,
});

describe("minsLeft", () => {
  it("rolls past midnight rather than going negative", () => {
    // 20:00 now; 00:30 is four and a half hours away, not minus nineteen.
    expect(minsLeft(at("00:30"))).toBe(270);
    expect(minsLeft(at("02:00"))).toBe(360);
  });

  it("reads a later-the-same-evening time directly", () => {
    expect(minsLeft(at("21:30"))).toBe(90);
  });

  it("treats an open-ended promise as twelve hours", () => {
    expect(minsLeft(at("late"))).toBe(12 * 60);
  });
});

describe("fmtLeft", () => {
  it("names the long case instead of counting it", () => {
    expect(fmtLeft(12 * 60)).toBe("all night");
    expect(fmtLeft(11 * 60)).toBe("all night");
  });

  it("drops the minutes when there are none, and pads when there are", () => {
    expect(fmtLeft(180)).toBe("3 h");
    expect(fmtLeft(185)).toBe("3 h 05");
    expect(fmtLeft(45)).toBe("45 min");
  });
});

describe("lasts", () => {
  it("measures against the session you asked for", () => {
    const short = at("21:10"); // 70 minutes
    expect(lasts(short, "quick")).toBe(true);
    expect(lasts(short, "evening")).toBe(false);
  });

  it("asks all night for six hours, since there is no end time to compare", () => {
    expect(lasts(at("02:00"), "night")).toBe(true);
    expect(lasts(at("00:30"), "night")).toBe(false);
  });
});

describe("meters", () => {
  it("caps picture on a slow link, because a 4090 cannot beat latency", () => {
    expect(meters({ ...MACHINES.glass!, ping: 9 }, elden)).toEqual({ picture: 4, response: 4 });
    expect(meters({ ...MACHINES.glass!, ping: 38 }, elden)).toEqual({ picture: 2, response: 1 });
  });

  it("holds picture back when the owner's upload cannot carry it", () => {
    // Ember's 4070 Ti has three times the headroom Elden Ring asks for, but 20 Mb/s up.
    expect(meters(MACHINES.ember!, elden)).toEqual({ picture: 2, response: 3 });
  });
});

describe("requirementsOf", () => {
  it("measures a game with no requirements against a GTX 1060 minimum and an RTX 3060", () => {
    const unknown = { ...elden, requirements: undefined };
    expect(requirementsOf(unknown)).toMatchObject({ minGpuScore: 45, recGpuScore: 100 });
  });
});

describe("feel", () => {
  it("says it in words a player would use", () => {
    expect(feel(MACHINES.glass!, elden).text).toBe("Stunning picture, controls feel instant");
    expect(feel(MACHINES.moss!, elden).text).toBe("Good picture, slight delay on controls");
  });
});

describe("reason", () => {
  it("names the rule that put the first machine above the second", () => {
    // Glasshouse and Tide both cover the evening; Glasshouse responds faster.
    expect(reason(elden, MACHINES, "evening")).toBe("Lowest latency");
    expect(reason(elden, MACHINES, "evening", { quality: "resolution", devices: [] })).toBe("Best picture");
    expect(reason(elden, MACHINES, "evening", { quality: "fps", devices: [] })).toBe("120 fps");
  });

  it("gives none when there is only one machine to pick", () => {
    const starfield = GAMES.find((g) => g.id === "sf")!; // glass only
    expect(reason(starfield, MACHINES, "evening")).toBeUndefined();
  });
});

describe("machinesFor", () => {
  it("sinks the machine that cannot cover the session, below lower pings", () => {
    const order = machinesFor(elden, MACHINES, "evening").map((m) => m.id);
    // Ember is 14 ms but promised only until 21:10, so it loses to 21 ms Tide.
    expect(order).toEqual(["glass", "tide", "ember"]);
  });

  it("never lists your own PC, however close it is", () => {
    // Nova-01 is 2 ms away, free all night, and yours: gate E5.
    expect(machinesFor(elden, MACHINES, "night").map((m) => m.id)).not.toContain("nova");
    expect(freeFor(elden, MACHINES, "quick").map((m) => m.id)).not.toContain("nova");
  });

  it("follows the Picture setting", () => {
    // 120 fps first: Tide streams 1440p 120, Glasshouse tops out at 4K 60.
    const order = machinesFor(elden, MACHINES, "evening", { quality: "fps", devices: [] });
    expect(order.map((m) => m.id)).toEqual(["tide", "glass", "ember"]);
  });

  it("drops a machine that lacks a control you turned on", () => {
    const pool = { ...MACHINES, glass: { ...MACHINES.glass!, controls: ["kb" as const, "mouse" as const] } };
    const withPad = machinesFor(elden, pool, "evening", { quality: "auto", devices: ["kb", "mouse", "pad"] });
    expect(withPad.map((m) => m.id)).toEqual(["tide", "ember"]);
    const noPad = machinesFor(elden, pool, "evening", { quality: "auto", devices: ["kb", "mouse"] });
    expect(noPad.map((m) => m.id)).toEqual(["glass", "tide", "ember"]);
  });

  it("sinks a busy machine below every free one", () => {
    const cs = GAMES.find((g) => g.id === "cs")!; // nova, glass, ember, moss
    const order = machinesFor(cs, MACHINES, "evening").map((m) => m.id);
    expect(order[order.length - 1]).toBe("moss");
  });

  it("drops a machine id the pool does not have rather than throwing", () => {
    const ghost = { ...GAMES[0]!, machines: ["glass", "nope"] };
    expect(machinesFor(ghost, MACHINES, "evening").map((m) => m.id)).toEqual(["glass"]);
  });
});

describe("freeFor", () => {
  it("excludes a machine that cannot cover the whole session", () => {
    const finals = GAMES.find((g) => g.id === "val")!; // glass + ember
    expect(freeFor(finals, MACHINES, "quick").map((m) => m.id)).toEqual(["glass", "ember"]);
    // Ember is promised only until 21:10, so a three-hour evening rules it out.
    expect(freeFor(finals, MACHINES, "evening").map((m) => m.id)).toEqual(["glass"]);
  });
});

describe("closeCall", () => {
  it("measures the gap between the top two either way round", () => {
    // 120 fps first puts 21 ms Tide above 9 ms Glasshouse: 12 ms apart, not close.
    const free = freeFor(elden, MACHINES, "evening", { quality: "fps", devices: [] });
    expect(free.map((m) => m.id)).toEqual(["tide", "glass"]);
    expect(closeCall(free)).toBe(false);
  });

  it("calls two machines within 3 ms close, and one machine never", () => {
    const glass = MACHINES.glass!;
    expect(closeCall([glass, { ...glass, ping: 12 }])).toBe(true);
    expect(closeCall([{ ...glass, ping: 12 }, glass])).toBe(true);
    expect(closeCall([glass, { ...glass, ping: 13 }])).toBe(false);
    expect(closeCall([glass])).toBe(false);
  });
});

describe("wallOrder", () => {
  it("ranks playable first and never drops a game you own", () => {
    const order = wallOrder(GAMES, MACHINES, "evening");
    expect(order).toHaveLength(GAMES.length);
    const silksong = order.findIndex((g) => g.id === "hk"); // moss only, busy
    const elden = order.findIndex((g) => g.id === "er");
    expect(elden).toBeLessThan(silksong);
  });
});
