import { describe, expect, it } from "vitest";
import { DEMO_STANDING, evening } from "./demo";
import { euros, inLabel, mmss, shortGpu, span } from "./format";
import {
  appidIn,
  installShare,
  buildRate,
  glanceOf,
  levelAt,
  levelProgress,
  liveScreen,
  nextAt,
  reliabilityFactor,
  IDLE_RUN,
  sessionEarned,
  untilChoices,
  untilSentence,
  type Claim,
  type HostView,
  type Live,
} from "./model";

const CLAIM: Claim = { appid: 1245620, name: "Elden Ring", minutes: 90, at: evening(21, 10), rate: 1.05 };

/** This PC's view, as useHost builds it: nothing the platform does not report. */
function realView(live: Live): HostView {
  return {
    demo: false,
    now: evening(21, 30),
    machine: "gaming-pc-1",
    pc: { reading: false, hardware: null, hardwareRate: null },
    games: { installed: [], offered: [], demand: null, near: null },
    steam: { status: null, installer: { kind: "idle" }, installs: [], asked: [] },
    rental: { reading: false, read: null, target: null, preview: null, run: IDLE_RUN },
    standing: null,
    earlyEnd: null,
    rate: null,
    earnings: null,
    live,
    plan: null,
    sessionsToday: 0,
    connection: { url: "", machineId: "gaming-pc-1", machineKey: "", name: "", notice: null, preview: null },
    payoutSaved: false,
    crew: null,
  };
}

describe("the rate", () => {
  it("is the hardware rate, times reliability, plus the level's bonus", () => {
    const rate = buildRate(1, DEMO_STANDING);
    expect(rate.level.name).toBe("Steady");
    expect(rate.factor).toBe(1);
    expect(euros(rate.total)).toBe("1,05");
  });

  it("drops with reliability, as ending a session early costs", () => {
    expect(euros(buildRate(1, { ...DEMO_STANDING, reliability: 91 }).total)).toBe("0,97");
  });

  it("keeps less of the hardware rate at each reliability band", () => {
    expect([100, 95, 94, 85, 84, 70, 69].map(reliabilityFactor)).toEqual([1, 1, 0.92, 0.92, 0.8, 0.8, 0.65]);
  });
});

describe("levels", () => {
  it("count reliable hours", () => {
    expect([0, 24, 25, 99, 100, 300].map((h) => levelAt(h).name)).toEqual([
      "Starter",
      "Starter",
      "Steady",
      "Steady",
      "Trusted",
      "Keystone",
    ]);
  });

  it("say how far the next one is", () => {
    expect(levelProgress(61)).toMatchObject({ share: 0.61, line: "61 of 100 reliable hours to Trusted" });
    expect(levelProgress(320)).toMatchObject({
      next: null,
      share: 1,
      line: "320 reliable hours, the top level",
    });
  });
});

describe("share until", () => {
  it("offers 2, 4 and 10 hours on the hour, and open", () => {
    expect(untilChoices(evening(21)).map((c) => [c.time, c.label])).toEqual([
      ["23:00", "in 2 hours"],
      ["01:00", "in 4 hours"],
      ["07:00", "in 10 hours"],
      ["Open", "until I stop it"],
    ]);
  });

  it("says exactly how far off a rounded time is", () => {
    expect(
      untilChoices(evening(21, 40))
        .slice(0, 2)
        .map((c) => [c.time, c.label]),
    ).toEqual([
      ["00:00", "in 2 h 20 min"],
      ["02:00", "in 4 h 20 min"],
    ]);
  });

  it("takes an exact time as its next occurrence", () => {
    expect(nextAt("00:30", evening(21))).toBe(evening(0, 30));
    expect(nextAt("22:15", evening(21))).toBe(evening(22, 15));
    expect(nextAt("25:00", evening(21))).toBeNull();
    expect(nextAt("", evening(21))).toBeNull();
  });

  it("states what the choice means for players, and for a running session", () => {
    expect(untilSentence("Nova-01", evening(1))).toBe(
      "Players can claim Nova-01 until 01:00. A session that starts before then is protected until its claimed end.",
    );
    expect(untilSentence("Nova-01", null)).toMatch(/^Players can claim Nova-01 until you stop sharing\./);
  });
});

describe("sessions", () => {
  it("earn at the rate fixed when claimed, up to the claimed end", () => {
    expect(euros(sessionEarned(CLAIM, evening(21, 40))!)).toBe("0,53");
    expect(sessionEarned(CLAIM, evening(23, 59))).toBeCloseTo(1.05 * 1.5);
  });

  it("earn nothing shown where there is no rate", () => {
    expect(sessionEarned({ ...CLAIM, rate: null }, evening(21, 40))).toBeNull();
  });

  it("show the in-use screen only while someone is at the keyboard", () => {
    const session = (atPc: boolean): Live => ({
      kind: "session",
      since: evening(21),
      until: null,
      claim: CLAIM,
      playerHere: true,
      stopNew: false,
      notify: false,
      atPc,
    });
    expect(liveScreen(session(false))).toBe("streaming");
    expect(liveScreen(session(true))).toBe("inuse");
    expect(liveScreen({ kind: "off", note: null })).toBe("golive");
    expect(liveScreen({ kind: "starting" })).toBe("golive");
  });
});

describe("the tray glance", () => {
  it("offers the one action that fits the state", () => {
    const waiting = glanceOf(
      realView({ kind: "waiting", since: evening(21), until: evening(1), registered: true }),
    );
    expect(waiting).toMatchObject({ status: "Live until 01:00", live: true, action: { id: "pause" } });

    const paused = glanceOf(realView({ kind: "paused", at: evening(21, 31) }));
    expect(paused).toMatchObject({ status: "Paused at 21:31", live: false, action: { id: "resume" } });

    expect(glanceOf(realView({ kind: "off", note: null }))).toMatchObject({
      status: "Not sharing",
      action: null,
    });
  });

  it("shows the session's game, and no earnings this PC cannot know", () => {
    const glance = glanceOf(
      realView({
        kind: "session",
        since: evening(21),
        until: null,
        claim: { ...CLAIM, rate: null },
        playerHere: true,
        stopNew: true,
        notify: false,
        atPc: false,
      }),
    );
    expect(glance.game).toEqual({ appid: 1245620, caption: "Elden Ring, protected until 22:40" });
    expect(glance.figure).toBeNull();
    expect(glance.action).toEqual({ id: "allow-new", label: "Allow new sessions" });
    expect(glance.foot).toBe("gaming-pc-1");
  });
});

describe("format", () => {
  it("writes figures and times the way the screens print them", () => {
    expect(euros(4.2)).toBe("4,20");
    expect(inLabel(2 * 3_600_000)).toBe("in 2 hours");
    expect(inLabel(25 * 60_000)).toBe("in 25 min");
    expect(span(37 * 60_000)).toBe("37 min");
    expect(span(4 * 3_600_000)).toBe("4 h");
    expect(mmss(299_400)).toBe("5:00");
    expect(mmss(244_000)).toBe("4:04");
    expect(shortGpu("NVIDIA GeForce RTX 4080")).toBe("RTX 4080");
    expect(shortGpu("AMD Radeon RX 7900 XTX")).toBe("Radeon RX 7900 XTX");
    expect(shortGpu("Apple M2")).toBe("Apple M2");
  });
});

describe("installing games", () => {
  it("finds the appid in what the owner pastes", () => {
    expect(appidIn(" 570 ")).toBe(570);
    expect(appidIn("https://store.steampowered.com/app/570/Dota_2/")).toBe(570);
    expect(appidIn("store.steampowered.com/app/1172470?l=german")).toBe(1172470);
    expect(appidIn("steam://install/440")).toBe(440);
  });

  it("finds none in anything else", () => {
    for (const text of [
      "",
      "dota",
      "0",
      "-5",
      "https://evil.example/app/570",
      "steam://uninstall/570",
      "steam://run/570",
      "steam://rungameid/570",
      "99999999999",
    ])
      expect(appidIn(text)).toBeNull();
  });

  it("knows how far an install is once Steam knows its size", () => {
    const install = { appid: 570, name: "Dota 2", phase: "downloading" as const };
    expect(installShare({ ...install, done: 25, total: 100 })).toBe(0.25);
    expect(installShare({ ...install, done: 0, total: 0 })).toBeNull();
  });
});
