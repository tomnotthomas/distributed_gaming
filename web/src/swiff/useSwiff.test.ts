import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { RenterSessionEvent, RenterSessionOptions } from "@swiff/rtc";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdPlay, storedPlay } from "./booking";
import { GAMES } from "./data";
import { RECONNECT_GRACE_MS, WAKE_TIMEOUT_MS } from "./play";
import { GameMenu } from "./GameMenu";
import type { GameAvailability, GameMachines } from "./live";
import type { Renter } from "./steam";
import { SLOW_POLL_MS } from "./useLive";
import { isDemo, useSwiff } from "./useSwiff";

// The real module refuses to load without a key in dev: tests stand in for it and read what the funnel was told.
const track = vi.hoisted(() => vi.fn());
vi.mock("../posthog", () => ({ default: { capture: track }, isPostHogEnabled: true }));

/** The renter sessions the page started, each driven by the test: what it joined with, its events, its end. */
const rtc = vi.hoisted(() => ({
  sessions: [] as {
    options: RenterSessionOptions;
    emit: (event: RenterSessionEvent) => void;
    ended: boolean;
  }[],
}));
vi.mock("@swiff/rtc", () => ({
  startRenterSession: (options: RenterSessionOptions) => {
    const listeners = new Set<(event: RenterSessionEvent) => void>();
    const session = {
      options,
      ended: false,
      emit: (event: RenterSessionEvent) => listeners.forEach((fn) => fn(event)),
    };
    rtc.sessions.push(session);
    return {
      on: (listener: (event: RenterSessionEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      stats: () => null,
      end: () => {
        session.ended = true;
      },
    };
  },
}));

/** What /api/me answers without a Steam Web API key: the session's Steam id, an empty profile. */
const unnamed: Renter = {
  steamId: "76561198000000001",
  profile: { id: "0001", persona: "", avatar: "", hours: 0, size: 0, owned: [], games: [], lib: false },
};

/** The real hosts the server knows about, for the reads a signed-in renter makes. */
type Hosts = {
  availability?: (appid: number) => Omit<GameAvailability, "appid">;
  machines?: (appid: number) => Omit<GameMachines, "appid">;
};

/**
 * The server: /api/me answers `renter` (404 when null), /api/ping answers, the
 * availability reads answer from `hosts` for a signed-in renter (401 signed
 * out), each "METHOD path" in `booking` answers as it says, and every catalog
 * read comes back empty. Returns every call made, with its JSON body.
 */
function serve(renter: Renter | null, hosts: Hosts = {}, booking: Record<string, () => Response> = {}) {
  const calls: { call: string; body: unknown }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const call = `${init?.method ?? "GET"} ${path}`;
      calls.push({ call, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (booking[call]) return booking[call]!();
      const url = new URL(path, "http://localhost");
      if (url.pathname === "/api/me") return renter ? json(renter) : json({}, 404);
      if (url.pathname === "/api/ping") return new Response(null, { status: 204 });
      if (url.pathname === "/api/availability") {
        if (!renter) return json({ error: "sign in with Steam first" }, 401);
        const appids = url.searchParams.get("appids")!.split(",").map(Number);
        return json(appids.map((appid) => ({ appid, ...(hosts.availability?.(appid) ?? NOTHING) })));
      }
      const game = /^\/api\/games\/(\d+)\/machines$/.exec(url.pathname);
      if (game) {
        if (!renter) return json({ error: "sign in with Steam first" }, 401);
        const appid = Number(game[1]);
        return json({ appid, ...(hosts.machines?.(appid) ?? NO_MACHINES) });
      }
      return json({}, 404);
    }),
  );
  return calls;
}

/** A canned answer for a booking call. */
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });

/** A booking of b-1 for Counter-Strike 2 in `status`. */
const booked = (status: string, claimBy?: number) => ({
  bookingId: "b-1",
  status,
  gameId: 730,
  minutes: 180,
  ...(claimBy === undefined ? {} : { claimBy }),
});

const TICKET = { sessionId: "s-1", roomId: "pc-1", signalingUrl: "ws://localhost", ticket: "t" };

/** The page's event streams, opened through a stand-in for EventSource that each test drives. */
function streams() {
  const opened: { url: string; push: (data: unknown) => void }[] = [];
  vi.stubGlobal(
    "EventSource",
    class {
      readonly listeners = new Map<string, ((event: Event) => void)[]>();
      constructor(readonly url: string) {
        opened.push({
          url,
          push: (data) =>
            this.listeners
              .get("booking")
              ?.forEach((l) => l(new MessageEvent("booking", { data: JSON.stringify(data) }))),
        });
      }
      addEventListener(type: string, listener: (event: Event) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      close() {}
    },
  );
  return opened;
}

const NOTHING = { free: 0, ready: 0, best: null, busy: 0, backAt: null, backName: null };
const NO_MACHINES = { minutes: 180, machines: [], reason: null, busy: [] };

/** The paths fetched so far. */
const fetched = () => vi.mocked(fetch).mock.calls.map(([path]) => String(path));

/**
 * The browser's Web Locks, shared by every page of the test as by every tab of
 * one browser: the names held now, granted one at a time.
 */
function locks() {
  const held = new Set<string>();
  const manager = {
    async request(name: string, callback: () => Promise<void>) {
      held.add(name);
      try {
        await callback();
      } finally {
        held.delete(name);
      }
    },
    query: async () => ({ held: [...held].map((name) => ({ name })), pending: [] }),
  } as unknown as LockManager;
  Object.defineProperty(navigator, "locks", { value: manager, configurable: true });
  return { held, manager };
}

/** A free-to-play game with a machine free tonight, so only sign-in can stand in its way. */
const cs2 = GAMES.find((game) => game.id === "cs")!;

/** One real host free for every game, as the server ranks it. */
const HOST = {
  id: "h1",
  name: "Basement rig",
  gpu: "RTX 4070",
  cpu: "Ryzen 7 7700",
  refreshHz: 144,
  availableUntil: null,
  minutesLeft: null,
  coversSession: true,
  latency: { rttMs: 23, jitterMs: 2, source: "estimate" as const },
  response: 3,
  picture: 3,
};
/** The server's list: h1, and h2 the next best behind it. */
const LIVE: Hosts = {
  machines: () => ({ ...NO_MACHINES, machines: [HOST, { ...HOST, id: "h2", name: "Attic box" }] }),
};

/** A signed-in renter on the real hosts with Counter-Strike 2 open and h1 picked. */
async function openLive() {
  const { result } = renderHook(() => useSwiff({ demo: false }));
  await waitFor(() => expect(result.current.signedIn).toBe(true));
  act(() => result.current.openGame(result.current.games.find((g) => g.appid === cs2.appid)!));
  await waitFor(() => expect(result.current.picked?.id).toBe("h1"));
  return result;
}

describe("useSwiff", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    rtc.sessions = [];
    delete (navigator as { locks?: LockManager }).locks;
  });

  it("is the demo only at ?demo=1", () => {
    expect(isDemo("?demo=1")).toBe(true);
    expect(isDemo("")).toBe(false);
    expect(isDemo("?demo=0")).toBe(false);
  });

  it("reads signed in from the session even when Steam gave no name", async () => {
    serve(unnamed);
    const { result } = renderHook(() => useSwiff({ demo: true }));

    await waitFor(() => expect(result.current.signedIn).toBe(true));
    expect(result.current.steamId).toBe(unnamed.steamId);
    expect(result.current.profile?.persona).toBe("");
  });

  it("will not launch for a signed-out visitor", async () => {
    serve(null);
    const { result } = renderHook(() => useSwiff({ demo: true }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/me"));

    act(() => result.current.openGame(cs2));
    expect(result.current.picked).not.toBeNull();
    act(() => result.current.launch());

    expect(result.current.signedIn).toBe(false);
    expect(result.current.phase).toBe("idle");
  });

  it("launches for a signed-in renter in the demo, with no booking made", async () => {
    serve(unnamed);
    const { result } = renderHook(() => useSwiff({ demo: true }));
    await waitFor(() => expect(result.current.signedIn).toBe(true));

    const game = result.current.games.find((g) => g.appid === cs2.appid)!;
    act(() => result.current.openGame(game));
    act(() => result.current.launch());

    expect(result.current.phase).toBe("connecting");
    // The demo's machines are invented: nothing is booked or queued for them.
    act(() => result.current.joinQueue());
    expect(fetched().some((p) => p.startsWith("/api/bookings"))).toBe(false);
  });

  describe("on the real hosts", () => {
    // jsdom has no EventSource, so the hook falls back to its slow poll here.

    it("never asks a signed-out visitor's availability, and lists no invented machine", async () => {
      serve(null);
      const { result } = renderHook(() => useSwiff({ demo: false }));
      await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/me"));

      expect(result.current.seesAvailability).toBe(false);
      expect(result.current.spots.size).toBe(0);
      expect(result.current.liveLine).toBeUndefined();
      act(() => result.current.openGame(cs2));
      expect(result.current.machines).toEqual([]);
      expect(result.current.picked).toBeNull();
      expect(fetched().some((p) => p.startsWith("/api/availability") || p.includes("/machines"))).toBe(false);
      // The invented machines are the demo's alone.
      expect(Object.keys(result.current.pool)).toEqual([]);
      expect(result.current.games.every((g) => !g.fromLibrary || g.machines.length === 0)).toBe(true);
    });

    it("reads a signed-in renter's wall from the server, with their round trip and settings", async () => {
      serve(unnamed, {
        availability: (appid) =>
          appid === cs2.appid
            ? {
                ...NOTHING,
                free: 1,
                ready: 1,
                best: {
                  id: "h1",
                  name: "Basement rig",
                  gpu: "RTX 4070",
                  latency: { rttMs: 23, jitterMs: 2, source: "estimate" },
                  availableUntil: null,
                },
              }
            : NOTHING,
      });
      const { result } = renderHook(() => useSwiff({ demo: false }));
      await waitFor(() => expect(result.current.spots.get(cs2.id)?.best?.name).toBe("Basement rig"));

      const ask = fetched().find((p) => p.startsWith("/api/availability"))!;
      expect(ask).toMatch(/minutes=180/);
      expect(ask).toMatch(/rtt=\d+/);
      expect(ask).toMatch(/controls=kb,mouse,pad/);
      expect(ask).toMatch(/picture=best/);
      expect(result.current.liveLine).toBe("1 game ready now");
      expect(fetched().some((p) => p.startsWith("/api/ping"))).toBe(true);
    });

    it("lists the open game's hosts as the server ranked them, and picks the best free one", async () => {
      serve(unnamed, {
        machines: () => ({
          ...NO_MACHINES,
          machines: [
            {
              id: "h1",
              name: "Basement rig",
              gpu: "RTX 4070",
              cpu: "Ryzen 7 7700",
              refreshHz: 144,
              availableUntil: null,
              minutesLeft: null,
              coversSession: true,
              latency: { rttMs: 23, jitterMs: 2, source: "estimate" },
              response: 3,
              picture: 3,
            },
          ],
          reason: null,
        }),
      });
      const { result } = renderHook(() => useSwiff({ demo: false }));
      await waitFor(() => expect(result.current.signedIn).toBe(true));
      const game = result.current.games.find((g) => g.appid === cs2.appid)!;
      act(() => result.current.openGame(game));
      expect(result.current.machinesLoading).toBe(true);

      await waitFor(() => expect(result.current.picked?.id).toBe("h1"));
      expect(result.current.machines.map((m) => m.name)).toEqual(["Basement rig"]);
      expect(fetched().some((p) => p.startsWith(`/api/games/${cs2.appid}/machines?minutes=180&rtt=`))).toBe(
        true,
      );
      expect(result.current.liveLine).toBe("1 free for this game");
    });

    it("keeps the machine a session is on when a re-read says it is now taken", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const host = {
        id: "h1",
        name: "Basement rig",
        gpu: "RTX 4070",
        cpu: "Ryzen 7 7700",
        refreshHz: 144,
        availableUntil: null,
        minutesLeft: null,
        coversSession: true,
        latency: { rttMs: 23, jitterMs: 2, source: "estimate" as const },
        response: 3,
        picture: 3,
      };
      let taken = false;
      serve(
        unnamed,
        {
          machines: () =>
            taken
              ? { ...NO_MACHINES, busy: [{ id: "h1", name: "Basement rig", backAt: null }] }
              : { ...NO_MACHINES, machines: [host] },
        },
        {
          "POST /api/bookings": json(202, { ...booked("matched", 1_000), machine: { id: "h1" } }),
          "POST /api/bookings/b-1/claim": json(200, TICKET),
        },
      );
      try {
        const { result } = renderHook(() => useSwiff({ demo: false }));
        await waitFor(() => expect(result.current.signedIn).toBe(true));
        const game = result.current.games.find((g) => g.appid === cs2.appid)!;
        act(() => result.current.openGame(game));
        await waitFor(() => expect(result.current.picked?.id).toBe("h1"));
        act(() => result.current.launch());
        expect(result.current.phase).not.toBe("idle");

        taken = true;
        await act(() => vi.advanceTimersByTimeAsync(SLOW_POLL_MS * 2));
        await waitFor(() => expect(result.current.machines[0]?.busy).toBe(true));
        expect(result.current.phase).not.toBe("idle");
        expect(result.current.picked?.name).toBe("Basement rig");
      } finally {
        vi.useRealTimers();
      }
    });

    it("books the picked host by its server id, with the measured round trip, and claims it with no click", async () => {
      const calls = serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("matched", 1_000)),
        "POST /api/bookings/b-1/claim": json(200, TICKET),
      });
      streams();
      const result = await openLive();
      act(() => result.current.launch());

      expect(result.current.phase).toBe("connecting");
      await waitFor(() => expect(result.current.claim).toEqual(TICKET));
      const body = calls.find((c) => c.call === "POST /api/bookings")!.body as Record<string, unknown>;
      expect(body).toMatchObject({ gameId: cs2.appid, minutes: 180, machineId: "h1" });
      expect(body.rtts).toEqual({ server: expect.any(Number) });
      expect(result.current.phase).toBe("connecting");
    });

    it("drops a join ticket kept on disk before tickets stopped being stored", async () => {
      localStorage.setItem("swiff.play", JSON.stringify({ bookingId: "b-1", claim: TICKET }));
      serve(unnamed, LIVE, {});
      streams();
      await openLive();
      expect(localStorage.getItem("swiff.play")).toBeNull();
    });

    it("plays the claimed stream behind Ignition, step by step, and ends the session with End", async () => {
      const calls = serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, { ...booked("matched", 1_000), machine: { id: "h1" } }),
        "POST /api/bookings/b-1/claim": json(200, TICKET),
        "POST /api/sessions/s-1/start": json(200, { sessionId: "s-1", roomId: "pc-1" }),
        "POST /api/bookings/b-1/end": json(200, booked("ended")),
      });
      streams();
      const result = await openLive();
      act(() => result.current.launch());
      expect(result.current.ignitionSteps[result.current.ignitionIndex]).toBe("Reserving a machine");

      await waitFor(() => expect(result.current.claim).toEqual(TICKET));
      // Kept as the booking being played, for the later resume step.
      expect(storedPlay()).toEqual({ bookingId: "b-1", sessionId: "s-1", roomId: "pc-1" });
      const video = document.createElement("video");
      act(() => result.current.attachVideo(video));
      expect(rtc.sessions).toHaveLength(1);
      const session = rtc.sessions[0]!;
      expect(session.options).toMatchObject({ url: "ws://localhost", ticket: "t", video });
      const step = () => result.current.ignitionSteps[result.current.ignitionIndex];
      expect(step()).toBe("Waking Basement rig");

      act(() => session.emit({ type: "peer-connection", pc: {} as RTCPeerConnection }));
      expect(step()).toBe("Negotiating stream");
      act(() => session.emit({ type: "connected" }));
      expect(step()).toBe("Launching Counter-Strike 2");
      act(() => session.emit({ type: "first-frame" }));
      await waitFor(() => expect(calls.map((c) => c.call)).toContain("POST /api/sessions/s-1/start"));
      expect(result.current.phase).toBe("connecting");
      act(() => session.emit({ type: "game-started" }));
      expect(result.current.phase).toBe("live");

      act(() => result.current.endSession());
      expect(result.current.phase).toBe("idle");
      expect(session.ended).toBe(true);
      await waitFor(() => expect(calls.map((c) => c.call)).toContain("POST /api/bookings/b-1/end"));
      expect(storedPlay()).toBeNull();
    });

    it("ends a live session the server ended as a session end, not a failed launch", async () => {
      const calls = serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, { ...booked("matched", 1_000), machine: { id: "h1" } }),
        "POST /api/bookings/b-1/claim": json(200, TICKET),
        "POST /api/sessions/s-1/start": json(200, { sessionId: "s-1", roomId: "pc-1" }),
        "POST /api/bookings/b-1/end": json(409, { status: "ended" }),
      });
      streams();
      const result = await openLive();
      act(() => result.current.launch());
      await waitFor(() => expect(result.current.claim).toEqual(TICKET));
      act(() => result.current.attachVideo(document.createElement("video")));
      const session = rtc.sessions[0]!;
      act(() => session.emit({ type: "first-frame" }));
      act(() => session.emit({ type: "game-started" }));
      expect(result.current.phase).toBe("live");
      track.mockClear();

      act(() => session.emit({ type: "denied", reason: "bad-ticket" }));
      expect(result.current.phase).toBe("idle");
      expect(result.current.bookingFailed).toBe(false);
      expect(result.current.claim).toBeNull();
      expect(track).toHaveBeenCalledWith("session_ended", expect.anything());
      expect(storedPlay()).toBeNull();
      await waitFor(() => expect(calls.map((c) => c.call)).toContain("POST /api/bookings/b-1/end"));
    });

    it("fails the launch when the ticket is denied during Ignition", async () => {
      serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("matched", 1_000)),
        "POST /api/bookings/b-1/claim": json(200, TICKET),
        "POST /api/bookings/b-1/end": json(200, booked("ended")),
      });
      streams();
      const result = await openLive();
      act(() => result.current.launch());
      await waitFor(() => expect(result.current.claim).toEqual(TICKET));
      act(() => result.current.attachVideo(document.createElement("video")));
      track.mockClear();

      act(() => rtc.sessions[0]!.emit({ type: "denied", reason: "bad-ticket" }));
      expect(result.current.phase).toBe("idle");
      expect(result.current.bookingFailed).toBe(true);
      expect(track).not.toHaveBeenCalledWith("session_ended", expect.anything());
      expect(storedPlay()).toBeNull();
    });

    it("goes back behind Ignition when the PC leaves mid-session, keeping the session clock", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        serve(unnamed, LIVE, {
          "POST /api/bookings": json(202, booked("matched", Date.now() + 60_000)),
          "POST /api/bookings/b-1/claim": json(200, TICKET),
          "POST /api/sessions/s-1/start": json(200, { sessionId: "s-1", roomId: "pc-1" }),
        });
        streams();
        const result = await openLive();
        act(() => result.current.launch());
        await waitFor(() => expect(result.current.claim).toEqual(TICKET));
        act(() => result.current.attachVideo(document.createElement("video")));
        const session = rtc.sessions[0]!;
        act(() => session.emit({ type: "first-frame" }));
        act(() => session.emit({ type: "game-started" }));
        expect(result.current.phase).toBe("live");
        await act(() => vi.advanceTimersByTimeAsync(5_000));
        expect(result.current.elapsedMs).toBeGreaterThanOrEqual(4_000);

        act(() => session.emit({ type: "peer-left" }));
        expect(result.current.phase).toBe("connecting");
        expect(result.current.ignitionSteps[result.current.ignitionIndex]).toBe("Waking Basement rig");

        act(() => session.emit({ type: "first-frame" }));
        act(() => session.emit({ type: "game-started" }));
        expect(result.current.phase).toBe("live");
        await act(() => vi.advanceTimersByTimeAsync(1_000));
        expect(result.current.elapsedMs).toBeGreaterThanOrEqual(5_000);
      } finally {
        vi.useRealTimers();
      }
    });

    describe("after the PC drops a started session", () => {
      /** A session live on h1 for 10 s, then back behind Ignition because its PC left. */
      async function dropped(extra: Record<string, Response> = {}) {
        const calls = serve(unnamed, LIVE, {
          "POST /api/bookings": json(202, booked("matched", Date.now() + 600_000)),
          "POST /api/bookings/b-1/claim": json(200, TICKET),
          "POST /api/sessions/s-1/start": json(200, { sessionId: "s-1", roomId: "pc-1" }),
          "POST /api/bookings/b-1/end": json(200, booked("ended")),
          ...extra,
        });
        streams();
        const result = await openLive();
        act(() => result.current.launch());
        await waitFor(() => expect(result.current.claim).toEqual(TICKET));
        act(() => result.current.attachVideo(document.createElement("video")));
        const session = rtc.sessions[0]!;
        act(() => session.emit({ type: "first-frame" }));
        act(() => session.emit({ type: "game-started" }));
        await waitFor(() => expect(result.current.play?.started).toBe(true));
        expect(result.current.phase).toBe("live");
        await act(() => vi.advanceTimersByTimeAsync(10_000));
        act(() => session.emit({ type: "peer-left" }));
        expect(result.current.phase).toBe("connecting");
        track.mockClear();
        return { result, calls, session };
      }

      beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it("ends a session the server ended behind Ignition as a session end, not a failed launch", async () => {
        const { result, calls, session } = await dropped();

        act(() => session.emit({ type: "denied", reason: "bad-ticket" }));
        expect(result.current.phase).toBe("idle");
        expect(result.current.bookingFailed).toBe(false);
        expect(track).toHaveBeenCalledWith("session_ended", { seconds: expect.any(Number) });
        expect(
          track.mock.calls.find(([name]) => name === "session_ended")![1].seconds,
        ).toBeGreaterThanOrEqual(9);
        await waitFor(() => expect(calls.map((c) => c.call)).toContain("POST /api/bookings/b-1/end"));
      });

      it("ends it as a session with End on Ignition", async () => {
        const { result, calls } = await dropped();

        act(() => result.current.goHome());
        expect(result.current.phase).toBe("idle");
        expect(track).toHaveBeenCalledWith("session_ended", { seconds: expect.any(Number) });
        await waitFor(() => expect(calls.map((c) => c.call)).toContain("POST /api/bookings/b-1/end"));
      });

      it("leaves Escape and a controller's B to the game: only End ends it", async () => {
        const pad = { axes: [0], buttons: Array.from({ length: 16 }, () => ({ pressed: false })) };
        Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => [pad] });
        try {
          const { result, calls } = await dropped();

          act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
          pad.buttons[1]!.pressed = true;
          await act(() => vi.advanceTimersByTimeAsync(500));
          expect(result.current.phase).toBe("connecting");
          expect(result.current.claim).toEqual(TICKET);
          expect(track).not.toHaveBeenCalledWith("session_ended", expect.anything());
          expect(calls.map((c) => c.call)).not.toContain("POST /api/bookings/b-1/end");
        } finally {
          delete (navigator as { getGamepads?: unknown }).getGamepads;
        }
      });

      it("ends it as a session before trying another machine, whose clock starts afresh", async () => {
        const { result, calls } = await dropped();
        await act(() => vi.advanceTimersByTimeAsync(WAKE_TIMEOUT_MS));
        expect(result.current.slow).toBe(true);

        act(() => result.current.tryAnother());
        expect(track).toHaveBeenCalledWith("session_ended", { seconds: expect.any(Number) });
        await waitFor(() =>
          expect(calls.filter((c) => c.call === "POST /api/bookings").at(-1)!.body).toMatchObject({
            machineId: "h2",
          }),
        );
        expect(calls.map((c) => c.call)).toContain("POST /api/bookings/b-1/end");
        await waitFor(() => expect(rtc.sessions).toHaveLength(2));
        const next = rtc.sessions[1]!;
        act(() => next.emit({ type: "first-frame" }));
        act(() => next.emit({ type: "game-started" }));
        expect(result.current.phase).toBe("live");
        expect(result.current.elapsedMs).toBeLessThan(2_000);
      });
    });

    it("cancels a launch by ending its booking and hanging up", async () => {
      const calls = serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("matched", 1_000)),
        "POST /api/bookings/b-1/claim": json(200, TICKET),
        "POST /api/bookings/b-1/end": json(200, booked("ended")),
      });
      streams();
      const result = await openLive();
      act(() => result.current.launch());
      await waitFor(() => expect(result.current.claim).toEqual(TICKET));
      act(() => result.current.attachVideo(document.createElement("video")));

      act(() => result.current.goHome());
      expect(result.current.phase).toBe("idle");
      expect(rtc.sessions[0]!.ended).toBe(true);
      await waitFor(() => expect(calls.map((c) => c.call)).toContain("POST /api/bookings/b-1/end"));
    });

    it("offers another machine when the PC takes too long to wake, and launches on it", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const calls = serve(unnamed, LIVE, {
          "POST /api/bookings": json(202, booked("matched", Date.now() + 60_000)),
          "POST /api/bookings/b-1/claim": json(200, TICKET),
          "POST /api/bookings/b-1/end": json(200, booked("ended")),
        });
        streams();
        const result = await openLive();
        act(() => result.current.launch());
        await waitFor(() => expect(result.current.claim).toEqual(TICKET));
        act(() => result.current.attachVideo(document.createElement("video")));
        expect(result.current.slow).toBe(false);

        await act(() => vi.advanceTimersByTimeAsync(WAKE_TIMEOUT_MS));
        expect(result.current.slow).toBe(true);
        expect(result.current.phase).toBe("connecting");

        act(() => result.current.tryAnother());
        expect(rtc.sessions[0]!.ended).toBe(true);
        await waitFor(() =>
          expect(calls.filter((c) => c.call === "POST /api/bookings").at(-1)!.body).toMatchObject({
            machineId: "h2",
          }),
        );
        expect(calls.map((c) => c.call)).toContain("POST /api/bookings/b-1/end");
        expect(result.current.picked?.id).toBe("h2");
        expect(result.current.phase).toBe("connecting");
      } finally {
        vi.useRealTimers();
      }
    });

    it("books with how the renter plays, as their list was read", async () => {
      const calls = serve(unnamed, LIVE, { "POST /api/bookings": json(202, booked("matched", 1_000)) });
      streams();
      const result = await openLive();
      act(() => result.current.toggleDevice("mouse"));
      act(() => result.current.setQuality("fps"));
      await waitFor(() => expect(result.current.picked?.id).toBe("h1"));
      act(() => result.current.launch());

      await waitFor(() => expect(calls.some((c) => c.call === "POST /api/bookings")).toBe(true));
      expect(calls.find((c) => c.call === "POST /api/bookings")!.body).toMatchObject({
        controls: ["kb", "pad"],
        picture: "120fps",
      });
    });

    for (const [why, answer] of [
      ["refused", () => new Response(JSON.stringify({ status: "expired" }), { status: 409 })],
      [
        "unanswered",
        () => {
          throw new TypeError("network down");
        },
      ],
    ] as const) {
      it(`stops the launch, and says so, when the picked host's claim is ${why}`, async () => {
        const calls = serve(unnamed, LIVE, {
          "POST /api/bookings": json(202, booked("matched", 1_000)),
          "POST /api/bookings/b-1/claim": answer,
          "POST /api/bookings/b-1/end": json(200, booked("ended")),
        });
        const opened = streams();
        const result = await openLive();
        act(() => result.current.launch());
        expect(result.current.phase).toBe("connecting");

        await waitFor(() => expect(result.current.bookingFailed).toBe(true));
        expect(result.current.phase).toBe("idle");
        expect(result.current.claim).toBeNull();
        expect(result.current.booking).toBeNull();
        await waitFor(() => expect(calls.map((c) => c.call)).toContain("POST /api/bookings/b-1/end"));
        render(createElement(GameMenu, { swiff: result.current }));
        expect(screen.getByRole("alert").textContent).toBe("That didn't go through. Try again.");
        expect(screen.queryByText(/A machine is free for you/)).toBeNull();

        // Nothing launches by itself afterwards.
        const claims = calls.filter((c) => c.call === "POST /api/bookings/b-1/claim").length;
        act(() => opened.find((o) => o.url === "/api/events?booking=b-1")?.push(booked("matched", 2_000)));
        expect(calls.filter((c) => c.call === "POST /api/bookings/b-1/claim")).toHaveLength(claims);
        expect(result.current.phase).toBe("idle");
      });
    }

    it("offers the next best from the list when the picked host was taken, and launches on it", async () => {
      const nextBest = { id: "h2", name: "Attic box", gpu: "RTX 3080", price: 300, latency: { rttMs: 20 } };
      let taken = true;
      const calls = serve(unnamed, LIVE, {
        "POST /api/bookings": () =>
          taken
            ? new Response(JSON.stringify({ error: "the machine is taken", nextBest }), { status: 409 })
            : new Response(JSON.stringify(booked("matched", 1_000)), { status: 202 }),
        "POST /api/bookings/b-1/claim": json(200, TICKET),
      });
      streams();
      const result = await openLive();

      act(() => result.current.launch());
      await waitFor(() => expect(result.current.taken).toEqual({ nextBest }));
      expect(result.current.phase).toBe("idle");

      taken = false;
      act(() => result.current.launchNextBest());
      await waitFor(() => expect(result.current.claim).toEqual(TICKET));
      expect(calls.filter((c) => c.call === "POST /api/bookings").at(-1)!.body).toMatchObject({
        machineId: "h2",
      });
      // The next best is on the list, so the launch stays on a picked machine.
      expect(result.current.picked?.id).toBe("h2");
      expect(result.current.taken).toBeNull();
    });

    it("queues with the measured round trip, and claims the match the stream pushes", async () => {
      const calls = serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("queued")),
        "POST /api/bookings/b-1/claim": json(200, TICKET),
      });
      const opened = streams();
      const result = await openLive();

      act(() => result.current.joinQueue());
      await waitFor(() => expect(opened.some((o) => o.url === "/api/events?booking=b-1")).toBe(true));
      const stream = opened.find((o) => o.url === "/api/events?booking=b-1")!;
      const body = calls.find((c) => c.call === "POST /api/bookings")!.body as Record<string, unknown>;
      expect(body).toEqual({
        gameId: cs2.appid,
        minutes: 180,
        rtts: { server: expect.any(Number) },
        controls: ["kb", "mouse", "pad"],
        picture: "best",
      });
      act(() => stream.push(booked("queued")));
      expect(result.current.booking?.status).toBe("queued");
      expect(result.current.phase).toBe("idle");

      act(() => stream.push(booked("matched", 1_000)));
      await waitFor(() => expect(result.current.claim).toEqual(TICKET));
      expect(result.current.phase).toBe("connecting");
      expect(result.current.screen).toBe("game");
    });

    it("clears a refused claim's note once the next match is claimed", async () => {
      let answers = 0;
      serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("queued")),
        "POST /api/bookings/b-1/claim": () =>
          ++answers === 1
            ? new Response(JSON.stringify({ status: "queued" }), { status: 409 })
            : new Response(JSON.stringify(TICKET), { status: 200 }),
      });
      const opened = streams();
      const result = await openLive();
      act(() => result.current.joinQueue());
      await waitFor(() => expect(opened.some((o) => o.url === "/api/events?booking=b-1")).toBe(true));
      const stream = opened.find((o) => o.url === "/api/events?booking=b-1")!;

      act(() => stream.push(booked("matched", 1_000)));
      await waitFor(() => expect(result.current.bookingFailed).toBe(true));
      act(() => stream.push(booked("matched", 2_000)));
      await waitFor(() => expect(result.current.claim).toEqual(TICKET));
      expect(result.current.bookingFailed).toBe(false);
    });

    it("shows the failure note once a queued match's claim is lost for good", async () => {
      serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("queued")),
        "POST /api/bookings/b-1/claim": () => {
          throw new TypeError("network down");
        },
      });
      const opened = streams();
      const result = await openLive();
      act(() => result.current.joinQueue());
      await waitFor(() => expect(opened.some((o) => o.url === "/api/events?booking=b-1")).toBe(true));
      const stream = opened.find((o) => o.url === "/api/events?booking=b-1")!;

      act(() => stream.push(booked("matched", Date.now() + 500)));
      await waitFor(() => expect(result.current.bookingFailed).toBe(true));
      render(createElement(GameMenu, { swiff: result.current }));
      expect(screen.getByRole("alert").textContent).toBe("That didn't go through. Try again.");
      expect(screen.queryByText(/A machine is free for you/)).toBeNull();
    });

    it("says in plain words when the server refuses a game the renter does not own", async () => {
      serve(unnamed, LIVE, {
        "POST /api/bookings": json(403, { error: "not in your library", code: "not-owned" }),
      });
      streams();
      const result = await openLive();
      act(() => result.current.launch());

      await waitFor(() => expect(result.current.refusal).toBe("not-owned"));
      expect(result.current.bookingFailed).toBe(true);
      expect(result.current.phase).toBe("idle");
      expect(result.current.booking).toBeNull();
      render(createElement(GameMenu, { swiff: result.current }));
      expect(screen.getByRole("alert").textContent).toMatch(/You don't own this game on Steam/);

      // Opening a game again starts with a clean note.
      act(() => result.current.openGame(result.current.game!));
      expect(result.current.refusal).toBeNull();
    });

    it("hands a queued match back when the server refuses its claim, and says why", async () => {
      const calls = serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("queued")),
        "POST /api/bookings/b-1/claim": json(403, { error: "cannot read", code: "library-unreadable" }),
        "POST /api/bookings/b-1/end": json(200, booked("ended")),
      });
      const opened = streams();
      const result = await openLive();
      act(() => result.current.joinQueue());
      await waitFor(() => expect(opened.some((o) => o.url === "/api/events?booking=b-1")).toBe(true));
      const stream = opened.find((o) => o.url === "/api/events?booking=b-1")!;

      act(() => stream.push(booked("matched", 1_000)));
      await waitFor(() => expect(result.current.refusal).toBe("library-unreadable"));
      await waitFor(() => expect(calls.map((c) => c.call)).toContain("POST /api/bookings/b-1/end"));
      expect(result.current.booking).toBeNull();
      render(createElement(GameMenu, { swiff: result.current }));
      expect(screen.getByRole("alert").textContent).toMatch(/We can't see your Steam library/);
    });

    it("books the queue once for a double click", async () => {
      const calls = serve(unnamed, LIVE, { "POST /api/bookings": json(202, booked("queued")) });
      streams();
      const result = await openLive();

      act(() => {
        result.current.joinQueue();
        result.current.joinQueue();
      });
      await waitFor(() => expect(result.current.booking?.status).toBe("queued"));
      expect(calls.filter((c) => c.call === "POST /api/bookings")).toHaveLength(1);
    });

    it("joins the queue again once the followed booking has expired", async () => {
      const calls = serve(unnamed, LIVE, { "POST /api/bookings": json(202, booked("queued")) });
      const opened = streams();
      const result = await openLive();
      act(() => result.current.joinQueue());
      await waitFor(() => expect(opened.some((o) => o.url === "/api/events?booking=b-1")).toBe(true));
      const stream = opened.find((o) => o.url === "/api/events?booking=b-1")!;

      act(() => stream.push(booked("expired")));
      expect(result.current.booking?.status).toBe("expired");
      act(() => result.current.joinQueue());
      await waitFor(() => expect(calls.filter((c) => c.call === "POST /api/bookings")).toHaveLength(2));
    });

    it("tells the server when the renter leaves the queue", async () => {
      const calls = serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("queued")),
        "POST /api/bookings/b-1/end": json(200, booked("ended")),
      });
      streams();
      const result = await openLive();

      act(() => result.current.joinQueue());
      await waitFor(() => expect(result.current.booking?.status).toBe("queued"));
      act(() => result.current.leaveQueue());
      await waitFor(() => expect(calls.map((c) => c.call)).toContain("POST /api/bookings/b-1/end"));
      expect(result.current.booking).toBeNull();
    });

    it("picks up a booking kept from before, and claims its match once the stream is open", async () => {
      localStorage.setItem("swiff.booking", "b-1");
      serve(unnamed, LIVE, { "POST /api/bookings/b-1/claim": json(200, TICKET) });
      const opened = streams();
      const { result } = renderHook(() => useSwiff({ demo: false }));
      await waitFor(() => expect(opened.some((o) => o.url === "/api/events?booking=b-1")).toBe(true));

      act(() => opened.find((o) => o.url === "/api/events?booking=b-1")!.push(booked("matched", 1_000)));
      await waitFor(() => expect(result.current.claim).toEqual(TICKET));
      expect(result.current.game?.appid).toBe(cs2.appid);
      expect(result.current.phase).toBe("connecting");
    });
  });

  describe("coming back to a game", () => {
    const AGAIN = { ...TICKET, ticket: "t-again" };
    const keepPlaying = () =>
      localStorage.setItem(
        "swiff.play",
        JSON.stringify({ bookingId: "b-1", sessionId: "s-1", roomId: "pc-1" }),
      );
    const playing = (heldUntil?: number, startedAt?: number) => ({
      ...booked("playing"),
      machine: { id: "h1", name: "Glasshouse", gpu: null, cpu: null, price: 0 },
      sessionId: "s-1",
      ...(heldUntil === undefined ? {} : { heldUntil }),
      ...(startedAt === undefined ? {} : { startedAt }),
    });

    it("offers the session the page left, held by its PC, and goes straight back to the game", async () => {
      keepPlaying();
      const heldUntil = Date.now() + 100_000;
      const startedAt = Date.now() - 30 * 60_000;
      const calls = serve(unnamed, LIVE, {
        "GET /api/bookings/b-1": json(200, playing(heldUntil, startedAt)),
        "POST /api/bookings/b-1/rejoin": json(200, AGAIN),
        "POST /api/sessions/s-1/start": json(200, { sessionId: "s-1", roomId: "pc-1" }),
      });
      const { result } = renderHook(() => useSwiff({ demo: false }));
      await waitFor(() => expect(result.current.away).not.toBeNull());
      expect(result.current.away!.heldUntil).toBeGreaterThan(Date.now());

      act(() => result.current.reconnect());
      await waitFor(() => expect(result.current.claim).toEqual(AGAIN));
      expect(calls.map((c) => c.call)).toContain("POST /api/bookings/b-1/rejoin");
      expect(result.current.away).toBeNull();
      expect(result.current.phase).toBe("live");
      expect(result.current.game?.appid).toBe(cs2.appid);
      // The session clock runs on from when the session started.
      expect(result.current.elapsedMs).toBeGreaterThanOrEqual(30 * 60_000);
      // The ticket stays in memory only.
      expect(localStorage.getItem("swiff.play")).not.toContain("t-again");

      act(() => result.current.attachVideo(document.createElement("video")));
      const session = rtc.sessions[0]!;
      expect(session.options).toMatchObject({ ticket: "t-again" });
      expect(result.current.play?.lostAt).not.toBeNull();
      // The PC's hold counts down from when it missed the renter, not from the reconnect.
      expect(result.current.play?.droppedAt).toBe(heldUntil - RECONNECT_GRACE_MS);
      act(() => session.emit({ type: "first-frame" }));
      act(() => session.emit({ type: "game-started" }));
      expect(result.current.play?.lostAt).toBeNull();
      expect(result.current.phase).toBe("live");
    });

    it("does not offer a session another open page still plays, and does once that page is gone", async () => {
      keepPlaying();
      const { manager } = locks();
      const otherPage = holdPlay("s-1", manager);
      const calls = serve(unnamed, LIVE, { "GET /api/bookings/b-1": json(200, playing()) });
      const first = renderHook(() => useSwiff({ demo: false }));
      await waitFor(() => expect(calls.map((c) => c.call)).toContain("GET /api/bookings/b-1"));
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(first.result.current.away).toBeNull();
      expect(storedPlay()).not.toBeNull();
      first.unmount();

      otherPage();
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
      const { result } = renderHook(() => useSwiff({ demo: false }));
      await waitFor(() => expect(result.current.away).not.toBeNull());
    });

    it("does not take the seat of a page that went back to the session meanwhile", async () => {
      keepPlaying();
      const { manager } = locks();
      const calls = serve(unnamed, LIVE, {
        "GET /api/bookings/b-1": json(200, playing()),
        "POST /api/bookings/b-1/rejoin": json(200, AGAIN),
      });
      const { result } = renderHook(() => useSwiff({ demo: false }));
      await waitFor(() => expect(result.current.away).not.toBeNull());

      holdPlay("s-1", manager);
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
      act(() => result.current.reconnect());
      await waitFor(() => expect(result.current.away).toBeNull());
      expect(calls.map((c) => c.call)).not.toContain("POST /api/bookings/b-1/rejoin");
      expect(result.current.claim).toBeNull();
    });

    it("lets the session go to the page that took its seat, without ending it", async () => {
      const { held } = locks();
      const calls = serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, { ...booked("matched", 1_000), machine: { id: "h1" } }),
        "POST /api/bookings/b-1/claim": json(200, TICKET),
        "POST /api/sessions/s-1/start": json(200, { sessionId: "s-1", roomId: "pc-1" }),
      });
      streams();
      const result = await openLive();
      act(() => result.current.launch());
      await waitFor(() => expect(result.current.claim).toEqual(TICKET));
      await waitFor(() => expect(held.has("swiff.play.s-1")).toBe(true));
      act(() => result.current.attachVideo(document.createElement("video")));
      act(() => rtc.sessions[0]!.emit({ type: "first-frame" }));
      act(() => rtc.sessions[0]!.emit({ type: "game-started" }));
      expect(result.current.phase).toBe("live");

      act(() => rtc.sessions[0]!.emit({ type: "denied", reason: "replaced" }));
      expect(result.current.claim).toBeNull();
      expect(result.current.phase).toBe("idle");
      expect(rtc.sessions[0]!.ended).toBe(true);
      await waitFor(() => expect(held.has("swiff.play.s-1")).toBe(false));
      expect(calls.map((c) => c.call)).not.toContain("POST /api/bookings/b-1/end");
      expect(storedPlay()).toEqual({ bookingId: "b-1", sessionId: "s-1", roomId: "pc-1" });
      expect(rtc.sessions).toHaveLength(1);
    });

    it("lets the left session go when the renter ends it from there", async () => {
      keepPlaying();
      const calls = serve(unnamed, LIVE, {
        "GET /api/bookings/b-1": json(200, playing()),
        "POST /api/bookings/b-1/end": json(200, booked("ended")),
      });
      const { result } = renderHook(() => useSwiff({ demo: false }));
      await waitFor(() => expect(result.current.away?.heldUntil).toBeNull());
      act(() => result.current.endAway());
      expect(result.current.away).toBeNull();
      await waitFor(() => expect(calls.map((c) => c.call)).toContain("POST /api/bookings/b-1/end"));
      expect(storedPlay()).toBeNull();
    });

    it("forgets a session that is over by the time the page is back, and offers nothing", async () => {
      keepPlaying();
      const calls = serve(unnamed, LIVE, { "GET /api/bookings/b-1": json(200, booked("ended")) });
      const { result } = renderHook(() => useSwiff({ demo: false }));
      await waitFor(() => expect(calls.map((c) => c.call)).toContain("GET /api/bookings/b-1"));
      await waitFor(() => expect(storedPlay()).toBeNull());
      expect(result.current.away).toBeNull();
    });

    it("says the queue kept the renter's place, and claims a match by itself all the same", async () => {
      localStorage.setItem("swiff.booking", "b-1");
      serve(unnamed, LIVE, { "POST /api/bookings/b-1/claim": json(200, TICKET) });
      const opened = streams();
      const { result } = renderHook(() => useSwiff({ demo: false }));
      await waitFor(() => expect(result.current.queueBack).toBe(true));
      await waitFor(() => expect(opened.some((o) => o.url === "/api/events?booking=b-1")).toBe(true));
      const stream = opened.find((o) => o.url === "/api/events?booking=b-1")!;

      act(() => stream.push(booked("queued")));
      expect(result.current.queueBack).toBe(true);
      act(() => stream.push(booked("matched", 1_000)));
      await waitFor(() => expect(result.current.claim).toEqual(TICKET));
      expect(result.current.queueBack).toBe(false);
    });

    it("puts the reconnect up when the connection drops mid-session, and retries on the renter's word", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        serve(unnamed, LIVE, {
          "POST /api/bookings": json(202, { ...booked("matched", 1_000), machine: { id: "h1" } }),
          "POST /api/bookings/b-1/claim": json(200, TICKET),
          "POST /api/sessions/s-1/start": json(200, { sessionId: "s-1", roomId: "pc-1" }),
        });
        streams();
        const result = await openLive();
        act(() => result.current.launch());
        await waitFor(() => expect(result.current.claim).toEqual(TICKET));
        act(() => result.current.attachVideo(document.createElement("video")));
        act(() => rtc.sessions[0]!.emit({ type: "first-frame" }));
        act(() => rtc.sessions[0]!.emit({ type: "game-started" }));
        expect(result.current.phase).toBe("live");

        act(() => rtc.sessions[0]!.emit({ type: "disconnected", failed: false }));
        expect(result.current.play?.lostAt).not.toBeNull();
        expect(result.current.phase).toBe("live");
        await act(() => vi.advanceTimersByTimeAsync(15_000));
        expect(result.current.play?.gaveUp).toBe(true);
        const joins = rtc.sessions.length;
        act(() => result.current.retryConnection());
        expect(rtc.sessions).toHaveLength(joins + 1);
        expect(result.current.play?.gaveUp).toBe(false);
        expect(result.current.phase).toBe("live");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
