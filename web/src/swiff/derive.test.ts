import { describe, expect, it } from "vitest";
import { GAMES, MACHINES, type Machine } from "./data";
import {
  clockMinutes,
  clockTime,
  feel,
  fmtLeft,
  freeFor,
  lasts,
  leftAt,
  machinesFor,
  meters,
  minsLeft,
  reason,
  requirementsOf,
  seedSpot,
  seedSpots,
  wallOrder,
} from "./derive";

const elden = GAMES.find((g) => g.id === "er")!; // nova, glass, tide, ember

const at = (until: string, over: Partial<Machine> = {}) => ({
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

  it("reserves a rental-mode PC's Steam sign-in and launch before the session", () => {
    const hour = at("21:05"); // 65 minutes
    expect(lasts(hour, "quick")).toBe(true);
    expect(lasts({ ...hour, rentalMode: true }, "quick")).toBe(false);
    expect(lasts({ ...at("21:10"), rentalMode: true }, "quick")).toBe(false);
    expect(lasts({ ...at("21:15"), rentalMode: true }, "quick")).toBe(true);
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

describe("freeFor with a picture preference", () => {
  it("can put a slower machine first", () => {
    // 120 fps first puts 21 ms Tide above 9 ms Glasshouse.
    const free = freeFor(elden, MACHINES, "evening", { quality: "fps", devices: [] });
    expect(free.map((m) => m.id)).toEqual(["tide", "glass"]);
  });
});

describe("wallOrder", () => {
  it("ranks playable first and never drops a game you own", () => {
    const order = wallOrder(GAMES, seedSpots(GAMES, MACHINES, "evening"));
    expect(order).toHaveLength(GAMES.length);
    const silksong = order.findIndex((g) => g.id === "hk"); // moss only, busy
    const elden = order.findIndex((g) => g.id === "er");
    expect(elden).toBeLessThan(silksong);
  });

  it("orders by what you have played alone when nothing is known about machines", () => {
    const order = wallOrder(GAMES, new Map());
    expect(order).toHaveLength(GAMES.length);
    expect(order.slice(0, 5).every((g) => g.last)).toBe(true);
  });
});

describe("seedSpot", () => {
  const silksong = GAMES.find((g) => g.id === "hk")!; // moss only, busy until 21:30

  it("offers the best demo machine free for the session", () => {
    const spot = seedSpot(elden, MACHINES, "evening");
    expect(spot.ready).toBe(freeFor(elden, MACHINES, "evening").length);
    expect(spot.best?.id).toBe("glass");
    expect(spot.best?.self).toBeFalsy();
  });

  it("says who is back and when for a game with nothing free", () => {
    expect(seedSpot(silksong, MACHINES, "evening")).toEqual({
      free: 0,
      ready: 0,
      busy: 1,
      best: null,
      back: { name: "Moss", at: "21:30", backAt: 21.5 * 3_600_000 },
    });
  });
});

describe("the real clock", () => {
  it("reads minutes since local midnight", () => {
    expect(clockMinutes(new Date(2026, 9, 3, 21, 45))).toBe(21 * 60 + 45);
  });

  it("tells a Unix ms time as the local clock shows it", () => {
    expect(clockTime(new Date(2026, 9, 3, 7, 5).getTime())).toBe("07:05");
  });

  it("counts a real host's time left from the real clock, not the demo's 20:00", () => {
    expect(minsLeft(at("23:00"), 22 * 60)).toBe(60);
    expect(minsLeft(at("01:00"), 23 * 60 + 30)).toBe(90);
  });

  it("counts a real host down to its absolute free-until, and to nothing once it has passed", () => {
    const until = new Date(2026, 9, 3, 21, 30, 40).getTime();
    const host = at("21:30", { untilAt: until });
    expect(leftAt(host, new Date(2026, 9, 3, 21, 0).getTime())).toBe(30);
    // Read at 21:29, still shown at 21:31: passed, not free all night.
    expect(leftAt(host, new Date(2026, 9, 3, 21, 31).getTime())).toBe(0);
    expect(fmtLeft(leftAt(host, new Date(2026, 9, 3, 21, 31).getTime()))).toBe("0 min");
  });

  it("counts a demo machine by its clock time from the clock's minutes", () => {
    expect(leftAt(at("00:30"), new Date(2026, 9, 3, 20, 0).getTime())).toBe(270);
    expect(leftAt(at("late"), new Date(2026, 9, 3, 20, 0).getTime())).toBe(12 * 60);
  });
});

describe("meters for a real host", () => {
  it("takes the server's scores as they are", () => {
    const host: Machine = {
      id: "h",
      name: "Host",
      gpu: "RTX 4090",
      ping: 30,
      quality: "",
      until: "late",
      busy: false,
    };
    expect(meters({ ...host, scores: { picture: 4, response: 3 } }, elden)).toEqual({
      picture: 4,
      response: 3,
    });
  });
});
