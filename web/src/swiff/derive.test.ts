import { describe, expect, it } from "vitest";
import { GAMES, MACHINES, type Machine } from "./data";
import { feel, fmtLeft, freeFor, lasts, machinesFor, meters, minsLeft, reason, wallOrder } from "./derive";

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
    expect(meters({ ...MACHINES.glass!, ping: 9 })).toEqual({ picture: 4, response: 4 });
    expect(meters({ ...MACHINES.glass!, ping: 38 })).toEqual({ picture: 2, response: 1 });
  });
});

describe("feel", () => {
  it("says it in words a player would use", () => {
    expect(feel(MACHINES.glass!).text).toBe("Stunning picture, controls feel instant");
    expect(feel(MACHINES.moss!).text).toBe("Good picture, slight delay on controls");
  });
});

describe("reason", () => {
  it("credits the lowest ping when nothing free is closer", () => {
    const all = [MACHINES.glass!, MACHINES.tide!];
    expect(reason(MACHINES.glass!, all)).toBe("Lowest latency");
  });
});

describe("machinesFor", () => {
  it("sinks the machine that cannot cover the session, below lower pings", () => {
    const elden = GAMES.find((g) => g.id === "er")!; // nova, glass, tide, ember
    const order = machinesFor(elden, MACHINES, "evening").map((m) => m.id);
    expect(order[0]).toBe("nova");
    // Ember is 14 ms but promised only until 21:10, so it loses to 21 ms Tide.
    expect(order).toEqual(["nova", "glass", "tide", "ember"]);
  });

  it("sinks a busy machine below every free one", () => {
    const cs = GAMES.find((g) => g.id === "cs")!; // nova, glass, ember, moss
    const order = machinesFor(cs, MACHINES, "evening").map((m) => m.id);
    expect(order[order.length - 1]).toBe("moss");
  });

  it("drops a machine id the pool does not have rather than throwing", () => {
    const ghost = { ...GAMES[0]!, machines: ["nova", "nope"] };
    expect(machinesFor(ghost, MACHINES, "evening").map((m) => m.id)).toEqual(["nova"]);
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

describe("wallOrder", () => {
  it("ranks playable first and never drops a game you own", () => {
    const order = wallOrder(GAMES, MACHINES, "evening");
    expect(order).toHaveLength(GAMES.length);
    const silksong = order.findIndex((g) => g.id === "hk"); // moss only, busy
    const elden = order.findIndex((g) => g.id === "er");
    expect(elden).toBeLessThan(silksong);
  });
});
