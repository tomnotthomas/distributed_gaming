import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "./derive";
import {
  askOf,
  fetchAvailability,
  fetchMachines,
  MAX_APPIDS,
  measureRtt,
  spotOf,
  type GameAvailability,
} from "./live";

const ask = askOf(31.6, DEFAULT_PREFS);
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), init);
const NOTHING = { free: 0, ready: 0, best: null, busy: 0, backAt: null, backName: null };

describe("measureRtt", () => {
  it("takes the quickest of three pings, timed by the clock where the browser keeps no timing", async () => {
    const times = [0, 80, 100, 112, 200, 230];
    const get = vi.fn(async (_url: string) => new Response(null, { status: 204 }));
    expect(
      await measureRtt(
        get as unknown as typeof fetch,
        () => times.shift()!,
        () => null,
        0,
      ),
    ).toBe(12);
    expect(get).toHaveBeenCalledTimes(3);
    expect(get.mock.calls[0]![0]).toMatch(/^\/api\/ping\?n=/);
    expect(new Set(get.mock.calls.map(([url]) => url)).size).toBe(3);
  });

  it("prefers the browser's own timing, which leaves out a busy page's wait", async () => {
    const get = vi.fn(async (_url: string) => new Response(null, { status: 204 }));
    const clock = [0, 150, 300, 450, 600, 750];
    const browser = [9.4, 7.6, 11];
    expect(
      await measureRtt(
        get as unknown as typeof fetch,
        () => clock.shift()!,
        () => browser.shift()!,
        0,
      ),
    ).toBe(8);
  });

  it("is null when the server cannot be reached", async () => {
    const get = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await measureRtt(get as unknown as typeof fetch)).toBeNull();
  });
});

describe("askOf", () => {
  it("turns Profile's settings into what the reads take", () => {
    expect(askOf(20, { quality: "fps", devices: ["pad"] })).toEqual({
      rttMs: 20,
      controls: ["pad"],
      picture: "120fps",
    });
  });
});

describe("fetchAvailability", () => {
  it("asks with the round trip, settings and session, a hundred games at a time", async () => {
    const get = vi.fn(async (path: string) => {
      const appids = new URL(path, "http://x").searchParams.get("appids")!.split(",").map(Number);
      return json(appids.map((appid) => ({ appid, ...NOTHING })));
    });
    const appids = Array.from({ length: MAX_APPIDS + 5 }, (_, i) => i + 1);
    const answer = await fetchAvailability([...appids, 1], 180, ask, get as unknown as typeof fetch);

    expect(answer.ok && answer.value.map((g) => g.appid)).toEqual(appids);
    expect(get).toHaveBeenCalledTimes(2);
    const first = new URL(get.mock.calls[0]![0], "http://x").searchParams;
    expect(first.get("appids")!.split(",")).toHaveLength(MAX_APPIDS);
    expect(Object.fromEntries(first)).toMatchObject({
      minutes: "180",
      rtt: "32",
      controls: "kb,mouse,pad",
      picture: "best",
    });
  });

  it("hands back how long to wait when over budget", async () => {
    const get = vi.fn(async () => json({}, { status: 429, headers: { "retry-after": "4" } }));
    expect(await fetchAvailability([730], 60, ask, get as unknown as typeof fetch)).toEqual({
      ok: false,
      retryAfterMs: 4000,
      read: [],
    });
  });

  it("hands back the parts read before going over budget, and asks a retry only for the rest", async () => {
    let budget = 1;
    const get = vi.fn(async (path: string) => {
      if (!budget--) return json({}, { status: 429, headers: { "retry-after": "2" } });
      const appids = new URL(path, "http://x").searchParams.get("appids")!.split(",").map(Number);
      return json(appids.map((appid) => ({ appid, ...NOTHING })));
    });
    const appids = Array.from({ length: MAX_APPIDS * 2 + 5 }, (_, i) => i + 1);
    const first = await fetchAvailability(appids, 60, ask, get as unknown as typeof fetch);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.retryAfterMs).toBe(2000);
    expect(first.read.map((g) => g.appid)).toEqual(appids.slice(0, MAX_APPIDS));

    budget = 2;
    get.mockClear();
    const again = await fetchAvailability(appids, 60, ask, get as unknown as typeof fetch, first.read);
    expect(again.ok && again.value.map((g) => g.appid)).toEqual(appids);
    const asked = get.mock.calls.flatMap(([p]) =>
      new URL(p, "http://x").searchParams.get("appids")!.split(",").map(Number),
    );
    expect(asked).toEqual(appids.slice(MAX_APPIDS));
  });

  it("fails without a wait when signed out or the server is down", async () => {
    const signedOut = vi.fn(async () => json({}, { status: 401 }));
    expect(await fetchAvailability([730], 60, ask, signedOut as unknown as typeof fetch)).toEqual({
      ok: false,
      retryAfterMs: null,
      read: [],
    });
    const down = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await fetchAvailability([730], 60, ask, down as unknown as typeof fetch)).toEqual({
      ok: false,
      retryAfterMs: null,
      read: [],
    });
  });
});

describe("fetchMachines", () => {
  it("asks for one game's machines for the session", async () => {
    const get = vi.fn(async (_url: string) =>
      json({ appid: 730, minutes: 60, machines: [], reason: null, busy: [] }),
    );
    const answer = await fetchMachines(730, 60, ask, get as unknown as typeof fetch);
    expect(answer.ok).toBe(true);
    expect(get.mock.calls[0]![0]).toBe(
      "/api/games/730/machines?minutes=60&rtt=32&controls=kb,mouse,pad&picture=best",
    );
  });
});

describe("spotOf", () => {
  const now = new Date(2026, 9, 3, 21, 0).getTime();
  const best = {
    id: "h1",
    name: "Basement rig",
    gpu: "RTX 4070",
    latency: { rttMs: 22.6, jitterMs: 2, source: "estimate" as const },
    availableUntil: new Date(2026, 9, 3, 23, 30).getTime(),
  };
  const game = (over: Partial<GameAvailability>): GameAvailability => ({ appid: 730, ...NOTHING, ...over });

  it("offers the best ready host by name, with its free-until on the real clock", () => {
    expect(spotOf(game({ free: 2, ready: 1, best }), now)).toEqual({
      free: 2,
      ready: 1,
      busy: 0,
      best: {
        id: "h1",
        name: "Basement rig",
        gpu: "RTX 4070",
        ping: 23,
        quality: "",
        until: "23:30",
        untilAt: best.availableUntil,
        busy: false,
      },
      back: null,
    });
  });

  it("reads a host offered until taken back, or twelve hours or more, as free for 12 h+", () => {
    expect(spotOf(game({ ready: 1, best: { ...best, availableUntil: null } }), now).best?.until).toBe("late");
    const tomorrow = now + 13 * 3_600_000;
    expect(spotOf(game({ ready: 1, best: { ...best, availableUntil: tomorrow } }), now).best?.until).toBe(
      "late",
    );
  });

  it("says which host is back, and when, from its schedule", () => {
    const backAt = new Date(2026, 9, 3, 22, 15).getTime();
    expect(spotOf(game({ busy: 1, backAt, backName: "Loft" }), now).back).toEqual({
      name: "Loft",
      at: "22:15",
      backAt,
    });
    expect(spotOf(game({ busy: 1, backAt, backName: null }), now).back).toEqual({
      name: "A shared PC",
      at: "22:15",
      backAt,
    });
  });
});
