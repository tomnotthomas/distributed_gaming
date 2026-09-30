import { describe, expect, it } from "vitest";
import { failedGates, pictureScore, rank, responseScore, stabilityOf } from "./rank.ts";
import type { Candidate, GameRequirements, HostProfile, RenterPrefs, StabilityStats } from "./types.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

/** Elden Ring as the plan's worked example has it: recommended RTX 3060 = 100. */
const ELDEN: GameRequirements = {
  appid: 1245620,
  minGpuScore: 45,
  recGpuScore: 100,
  minRamGb: 12,
  minVramGb: 3,
};

const RENTER: RenterPrefs = {
  id: "you",
  controls: ["kb", "mouse", "pad"],
  picture: "best",
  sessionMinutes: 180,
};

const STEADY: StabilityStats = {
  heartbeatCoverage: 0.998,
  dropsPerHour: 0.05,
  sessionCompletion: 0.97,
  packetLoss: 0.004,
  sessions: 40,
  offeredHours: 120,
};

const NEW: StabilityStats = { ...STEADY, sessions: 2, offeredHours: 6 };

const SHAKY: StabilityStats = { ...STEADY, heartbeatCoverage: 0.9 };

/** A host that passes every gate for ELDEN and RENTER, with overrides. */
function host(over: Partial<HostProfile> = {}): HostProfile {
  return {
    id: "h",
    ownerId: "someone",
    status: "available",
    lastHeartbeatAt: NOW - 2_000,
    installed: [ELDEN.appid],
    gpu: "RTX 4090",
    ramGb: 32,
    vramGb: 24,
    controls: ["kb", "mouse", "pad"],
    encoders: ["h264", "hevc", "av1"],
    uploadMbps: 50,
    fps120: true,
    priceCentsPerHour: 150,
    availableUntil: NOW + 6 * HOUR,
    ...over,
  };
}

/** A candidate around host(), reached directly at the given round trip. */
function candidate(over: Partial<HostProfile> = {}, rttMs = 9, extra: Partial<Candidate> = {}): Candidate {
  return {
    host: host(over),
    link: { rttMs, jitterP95Ms: 2, relayed: false },
    history: STEADY,
    ...extra,
  };
}

/** The gates a candidate fails for Elden Ring, at NOW. */
const gates = (c: Candidate, renter: RenterPrefs = RENTER, maxRttMs?: number) =>
  failedGates(c, ELDEN, renter, maxRttMs === undefined ? { now: NOW } : { now: NOW, maxRttMs });

/** Host ids in ranked order for the default renter. */
const ids = (c: Candidate[]) => rank(ELDEN, RENTER, c, { now: NOW }).hosts.map((h) => h.host.id);

describe("gates", () => {
  it("passes a host that meets every gate", () => {
    expect(gates(candidate())).toEqual([]);
  });

  it("E1: needs status available and a heartbeat under 15 s", () => {
    expect(gates(candidate({ status: "busy" }))).toEqual(["E1"]);
    expect(gates(candidate({ status: "offline" }))).toEqual(["E1"]);
    expect(gates(candidate({ lastHeartbeatAt: NOW - 14_999 }))).toEqual([]);
    expect(gates(candidate({ lastHeartbeatAt: NOW - 15_000 }))).toEqual(["E1"]);
  });

  it("E2: needs the game installed", () => {
    expect(gates(candidate({ installed: [730] }))).toEqual(["E2"]);
  });

  it("E3: needs the minimum GPU score, RAM and VRAM", () => {
    expect(gates(candidate({ gpu: "GTX 1060" }))).toEqual([]); // 45, exactly the minimum
    expect(gates(candidate({ gpu: "RX 570" }))).toEqual(["E3"]); // 40
    expect(gates(candidate({ gpu: "Some Unknown GPU" }))).toEqual(["E3"]);
    expect(gates(candidate({ ramGb: 8 }))).toEqual(["E3"]);
    expect(gates(candidate({ vramGb: 2 }))).toEqual(["E3"]);
  });

  it("E4: needs every control the renter turned on, and only those", () => {
    const noPad = candidate({ controls: ["kb", "mouse"] });
    expect(gates(noPad)).toEqual(["E4"]);
    expect(gates(noPad, { ...RENTER, controls: ["kb", "mouse"] })).toEqual([]);
  });

  it("E5: never lists the renter's own PC", () => {
    expect(gates(candidate({ ownerId: "you" }))).toEqual(["E5"]);
  });

  it("E6: needs a known link at or under 80 ms, or the configured limit", () => {
    expect(gates(candidate({}, 80))).toEqual([]);
    expect(gates(candidate({}, 81))).toEqual(["E6"]);
    expect(gates(candidate({}, 50), RENTER, 40)).toEqual(["E6"]);
    expect(gates({ ...candidate(), link: null })).toEqual(["E6"]);
  });

  it("reports every gate a host fails, not just the first", () => {
    expect(gates(candidate({ ownerId: "you", status: "busy" }, 90))).toEqual(["E1", "E5", "E6"]);
  });
});

describe("responseScore", () => {
  const link = (rttMs: number, jitterP95Ms = 2, relayed = false) => ({ rttMs, jitterP95Ms, relayed });

  it("buckets the round trip at 10, 20 and 35 ms", () => {
    expect(responseScore(link(9.9))).toBe(4);
    expect(responseScore(link(10))).toBe(3);
    expect(responseScore(link(19.9))).toBe(3);
    expect(responseScore(link(20))).toBe(2);
    expect(responseScore(link(34.9))).toBe(2);
    expect(responseScore(link(35))).toBe(1);
  });

  it("drops one step for jitter over 10 ms or a relayed path, never below 1", () => {
    expect(responseScore(link(5, 10))).toBe(4);
    expect(responseScore(link(5, 10.1))).toBe(3);
    expect(responseScore(link(5, 2, true))).toBe(3);
    expect(responseScore(link(5, 20, true))).toBe(3);
    expect(responseScore(link(50, 20))).toBe(1);
  });
});

describe("pictureScore", () => {
  const hw = (uploadMbps: number, encoders: ("h264" | "hevc" | "av1")[] = ["h264", "hevc"]) => ({
    uploadMbps,
    encoders,
  });

  it("gives 4 only for 2x headroom with HEVC or AV1 and 40 Mb/s", () => {
    expect(pictureScore(2, hw(40), 9)).toBe(4);
    expect(pictureScore(2, hw(40, ["av1"]), 9)).toBe(4);
    expect(pictureScore(2, hw(40, ["h264"]), 9)).toBe(3);
    expect(pictureScore(2, hw(39), 9)).toBe(3);
    expect(pictureScore(1.99, hw(40), 9)).toBe(3);
  });

  it("gives 3 at 1.4x and 25 Mb/s, 2 at 1.0x and 15 Mb/s, else 1", () => {
    expect(pictureScore(1.4, hw(25), 9)).toBe(3);
    expect(pictureScore(1.39, hw(25), 9)).toBe(2);
    expect(pictureScore(1.4, hw(24), 9)).toBe(2);
    expect(pictureScore(1, hw(15), 9)).toBe(2);
    expect(pictureScore(0.99, hw(15), 9)).toBe(1);
    expect(pictureScore(1, hw(14), 9)).toBe(1);
  });

  it("caps at 2 once the round trip is over 30 ms", () => {
    expect(pictureScore(5, hw(50), 30)).toBe(4);
    expect(pictureScore(5, hw(50), 31)).toBe(2);
    expect(pictureScore(0.5, hw(5), 31)).toBe(1);
  });
});

describe("stabilityOf", () => {
  it("is Steady at every Steady threshold", () => {
    expect(
      stabilityOf({ ...STEADY, heartbeatCoverage: 0.995, dropsPerHour: 0.1, sessionCompletion: 0.95 }),
    ).toBe("steady");
  });

  it("falls to OK just past any Steady threshold", () => {
    expect(stabilityOf({ ...STEADY, heartbeatCoverage: 0.994 })).toBe("ok");
    expect(stabilityOf({ ...STEADY, dropsPerHour: 0.11 })).toBe("ok");
    expect(stabilityOf({ ...STEADY, sessionCompletion: 0.94 })).toBe("ok");
    expect(stabilityOf({ ...STEADY, packetLoss: 0.01 })).toBe("ok");
  });

  it("is Shaky past any Shaky threshold, and OK right at one", () => {
    expect(stabilityOf({ ...STEADY, heartbeatCoverage: 0.97 })).toBe("ok");
    expect(stabilityOf({ ...STEADY, heartbeatCoverage: 0.969 })).toBe("shaky");
    expect(stabilityOf({ ...STEADY, dropsPerHour: 0.5 })).toBe("ok");
    expect(stabilityOf({ ...STEADY, dropsPerHour: 0.51 })).toBe("shaky");
    expect(stabilityOf({ ...STEADY, sessionCompletion: 0.8 })).toBe("ok");
    expect(stabilityOf({ ...STEADY, sessionCompletion: 0.79 })).toBe("shaky");
    expect(stabilityOf({ ...STEADY, packetLoss: 0.03 })).toBe("ok");
    expect(stabilityOf({ ...STEADY, packetLoss: 0.031 })).toBe("shaky");
  });

  it("is New under 5 sessions or 10 offered hours, whatever the numbers say", () => {
    expect(stabilityOf({ ...SHAKY, sessions: 4 })).toBe("new");
    expect(stabilityOf({ ...STEADY, offeredHours: 9.9 })).toBe("new");
    expect(stabilityOf({ ...STEADY, sessions: 5, offeredHours: 10 })).toBe("steady");
  });
});

describe("sort order", () => {
  it("O1: puts a host that covers tonight above a closer one that does not", () => {
    const short = candidate({ id: "short", availableUntil: NOW + 2 * HOUR }, 5);
    const long = candidate({ id: "long" }, 30);
    expect(ids([short, long])).toEqual(["long", "short"]);
    expect(rank(ELDEN, RENTER, [short, long], { now: NOW }).reason).toEqual({
      rule: "O1",
      label: "Free all session",
    });
  });

  it("O2: puts a Shaky host below one that is not, and New ranks as OK", () => {
    const shaky = candidate({ id: "shaky" }, 5, { history: SHAKY });
    const fresh = candidate({ id: "fresh" }, 30, { history: NEW });
    expect(ids([shaky, fresh])).toEqual(["fresh", "shaky"]);
    expect(rank(ELDEN, RENTER, [shaky, fresh], { now: NOW }).reason?.rule).toBe("O2");
  });

  it("O3 Best: Response first, then Picture", () => {
    const quick = candidate({ id: "quick", gpu: "RTX 3060" }, 9); // 4 / 2
    const sharp = candidate({ id: "sharp" }, 15); // 3 / 4
    expect(ids([sharp, quick])).toEqual(["quick", "sharp"]);
    expect(rank(ELDEN, RENTER, [sharp, quick], { now: NOW }).reason).toEqual({
      rule: "O3",
      label: "Lowest latency",
    });

    const plain = candidate({ id: "plain", uploadMbps: 20 }, 9); // 4 / 2
    const rich = candidate({ id: "rich" }, 9.5); // 4 / 4
    expect(ids([plain, rich])).toEqual(["rich", "plain"]);
    expect(rank(ELDEN, RENTER, [plain, rich], { now: NOW }).reason).toEqual({
      rule: "O3",
      label: "Best picture",
    });
  });

  it("O3 4K: Picture first, then Response", () => {
    const renter = { ...RENTER, picture: "4k" as const };
    const quick = candidate({ id: "quick", gpu: "RTX 3060" }, 9);
    const sharp = candidate({ id: "sharp" }, 15);
    const result = rank(ELDEN, renter, [quick, sharp], { now: NOW });
    expect(result.hosts.map((h) => h.host.id)).toEqual(["sharp", "quick"]);
    expect(result.reason).toEqual({ rule: "O3", label: "Best picture" });
  });

  it("O3 120 fps: a 120-capable host first", () => {
    const renter = { ...RENTER, picture: "120fps" as const };
    const sixty = candidate({ id: "sixty", fps120: false }, 5);
    const fast = candidate({ id: "fast" }, 9);
    const result = rank(ELDEN, renter, [sixty, fast], { now: NOW });
    expect(result.hosts.map((h) => h.host.id)).toEqual(["fast", "sixty"]);
    expect(result.reason).toEqual({ rule: "O3", label: "120 fps" });
  });

  it("O4: lower raw round trip inside the same buckets", () => {
    const a = candidate({ id: "a" }, 8);
    const b = candidate({ id: "b" }, 3);
    expect(ids([a, b])).toEqual(["b", "a"]);
    expect(rank(ELDEN, RENTER, [a, b], { now: NOW }).reason?.rule).toBe("O4");
  });

  it("O5: lower price when everything else ties", () => {
    const dear = candidate({ id: "dear", priceCentsPerHour: 200 });
    const cheap = candidate({ id: "cheap", priceCentsPerHour: 100 });
    expect(ids([dear, cheap])).toEqual(["cheap", "dear"]);
    expect(rank(ELDEN, RENTER, [dear, cheap], { now: NOW }).reason).toEqual({
      rule: "O5",
      label: "Lowest price",
    });
  });

  it("O6: id breaks a full tie, so the order never depends on input order", () => {
    const b = candidate({ id: "b" });
    const a = candidate({ id: "a" });
    expect(ids([b, a])).toEqual(["a", "b"]);
    expect(ids([a, b])).toEqual(["a", "b"]);
    expect(rank(ELDEN, RENTER, [b, a], { now: NOW }).reason?.rule).toBe("O6");
  });

  it("gives no reason with fewer than two hosts", () => {
    expect(rank(ELDEN, RENTER, [candidate()], { now: NOW }).reason).toBeNull();
    expect(rank(ELDEN, RENTER, [], { now: NOW }).reason).toBeNull();
  });
});

describe("later", () => {
  it("counts a busy host that would otherwise qualify, and nothing else", () => {
    const busy = candidate({ id: "busy", status: "busy" });
    const busyAndStale = candidate({ id: "stale", status: "busy", lastHeartbeatAt: NOW - 60_000 });
    const busyAndOwn = candidate({ id: "own", status: "busy", ownerId: "you" });
    const busyAndFar = candidate({ id: "far", status: "busy" }, 120);
    const result = rank(ELDEN, RENTER, [busy, busyAndStale, busyAndOwn, busyAndFar], { now: NOW });
    expect(result.hosts).toEqual([]);
    expect(result.later.map((c) => c.host.id)).toEqual(["busy"]);
    expect(result.excluded).toHaveLength(4);
  });
});

describe("worked example: Elden Ring, 3 h tonight, Best", () => {
  const nova = candidate(
    { id: "nova", ownerId: "you", gpu: "RTX 4080", availableUntil: NOW + 12 * HOUR, uploadMbps: 30 },
    2,
  );
  const glass = candidate({ id: "glass", gpu: "RTX 4090", availableUntil: NOW + 4.5 * HOUR }, 9);
  const tide = candidate(
    { id: "tide", gpu: "RX 7900 XTX", availableUntil: NOW + 6 * HOUR, uploadMbps: 30 },
    21,
  );
  const ember = candidate(
    { id: "ember", gpu: "RTX 4070 Ti", availableUntil: NOW + (70 * HOUR) / 60, uploadMbps: 20 },
    14,
    { history: NEW },
  );
  const moss = candidate({ id: "moss", gpu: "RTX 3080", status: "busy", uploadMbps: 18 }, 38);
  const result = rank(ELDEN, RENTER, [nova, ember, moss, tide, glass], { now: NOW });

  it("excludes your own PC by E5 and hides the busy one as coming back", () => {
    expect(result.excluded.find((e) => e.candidate.host.id === "nova")?.failed).toEqual(["E5"]);
    expect(result.later.map((c) => c.host.id)).toEqual(["moss"]);
  });

  it("ranks the 4090 first as Lowest latency, then the XTX, then the short-lived 4070 Ti", () => {
    expect(result.hosts.map((h) => h.host.id)).toEqual(["glass", "tide", "ember"]);
    expect(result.reason).toEqual({ rule: "O3", label: "Lowest latency" });
  });

  it("scores each host as the plan does", () => {
    const [first, second, third] = result.hosts;
    expect(first).toMatchObject({ response: 4, picture: 4, stability: "steady", minutesLeft: 270 });
    expect(first!.headroom).toBeCloseTo(5.1);
    expect(second).toMatchObject({ response: 2, picture: 3, stability: "steady", coversSession: true });
    expect(second!.headroom).toBeCloseTo(3.9);
    expect(third).toMatchObject({ response: 3, picture: 2, stability: "new", minutesLeft: 70 });
    expect(third!.headroom).toBeCloseTo(3.1);
    expect(third!.coversSession).toBe(false);
  });
});
