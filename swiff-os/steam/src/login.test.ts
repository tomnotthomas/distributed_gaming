import { describe, expect, it } from "vitest";
import { LAUNCH_TIMEOUT_MS, play, POLL_MS, SIGN_IN_TIMEOUT_MS, type PlayEvent } from "./login.ts";
import type { SteamClient } from "./steam.ts";
import type { Display } from "./x11.ts";

/**
 * A Steam and a screen that follow a script, polled on a fake clock: `codes`
 * is what each look at the screen decodes, `signedInAfter` how many polls the
 * renter takes to approve, `onScreenAfter` how many polls the game takes to
 * reach the screen once launched.
 */
function fake(script: { codes?: string[][]; signedInAfter?: number; onScreenAfter?: number }) {
  let clock = 1_000;
  let looks = 0;
  let launchedAt: number | null = null;
  const launched: number[] = [];
  const steam: SteamClient = {
    signedIn: async () => looks >= (script.signedInAfter ?? Infinity),
    launch: async (appid) => {
      launched.push(appid);
      launchedAt = clock;
    },
  };
  const display: Display = {
    qrCodes: async () => script.codes?.[Math.min(looks++, script.codes.length - 1)] ?? (looks++, []),
    focusedApp: async () =>
      launchedAt !== null && clock - launchedAt >= (script.onScreenAfter ?? Infinity) * POLL_MS
        ? launched.at(-1)!
        : 0,
  };
  const events: PlayEvent[] = [];
  return {
    events,
    launched,
    opts: {
      steam,
      display,
      emit: (event: PlayEvent) => events.push(event),
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    },
  };
}

const QR_A = "https://s.team/q/1/1111111111111111111";
const QR_B = "https://s.team/q/1/2222222222222222222";

describe("play", () => {
  it("shows Steam's sign-in code, then launches the game once the renter approves, timing each step", async () => {
    const { events, launched, opts } = fake({ codes: [[QR_A]], signedInAfter: 3, onScreenAfter: 2 });

    const last = await play(570, opts);

    expect(events).toEqual([
      { event: "qr", url: QR_A, atMs: 0 },
      { event: "signed-in", atMs: 3 * POLL_MS },
      { event: "launching", appid: 570, atMs: 3 * POLL_MS },
      { event: "game-on-screen", appid: 570, atMs: 5 * POLL_MS },
    ]);
    expect(last).toEqual(events.at(-1));
    expect(launched).toEqual([570]);
  });

  it("sends a code again only when Steam shows a new one", async () => {
    const { events, opts } = fake({
      codes: [[], [QR_A], [QR_A], [QR_B], [QR_B]],
      signedInAfter: 5,
      onScreenAfter: 0,
    });

    await play(570, opts);

    expect(events.filter((e) => e.event === "qr")).toEqual([
      { event: "qr", url: QR_A, atMs: POLL_MS },
      { event: "qr", url: QR_B, atMs: 3 * POLL_MS },
    ]);
  });

  it("ignores QR codes on Steam's windows that are not Steam sign-in links", async () => {
    const { events, opts } = fake({
      codes: [["https://evil.example/q/1/1", "https://s.team/q/1/1x", QR_A]],
      signedInAfter: 1,
      onScreenAfter: 0,
    });

    await play(570, opts);

    expect(events.filter((e) => e.event === "qr").map((e) => e.event === "qr" && e.url)).toEqual([QR_A]);
  });

  it("launches at once when Steam is already signed in", async () => {
    const { events, opts } = fake({ signedInAfter: 0, onScreenAfter: 1 });

    await play(570, opts);

    expect(events.map((e) => e.event)).toEqual(["signed-in", "launching", "game-on-screen"]);
  });

  it("waits for the game booked, not whatever gamescope shows first", async () => {
    const { events, opts } = fake({ signedInAfter: 0, onScreenAfter: 1 });
    const focused = [0, 400, 570];
    opts.steam.launch = async () => {};
    const display = { ...fake({}).opts.display, focusedApp: async () => focused.shift() ?? 570 };

    await play(570, { ...opts, display });

    expect(events.at(-1)).toEqual({ event: "game-on-screen", appid: 570, atMs: 2 * POLL_MS });
  });

  it("gives up when the renter never approves", async () => {
    const { events, launched, opts } = fake({ codes: [[QR_A]] });

    const last = await play(570, opts);

    expect(last).toEqual({ event: "failed", reason: "sign-in-timeout", atMs: SIGN_IN_TIMEOUT_MS });
    expect(events.filter((e) => e.event === "qr")).toHaveLength(1);
    expect(launched).toEqual([]);
  });

  it("gives up when the game never reaches the screen", async () => {
    const { opts } = fake({ signedInAfter: 0 });

    expect(await play(570, opts)).toEqual({
      event: "failed",
      reason: "launch-timeout",
      atMs: LAUNCH_TIMEOUT_MS,
    });
  });

  it("stops when asked, before or after the sign-in", async () => {
    const stop = new AbortController();
    stop.abort();
    const before = fake({ codes: [[QR_A]] });
    expect(await play(570, { ...before.opts, signal: stop.signal })).toEqual({
      event: "failed",
      reason: "stopped",
      atMs: 0,
    });
    expect(before.events).toHaveLength(1);

    const after = fake({ signedInAfter: 0 });
    expect(await play(570, { ...after.opts, signal: stop.signal })).toMatchObject({ reason: "stopped" });
    expect(after.launched).toEqual([570]);
  });
});
