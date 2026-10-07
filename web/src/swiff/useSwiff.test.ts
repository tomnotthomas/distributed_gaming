import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { RenterSessionEvent, RenterSessionOptions } from "@swiff/rtc";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdPlay, storedPlay } from "./booking";
import { GAMES } from "./data";
import { RECONNECT_GRACE_MS, WAKE_TIMEOUT_MS } from "./play";
import { GameMenu } from "./GameMenu";
import type { GameAvailability, GameMachines } from "./live";
import { libraryState, type Renter } from "./steam";
import { Swiff } from "./Swiff";
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
    retries: number;
  }[],
}));
vi.mock("@swiff/rtc", () => ({
  startRenterSession: (options: RenterSessionOptions) => {
    const listeners = new Set<(event: RenterSessionEvent) => void>();
    const session = {
      options,
      ended: false,
      retries: 0,
      emit: (event: RenterSessionEvent) => listeners.forEach((fn) => fn(event)),
    };
    rtc.sessions.push(session);
    return {
      on: (listener: (event: RenterSessionEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      stats: () => null,
      retrySteamLogin: () => {
        session.retries += 1;
      },
      end: () => {
        session.ended = true;
      },
    };
  },
  // Nobody watches in these tests: a crew hub that does nothing.
  startCrewHub: () => ({
    attach: () => {},
    message: () => {},
    source: () => {},
    setLive: () => {},
    end: () => {},
    state: () => ({ sharing: false, crew: null, crews: [], watchers: [], voice: {} }),
  }),
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
 * The server: /api/me answers `renter` (401 when null), /api/ping answers, the
 * availability reads answer from `hosts` for a signed-in renter (401 signed
 * out), each "METHOD path" in `booking` answers as it says, and every catalog
 * read comes back empty but for the wall's two free-to-play games, which the
 * popular read says Swiff can run. Returns every call made, with its JSON body.
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
      if (url.pathname === "/api/me")
        return renter ? json(renter) : json({ error: "sign in with Steam first" }, 401);
      if (url.pathname === "/api/ping") return new Response(null, { status: 204 });
      if (url.pathname === "/api/games/popular")
        return json({ games: [], wall: [{ appid: 730 }, { appid: 2073850 }] });
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

const TICKET = {
  sessionId: "s-1",
  roomId: "pc-1",
  signalingUrl: "ws://localhost",
  ticket: "t",
  rentalMode: false,
};

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
  // The server vouches for Counter-Strike 2 once its popular read is in.
  await waitFor(() => expect(result.current.games.some((g) => g.appid === cs2.appid)).toBe(true));
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

  it("celebrates a crew's first PC on the next visit of a player who was away, until they close it", async () => {
    const crew = { memberId: "m", name: "Lena", crewName: null, own: false, size: 2 };
    serve(
      unnamed,
      {},
      {
        "GET /api/crews": json(200, {
          crews: [
            { ...crew, id: "c0", state: "ready", pcs: 1, pcArrived: false },
            { ...crew, id: "c1", state: "ready", pcs: 1, pcArrived: true },
          ],
        }),
      },
    );
    const first = renderHook(() => useSwiff({ demo: false }));
    await waitFor(() => expect(first.result.current.crewReady).toBe("c1"));
    act(() => first.result.current.dismissCrewReady());
    expect(first.result.current.crewReady).toBeNull();
    first.unmount();

    const next = renderHook(() => useSwiff({ demo: false }));
    await waitFor(() => expect(next.result.current.signedIn).toBe(true));
    await act(async () => {});
    expect(next.result.current.crewReady).toBeNull();
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

    describe("shows only games the server says Swiff can run", () => {
      const appidsOf = (games: { appid: number }[]) => games.map((g) => g.appid).sort((a, b) => a - b);
      const chart = { appid: 292030, name: "The Witcher 3", free: false, art: { hero: null, capsule: null } };

      it("shows a signed-out visitor nothing until the server answers, then the chart it sent", async () => {
        serve(null, {}, { "GET /api/games/popular": json(200, { games: [chart], wall: [{ appid: 730 }] }) });
        const { result } = renderHook(() => useSwiff({ demo: false }));
        expect(result.current.games).toEqual([]);
        await waitFor(() => expect(appidsOf(result.current.games)).toEqual([292030]));
      });

      it("stands in only the hand-authored games it vouches for when the chart is empty", async () => {
        serve(null);
        const { result } = renderHook(() => useSwiff({ demo: false }));
        await waitFor(() => expect(result.current.games.map((g) => g.appid).sort()).toEqual([2073850, 730]));
      });

      it("names the launcher account on a hand-authored game standing in for the chart", async () => {
        const psn = { launcher: "psn", name: "PlayStation Network" };
        serve(
          null,
          {},
          {
            "GET /api/games/popular": json(200, {
              games: [],
              wall: [{ appid: 730, requiresAccount: psn }, { appid: 2073850 }],
            }),
          },
        );
        const { result } = renderHook(() => useSwiff({ demo: false }));
        await waitFor(() => expect(result.current.games.map((g) => g.appid).sort()).toEqual([2073850, 730]));
        const signIn = (appid: number) => result.current.games.find((g) => g.appid === appid)?.signIn;
        expect(signIn(730)).toBe("Needs your PlayStation Network sign-in");
        expect(signIn(2073850)).toBeUndefined();
      });

      it("shows nothing it has not heard about from the server", async () => {
        serve(null, {}, { "GET /api/games/popular": json(503, {}) });
        const { result } = renderHook(() => useSwiff({ demo: false }));
        await waitFor(() => expect(fetched()).toContain("/api/games/popular"));
        await act(() => Promise.resolve());
        expect(result.current.games).toEqual([]);
      });

      it("keeps the hand-authored nine in the demo", async () => {
        serve(null, {}, { "GET /api/games/popular": json(503, {}) });
        const { result } = renderHook(() => useSwiff({ demo: true }));
        await waitFor(() => expect(fetched()).toContain("/api/games/popular"));
        expect(result.current.games).toHaveLength(GAMES.length);
      });

      it("leaves a free-to-play game it does not vouch for off a signed-in renter's wall", async () => {
        serve(
          unnamed,
          {},
          { "GET /api/games/popular": json(200, { games: [], wall: [{ appid: 2073850 }] }) },
        );
        const { result } = renderHook(() => useSwiff({ demo: false }));
        await waitFor(() => expect(appidsOf(result.current.games)).toEqual([2073850]));
      });
    });

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
      // The server vouches for Counter-Strike 2 once its popular read is in.
      await waitFor(() => expect(result.current.games.some((g) => g.appid === cs2.appid)).toBe(true));
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

    it("reads the renter's profile again while their games are being checked, and stops once they are", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let checked = false;
      const me = () =>
        new Response(
          JSON.stringify({
            steamId: unnamed.steamId,
            profile: checked
              ? { ...unnamed.profile, lib: true, games: [[440, "Team Fortress 2", 3]], checking: 0 }
              : { ...unnamed.profile, lib: true, checking: 1 },
          }),
        );
      serve(unnamed, {}, { "GET /api/me": me });
      const reads = () => fetched().filter((p) => p === "/api/me").length;
      try {
        const { result } = renderHook(() => useSwiff({ demo: false }));
        await waitFor(() => expect(result.current.profile).not.toBeNull());
        expect(libraryState(result.current.profile!)).toBe("checking");

        await act(() => vi.advanceTimersByTimeAsync(5_000));
        await waitFor(() => expect(reads()).toBe(2));
        expect(libraryState(result.current.profile!)).toBe("checking");

        checked = true;
        await act(() => vi.advanceTimersByTimeAsync(5_000));
        await waitFor(() => expect(libraryState(result.current.profile!)).toBe("ok"));
        expect(result.current.games.some((g) => g.appid === 440)).toBe(true);
        await act(() => vi.advanceTimersByTimeAsync(20_000));
        expect(reads()).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps reading the renter's profile, slower, past five minutes of checking, until the checks finish", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let checked = false;
      const me = () =>
        new Response(
          JSON.stringify({
            steamId: unnamed.steamId,
            profile: checked
              ? { ...unnamed.profile, lib: true, size: 3, checking: 0 }
              : { ...unnamed.profile, lib: true, size: 3, checking: 1 },
          }),
        );
      serve(unnamed, {}, { "GET /api/me": me });
      const reads = () => fetched().filter((p) => p === "/api/me").length;
      try {
        const { result } = renderHook(() => useSwiff({ demo: false }));
        await waitFor(() => expect(result.current.profile).not.toBeNull());
        for (let read = 2; read <= 61; read++) {
          await act(() => vi.advanceTimersByTimeAsync(5_000));
          await waitFor(() => expect(reads()).toBe(read));
        }
        await act(() => vi.advanceTimersByTimeAsync(5_000));
        expect(reads()).toBe(61);
        expect(libraryState(result.current.profile!)).toBe("checking");

        await act(() => vi.advanceTimersByTimeAsync(25_000));
        await waitFor(() => expect(reads()).toBe(62));
        expect(libraryState(result.current.profile!)).toBe("checking");

        checked = true;
        await act(() => vi.advanceTimersByTimeAsync(30_000));
        await waitFor(() => expect(libraryState(result.current.profile!)).toBe("none"));
        await act(() => vi.advanceTimersByTimeAsync(60_000));
        expect(reads()).toBe(63);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops reading the profile, and shows the signed-out wall, once the server no longer signs the renter in", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let answer: "checking" | "offline" | "signed-out" = "checking";
      const me = () => {
        if (answer === "offline") return new Response("{}", { status: 503 });
        if (answer === "signed-out") return new Response("{}", { status: 401 });
        const profile = { ...unnamed.profile, lib: true, size: 3, checking: 1 };
        return new Response(JSON.stringify({ steamId: unnamed.steamId, profile }));
      };
      serve(unnamed, {}, { "GET /api/me": me });
      const reads = () => fetched().filter((p) => p === "/api/me").length;
      try {
        const { result } = renderHook(() => useSwiff({ demo: false }));
        await waitFor(() => expect(result.current.signedIn).toBe(true));

        answer = "offline";
        await act(() => vi.advanceTimersByTimeAsync(5_000));
        await waitFor(() => expect(reads()).toBe(2));
        expect(result.current.signedIn).toBe(true);

        answer = "signed-out";
        await act(() => vi.advanceTimersByTimeAsync(5_000));
        await waitFor(() => expect(result.current.signedIn).toBe(false));
        expect(result.current.profile).toBeNull();
        await waitFor(() => expect(result.current.games.map((g) => g.appid).sort()).toEqual([2073850, 730]));
        await act(() => vi.advanceTimersByTimeAsync(60_000));
        expect(reads()).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never puts the renter's games back once signed out, when a store read for them answers late", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let answer: "checking" | "found" | "signed-out" = "checking";
      const me = () => {
        if (answer === "signed-out") return new Response("{}", { status: 401 });
        const games = answer === "found" ? [[440, "Team Fortress 2", 3]] : [];
        const profile = { ...unnamed.profile, lib: true, size: 3, games, checking: 1 };
        return new Response(JSON.stringify({ steamId: unnamed.steamId, profile }));
      };
      serve(unnamed, {}, { "GET /api/me": me });
      // The store read for Team Fortress 2's card answers only once released.
      let release = () => {};
      const late = new Promise<void>((resolve) => (release = resolve));
      const server = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (path, init) => {
        if (String(path).startsWith("/api/games/media") && String(path).includes("440")) await late;
        return server(path, init);
      });
      try {
        const { result } = renderHook(() => useSwiff({ demo: false }));
        await waitFor(() => expect(result.current.signedIn).toBe(true));

        answer = "found";
        await act(() => vi.advanceTimersByTimeAsync(5_000));
        await waitFor(() => expect(result.current.games.some((g) => g.appid === 440)).toBe(true));

        answer = "signed-out";
        await act(() => vi.advanceTimersByTimeAsync(5_000));
        await waitFor(() => expect(result.current.signedIn).toBe(false));
        await waitFor(() => expect(result.current.games.map((g) => g.appid).sort()).toEqual([2073850, 730]));

        release();
        await act(() => vi.advanceTimersByTimeAsync(1_000));
        expect(result.current.games.map((g) => g.appid).sort()).toEqual([2073850, 730]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves none of the renter's games on the wall once signed out, even when the popular read fails", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let signedOut = false;
      const me = () => {
        if (signedOut) return new Response("{}", { status: 401 });
        const profile = {
          ...unnamed.profile,
          lib: true,
          size: 3,
          games: [[440, "Team Fortress 2", 3]],
          checking: 1,
        };
        return new Response(JSON.stringify({ steamId: unnamed.steamId, profile }));
      };
      serve(unnamed, {}, { "GET /api/me": me });
      const server = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (path, init) =>
        signedOut && String(path) === "/api/games/popular"
          ? new Response("{}", { status: 503 })
          : server(path, init),
      );
      try {
        const { result } = renderHook(() => useSwiff({ demo: false }));
        await waitFor(() => expect(result.current.games.some((g) => g.appid === 440)).toBe(true));

        signedOut = true;
        await act(() => vi.advanceTimersByTimeAsync(5_000));
        await waitFor(() => expect(result.current.signedIn).toBe(false));
        await act(() => vi.advanceTimersByTimeAsync(1_000));
        expect(result.current.profile).toBeNull();
        expect(result.current.games).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the game of a launch under way when the renter is signed out, and nothing else", async () => {
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
      let signedOut = false;
      const me = () => {
        if (signedOut) return new Response("{}", { status: 401 });
        const profile = {
          ...unnamed.profile,
          lib: true,
          size: 3,
          games: [[440, "Team Fortress 2", 3]],
          checking: 1,
        };
        return new Response(JSON.stringify({ steamId: unnamed.steamId, profile }));
      };
      serve(
        unnamed,
        { machines: () => ({ ...NO_MACHINES, machines: [host] }) },
        {
          "GET /api/me": me,
          "POST /api/bookings": json(202, { ...booked("matched", 1_000), machine: { id: "h1" } }),
          "POST /api/bookings/b-1/claim": json(200, TICKET),
        },
      );
      const server = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (path, init) =>
        signedOut && String(path) === "/api/games/popular"
          ? new Response("{}", { status: 503 })
          : server(path, init),
      );
      try {
        const { result } = renderHook(() => useSwiff({ demo: false }));
        await waitFor(() => expect(result.current.games.some((g) => g.appid === cs2.appid)).toBe(true));
        expect(result.current.games.some((g) => g.appid === 440)).toBe(true);
        const game = result.current.games.find((g) => g.appid === cs2.appid)!;
        act(() => result.current.openGame(game));
        await waitFor(() => expect(result.current.picked?.id).toBe("h1"));
        act(() => result.current.launch());
        expect(result.current.phase).not.toBe("idle");

        signedOut = true;
        await act(() => vi.advanceTimersByTimeAsync(5_000));
        await waitFor(() => expect(result.current.signedIn).toBe(false));
        await act(() => vi.advanceTimersByTimeAsync(1_000));
        expect(result.current.games.map((g) => g.appid)).toEqual([cs2.appid]);
        expect(result.current.game?.appid).toBe(cs2.appid);
      } finally {
        vi.useRealTimers();
      }
    });

    it("sends a renter on a game's page with no launch started back to the signed-out wall when signed out", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let signedOut = false;
      const me = () => {
        if (signedOut) return new Response("{}", { status: 401 });
        const profile = {
          ...unnamed.profile,
          lib: true,
          size: 3,
          games: [[440, "Team Fortress 2", 3]],
          checking: 1,
        };
        return new Response(JSON.stringify({ steamId: unnamed.steamId, profile }));
      };
      serve(unnamed, {}, { "GET /api/me": me });
      try {
        const { result } = renderHook(() => useSwiff({ demo: false }));
        await waitFor(() => expect(result.current.games.some((g) => g.appid === 440)).toBe(true));
        act(() => result.current.openGame(result.current.games.find((g) => g.appid === 440)!));
        expect(result.current.screen).toBe("game");

        signedOut = true;
        await act(() => vi.advanceTimersByTimeAsync(5_000));
        await waitFor(() => expect(result.current.signedIn).toBe(false));
        await waitFor(() => expect(result.current.games.map((g) => g.appid).sort()).toEqual([2073850, 730]));
        expect(result.current.phase).toBe("idle");
        expect(result.current.screen).toBe("home");
      } finally {
        vi.useRealTimers();
      }
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
        // The server vouches for Counter-Strike 2 once its popular read is in.
        await waitFor(() => expect(result.current.games.some((g) => g.appid === cs2.appid)).toBe(true));
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

    it("shows a rental-mode PC's Steam code, retries a failed sign-in on the same claim, and is live only once the game runs", async () => {
      const calls = serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, { ...booked("matched", 1_000), machine: { id: "h1" } }),
        "POST /api/bookings/b-1/claim": json(200, TICKET),
        "POST /api/sessions/s-1/start": json(200, { sessionId: "s-1", roomId: "pc-1" }),
      });
      streams();
      const result = await openLive();
      act(() => result.current.launch());
      await waitFor(() => expect(result.current.claim).toEqual(TICKET));
      act(() => result.current.attachVideo(document.createElement("video")));
      const session = rtc.sessions[0]!;
      const QR = { type: "steam-login", state: "qr", url: "https://s.team/q/1/42" } as const;

      act(() => session.emit(QR));
      expect(result.current.steamLogin).toEqual(QR);
      act(() => session.emit({ type: "connected" }));
      act(() => session.emit({ type: "first-frame" }));
      act(() => session.emit({ type: "steam-login", state: "failed" }));
      expect(result.current.steamSignInFailed).toBe("sign-in-timeout");
      expect(result.current.steamLogin).toBeNull();

      act(() => result.current.retrySignIn());
      // The same PC is asked for a new code: the booking is neither ended nor made again.
      expect(session.retries).toBe(1);
      expect(rtc.sessions).toHaveLength(1);
      expect(result.current.steamSignInFailed).toBeNull();
      expect(calls.map((c) => c.call).filter((c) => c.startsWith("POST /api/bookings"))).toEqual([
        "POST /api/bookings",
        "POST /api/bookings/b-1/claim",
      ]);

      act(() => session.emit({ ...QR, url: "https://s.team/q/1/43" }));
      act(() => session.emit({ type: "steam-login", state: "signed-in" }));
      expect(result.current.phase).toBe("connecting");
      act(() => session.emit({ type: "game-started" }));
      expect(result.current.phase).toBe("live");
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
      await waitFor(() => expect(result.current.phase).toBe("idle"));
      expect(result.current.bookingFailed).toBe(false);
      expect(result.current.lost).toBeNull();
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
      await waitFor(() => expect(result.current.claim).toEqual(TICKET), { timeout: 3_000 });
      act(() => result.current.attachVideo(document.createElement("video")));
      track.mockClear();

      act(() => rtc.sessions[0]!.emit({ type: "denied", reason: "bad-ticket" }));
      // A denied ticket reads the booking first, to tell a lost machine from any other end.
      await waitFor(() => expect(result.current.phase).toBe("idle"), { timeout: 3_000 });
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

        // The page reads the booking first, to tell a lost machine from any other end.
        act(() => session.emit({ type: "denied", reason: "bad-ticket" }));
        await waitFor(() => expect(result.current.phase).toBe("idle"));
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
      await waitFor(() => expect(result.current.games.some((g) => g.appid === cs2.appid)).toBe(true));

      act(() => opened.find((o) => o.url === "/api/events?booking=b-1")!.push(booked("matched", 1_000)));
      await waitFor(() => expect(result.current.claim).toEqual(TICKET));
      expect(result.current.game?.appid).toBe(cs2.appid);
      expect(result.current.phase).toBe("connecting");
    });
  });

  describe("a machine lost mid-session", () => {
    const LOST_ON = { id: "h1", name: "Basement rig", gpu: null, cpu: null, price: 100 };
    const NEXT_ON = { id: "h2", name: "Attic box", gpu: null, cpu: null, price: 100 };
    const NEXT_TICKET = { ...TICKET, sessionId: "s-2", roomId: "h2", ticket: "t-2" };
    /** b-1 ended because its machine was lost: gone offline, or `endReason`. */
    const ended = (endReason = "host_offline") => ({ ...booked("ended"), machine: LOST_ON, endReason });
    /** b-2, carrying it on: matched to h2, or `status`. */
    const carried = (status = "matched") => ({
      ...booked(status, status === "matched" ? 1_000 : undefined),
      bookingId: "b-2",
      minutes: 150,
      ...(status === "matched" ? { machine: NEXT_ON } : {}),
    });

    /** The renter playing Counter-Strike 2 live on h1, booked as b-1, with the server answering `answers` too. */
    async function playing(answers: Record<string, () => Response> = {}) {
      const calls = serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, { ...booked("matched", 1_000), machine: LOST_ON }),
        "POST /api/bookings/b-1/claim": json(200, TICKET),
        "POST /api/sessions/s-1/start": json(200, { sessionId: "s-1", roomId: "pc-1" }),
        ...answers,
      });
      const opened = streams();
      const result = await openLive();
      act(() => result.current.launch());
      await waitFor(() => expect(result.current.claim).toEqual(TICKET));
      act(() => result.current.attachVideo(document.createElement("video")));
      const session = rtc.sessions[0]!;
      act(() => session.emit({ type: "first-frame" }));
      act(() => session.emit({ type: "game-started" }));
      expect(result.current.phase).toBe("live");
      return { calls, opened, result, session };
    }

    /** The stream following b-1, the running session's booking, on to its end. */
    const runningStream = (opened: ReturnType<typeof streams>) =>
      opened.find((o) => o.url === "/api/events?booking=b-1&to=end")!;

    it("follows the running session's booking to its end, and carries a lost one on by itself", async () => {
      const { calls, opened, result, session } = await playing({
        "POST /api/bookings/b-1/continue": json(202, carried()),
        "POST /api/bookings/b-2/claim": json(200, NEXT_TICKET),
      });
      expect(runningStream(opened)).toBeDefined();
      track.mockClear();

      act(() => runningStream(opened).push(ended()));
      expect(result.current.lost).toMatchObject({ host: "Basement rig", taken: false, next: null });
      expect(result.current.phase).toBe("idle");
      expect(session.ended).toBe(true);
      expect(track).toHaveBeenCalledWith("machine_lost", { game: 730, reason: "host_offline" });

      // Nothing to press: the next machine is claimed, and Ignition starts there.
      await waitFor(() => expect(result.current.claim).toEqual(NEXT_TICKET));
      expect(calls.map((c) => c.call)).toContain("POST /api/bookings/b-1/continue");
      expect(calls.map((c) => c.call)).not.toContain("POST /api/bookings/b-1/end");
      expect(result.current.phase).toBe("connecting");
      expect(result.current.lost?.next?.bookingId).toBe("b-2");
      expect(result.current.ignitionSteps[1]).toBe("Waking Attic box");
      await waitFor(() => expect(rtc.sessions).toHaveLength(2));
      expect(rtc.sessions[1]!.options.ticket).toBe("t-2");
      act(() => rtc.sessions[1]!.emit({ type: "first-frame" }));
      act(() => rtc.sessions[1]!.emit({ type: "game-started" }));
      expect(result.current.phase).toBe("live");
      expect(result.current.lost).toBeNull();
    });

    it("asks the server why a ticket was refused, and waits in the queue when every machine is busy", async () => {
      const { calls, opened, result, session } = await playing({
        "GET /api/bookings/b-1": json(200, ended("owner_kill")),
        "POST /api/bookings/b-1/continue": json(202, carried("queued")),
        "POST /api/bookings/b-2/claim": json(200, NEXT_TICKET),
      });
      track.mockClear();

      act(() => session.emit({ type: "denied", reason: "bad-ticket" }));
      await waitFor(() => expect(result.current.lost?.next?.status).toBe("queued"));
      expect(result.current.lost?.taken).toBe(true);
      expect(result.current.phase).toBe("idle");
      expect(calls.map((c) => c.call)).not.toContain("POST /api/bookings/b-1/end");
      expect(track).not.toHaveBeenCalledWith("session_ended", expect.anything());

      // Matched later: claimed the moment it is, as any queued booking is.
      await waitFor(() => expect(opened.some((o) => o.url === "/api/events?booking=b-2")).toBe(true));
      act(() =>
        opened
          .find((o) => o.url === "/api/events?booking=b-2")!
          .push({ ...carried(), claimBy: Date.now() + 60_000 }),
      );
      await waitFor(() => expect(result.current.claim).toEqual(NEXT_TICKET));
      expect(result.current.phase).toBe("connecting");
    });

    it("carries a machine lost during Ignition on, though its ticket is refused as the loss is heard", async () => {
      const calls = serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, { ...booked("matched", 1_000), machine: LOST_ON }),
        "POST /api/bookings/b-1/claim": json(200, TICKET),
        "GET /api/bookings/b-1": json(200, ended()),
        "POST /api/bookings/b-1/continue": json(202, carried("queued")),
      });
      const opened = streams();
      const result = await openLive();
      act(() => result.current.launch());
      await waitFor(() => expect(result.current.claim).toEqual(TICKET));
      act(() => result.current.attachVideo(document.createElement("video")));
      expect(result.current.phase).toBe("connecting");

      // The server ends the session for the lost machine: the booking says so,
      // and the renter's ticket is refused in the same breath.
      act(() => {
        runningStream(opened).push(ended());
        rtc.sessions[0]!.emit({ type: "denied", reason: "bad-ticket" });
      });
      await waitFor(() => expect(result.current.lost?.next?.bookingId).toBe("b-2"));
      expect(result.current.bookingFailed).toBe(false);
      expect(calls.map((c) => c.call)).not.toContain("POST /api/bookings/b-1/end");
      expect(calls.map((c) => c.call)).not.toContain("POST /api/bookings/b-2/end");
    });

    it("hands the choice back when there is no machine to carry it on", async () => {
      const { opened, result } = await playing({
        "POST /api/bookings/b-1/continue": json(409, { status: "ended" }),
      });
      act(() => runningStream(opened).push(ended()));
      await waitFor(() => expect(result.current.lost?.failed).toBe(true));

      act(() => result.current.chooseMachine());
      expect(result.current.lost).toBeNull();
      expect(result.current.screen).toBe("game");
      expect(result.current.phase).toBe("idle");
    });

    it("stops for now: the booking carrying it on ends, and its machine goes back", async () => {
      const { calls, opened, result } = await playing({
        "POST /api/bookings/b-1/continue": json(202, carried("queued")),
        "POST /api/bookings/b-2/end": json(200, { ...carried("queued"), status: "ended" }),
      });
      act(() => runningStream(opened).push(ended()));
      await waitFor(() => expect(result.current.lost?.next).not.toBeNull());

      act(() => result.current.stopLost());
      expect(result.current.lost).toBeNull();
      expect(result.current.booking).toBeNull();
      await waitFor(() => expect(calls.map((c) => c.call)).toContain("POST /api/bookings/b-2/end"));
    });

    it("carries nothing on for a session that ended any other way", async () => {
      const { calls, opened, result } = await playing();
      act(() => runningStream(opened).push(ended("time_up")));
      expect(result.current.lost).toBeNull();
      expect(calls.map((c) => c.call)).not.toContain("POST /api/bookings/b-1/continue");
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

    describe("on the page, before its game list has loaded", () => {
      beforeEach(() => {
        vi.stubGlobal("matchMedia", (query: string) => ({
          matches: false,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }));
        Element.prototype.scrollTo ??= () => {};
        // jsdom plays no media: the stream's video, once live, plays at once.
        vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
        keepPlaying();
      });
      afterEach(() => vi.restoreAllMocks());

      /** The store's read of which games Swiff can run, held back until `answer` is called. */
      function heldCatalog() {
        let answer: (wall: { appid: number }[]) => void = () => {};
        const read = new Promise<Response>((resolve) => {
          answer = (wall) => resolve(new Response(JSON.stringify({ games: [], wall })));
        });
        return { read: (() => read) as unknown as () => Response, answer };
      }

      /** Press Reconnect on screen A, once the page has put it up. */
      const pressReconnect = async () => {
        const away = await screen.findByTestId("away");
        act(() => within(away).getByRole("button", { name: "Reconnect" }).click());
      };

      it.each(["claimed", "playing"] as const)(
        "streams a %s session Reconnect was pressed on, and names its game once the list is in",
        async (status) => {
          const catalog = heldCatalog();
          serve(unnamed, LIVE, {
            "GET /api/bookings/b-1": json(200, { ...playing(Date.now() + 100_000), status }),
            "POST /api/bookings/b-1/rejoin": json(200, AGAIN),
            "POST /api/sessions/s-1/start": json(200, { sessionId: "s-1", roomId: "pc-1" }),
            "GET /api/games/popular": catalog.read,
          });
          render(createElement(Swiff));
          await pressReconnect();

          // The stream joins at once: nothing waits on the game list.
          await waitFor(() => expect(rtc.sessions).toHaveLength(1));
          expect(rtc.sessions[0]!.options).toMatchObject({ ticket: "t-again" });
          expect(screen.getByTestId("session-video")).toBeInTheDocument();
          act(() => rtc.sessions[0]!.emit({ type: "first-frame" }));
          act(() => rtc.sessions[0]!.emit({ type: "game-started" }));
          expect(screen.queryByTestId("ignition")).toBeNull();
          expect(screen.getByTestId("session")).toHaveTextContent("Your game");

          act(() => catalog.answer([{ appid: cs2.appid }]));
          await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent(cs2.title));
        },
      );

      it("plays a session whose game the list never shows, and ends on the wall", async () => {
        serve(unnamed, LIVE, {
          "GET /api/bookings/b-1": json(200, playing()),
          "POST /api/bookings/b-1/rejoin": json(200, AGAIN),
          "POST /api/sessions/s-1/start": json(200, { sessionId: "s-1", roomId: "pc-1" }),
          "POST /api/bookings/b-1/end": json(200, booked("ended")),
          "GET /api/games/popular": json(200, { games: [], wall: [] }),
        });
        render(createElement(Swiff));
        await pressReconnect();
        await waitFor(() => expect(rtc.sessions).toHaveLength(1));
        act(() => rtc.sessions[0]!.emit({ type: "first-frame" }));
        act(() => rtc.sessions[0]!.emit({ type: "game-started" }));
        expect(screen.getByTestId("session")).toHaveTextContent("Your game");

        act(() => screen.getByRole("button", { name: "End session" }).click());
        expect(screen.queryByTestId("session")).toBeNull();
        // Not a game's page with no game on it: the wall, where another can be picked.
        expect(document.querySelector(".sw")).toHaveAttribute("data-screen", "home");
      });

      it("says in one line when the session cannot be reached, and Reconnect tries again", async () => {
        let rejoins = 0;
        serve(unnamed, LIVE, {
          "GET /api/bookings/b-1": json(200, playing(Date.now() + 100_000)),
          "POST /api/bookings/b-1/rejoin": () =>
            ++rejoins === 1 ? new Response(null, { status: 503 }) : json(200, AGAIN)(),
          "POST /api/sessions/s-1/start": json(200, { sessionId: "s-1", roomId: "pc-1" }),
        });
        render(createElement(Swiff));
        await pressReconnect();

        const away = screen.getByTestId("away");
        await waitFor(() => expect(away).toHaveTextContent("We couldn't reach Glasshouse."));
        const again = within(away).getByRole("button", { name: "Reconnect" });
        expect(again).toBeEnabled();
        act(() => again.click());
        await waitFor(() => expect(rtc.sessions).toHaveLength(1));
        expect(screen.queryByTestId("away")).toBeNull();
      });
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
