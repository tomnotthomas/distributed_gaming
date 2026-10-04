import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GAMES } from "./data";
import { GameMenu } from "./GameMenu";
import type { GameAvailability, GameMachines } from "./live";
import type { Renter } from "./steam";
import { SLOW_POLL_MS } from "./useLive";
import { isDemo, useSwiff } from "./useSwiff";

// Analytics are off in tests; the real module refuses to load without a key in dev.
vi.mock("../posthog", () => ({ default: { capture: () => {} }, isPostHogEnabled: false }));

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
/** The same claim on a rental-mode (Swiff OS) PC. */
const RENTAL_TICKET = { ...TICKET, rentalMode: true };

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

/** The signaling sockets the page opens, through a stand-in for WebSocket that each test drives. */
function sockets() {
  const opened: {
    url: string;
    sent: unknown[];
    closed: boolean;
    open: () => void;
    deliver: (msg: unknown) => void;
    drop: () => void;
  }[] = [];
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(url: string) {
        const socket = {
          url,
          sent: [] as unknown[],
          closed: false,
          open: () => {
            this.readyState = 1;
            this.onopen?.();
          },
          deliver: (msg: unknown) => this.onmessage?.({ data: JSON.stringify(msg) }),
          drop: () => {
            this.readyState = 3;
            this.onclose?.();
          },
        };
        this.send = (data: string) => socket.sent.push(JSON.parse(data));
        this.close = () => {
          socket.closed = true;
          this.readyState = 3;
        };
        opened.push(socket);
      }
      send: (data: string) => void;
      close: () => void;
    },
  );
  return opened;
}

const NOTHING = { free: 0, ready: 0, best: null, busy: 0, backAt: null, backName: null };
const NO_MACHINES = { minutes: 180, machines: [], reason: null, busy: [] };

/** The paths fetched so far. */
const fetched = () => vi.mocked(fetch).mock.calls.map(([path]) => String(path));

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
    let signaling: ReturnType<typeof sockets>;
    beforeEach(() => {
      signaling = sockets();
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

    it("shows a rental-mode PC's Steam sign-in code from the claimed room until the renter approves it", async () => {
      serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("matched", 1_000)),
        "POST /api/bookings/b-1/claim": json(200, RENTAL_TICKET),
      });
      streams();
      const result = await openLive();
      act(() => result.current.launch());
      await waitFor(() => expect(signaling).toHaveLength(1));

      const socket = signaling[0]!;
      expect(socket.url).toBe(TICKET.signalingUrl);
      act(() => socket.open());
      expect(socket.sent).toContainEqual({ type: "join", ticket: TICKET.ticket });
      expect(result.current.steamLogin).toBeNull();

      act(() => socket.deliver({ type: "steam-login", state: "qr", url: "https://s.team/q/1/42" }));
      expect(result.current.steamLogin).toEqual({
        type: "steam-login",
        state: "qr",
        url: "https://s.team/q/1/42",
      });

      act(() => socket.deliver({ type: "steam-login", state: "signed-in" }));
      expect(result.current.steamLogin).toBeNull();
      expect(result.current.phase).toBe("connecting");
      expect(socket.closed).toBe(false);
    });

    it("drops the Steam sign-in code and leaves the room when the launch is left", async () => {
      serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("matched", 1_000)),
        "POST /api/bookings/b-1/claim": json(200, RENTAL_TICKET),
        "POST /api/bookings/b-1/end": json(200, booked("ended")),
      });
      streams();
      const result = await openLive();
      act(() => result.current.launch());
      await waitFor(() => expect(signaling).toHaveLength(1));
      act(() => signaling[0]!.open());
      act(() => signaling[0]!.deliver({ type: "steam-login", state: "qr", url: "https://s.team/q/1/42" }));
      expect(result.current.steamLogin).not.toBeNull();

      act(() => result.current.goHome());

      expect(result.current.phase).toBe("idle");
      expect(result.current.steamLogin).toBeNull();
      expect(signaling[0]!.closed).toBe(true);
    });

    it("holds Ignition on the Steam sign-in code until the renter approves it, then goes live", async () => {
      serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("matched", 1_000)),
        "POST /api/bookings/b-1/claim": json(200, RENTAL_TICKET),
      });
      streams();
      const result = await openLive();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        act(() => result.current.launch());
        await waitFor(() => expect(signaling).toHaveLength(1));
        act(() => signaling[0]!.open());
        act(() => signaling[0]!.deliver({ type: "steam-login", state: "qr", url: "https://s.team/q/1/42" }));
        const held = result.current.progress;

        await act(() => vi.advanceTimersByTimeAsync(60_000));

        expect(result.current.phase).toBe("connecting");
        expect(result.current.progress).toBe(held);
        expect(result.current.steamLogin?.state).toBe("qr");
        expect(signaling[0]!.closed).toBe(false);

        act(() => signaling[0]!.deliver({ type: "steam-login", state: "signed-in" }));
        await act(() => vi.advanceTimersByTimeAsync(60_000));

        expect(result.current.phase).toBe("live");
        expect(result.current.steamLogin).toBeNull();
        expect(signaling[0]!.closed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("holds Ignition from a rental-mode claim until signed in, however late the code comes", async () => {
      serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("matched", 1_000)),
        "POST /api/bookings/b-1/claim": json(200, RENTAL_TICKET),
      });
      streams();
      const result = await openLive();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        act(() => result.current.launch());
        await waitFor(() => expect(signaling).toHaveLength(1));
        act(() => signaling[0]!.open());

        await act(() => vi.advanceTimersByTimeAsync(60_000));
        expect(result.current.phase).toBe("connecting");
        expect(result.current.steamLogin).toBeNull();
        expect(signaling[0]!.closed).toBe(false);

        act(() => signaling[0]!.deliver({ type: "steam-login", state: "qr", url: "https://s.team/q/1/42" }));
        expect(result.current.steamLogin?.state).toBe("qr");

        act(() => signaling[0]!.deliver({ type: "steam-login", state: "signed-in" }));
        await act(() => vi.advanceTimersByTimeAsync(60_000));
        expect(result.current.phase).toBe("live");
      } finally {
        vi.useRealTimers();
      }
    });

    it("shows no code but a Steam sign-in link, and keeps Ignition held for a real one", async () => {
      serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("matched", 1_000)),
        "POST /api/bookings/b-1/claim": json(200, RENTAL_TICKET),
      });
      streams();
      const result = await openLive();
      act(() => result.current.launch());
      await waitFor(() => expect(signaling).toHaveLength(1));
      act(() => signaling[0]!.open());

      act(() => signaling[0]!.deliver({ type: "steam-login", state: "qr", url: "https://evil.test/q/1/42" }));

      expect(result.current.steamLogin).toBeNull();
      expect(result.current.phase).toBe("connecting");
    });

    it("keeps Ignition held on the code for any Steam sign-in state but signed-in", async () => {
      serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("matched", 1_000)),
        "POST /api/bookings/b-1/claim": json(200, RENTAL_TICKET),
      });
      streams();
      const result = await openLive();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        act(() => result.current.launch());
        await waitFor(() => expect(signaling).toHaveLength(1));
        act(() => signaling[0]!.open());
        act(() => signaling[0]!.deliver({ type: "steam-login", state: "qr", url: "https://s.team/q/1/42" }));

        act(() => signaling[0]!.deliver({ type: "steam-login", state: "failed" }));
        await act(() => vi.advanceTimersByTimeAsync(60_000));

        expect(result.current.phase).toBe("connecting");
        expect(result.current.steamLogin?.state).toBe("qr");
        expect(signaling[0]!.closed).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("says a failed Steam sign-in and never goes live on it, until a new code comes", async () => {
      serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("matched", 1_000)),
        "POST /api/bookings/b-1/claim": json(200, RENTAL_TICKET),
      });
      streams();
      const result = await openLive();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        act(() => result.current.launch());
        await waitFor(() => expect(signaling).toHaveLength(1));
        act(() => signaling[0]!.open());
        act(() => signaling[0]!.deliver({ type: "steam-login", state: "qr", url: "https://s.team/q/1/42" }));
        expect(result.current.steamSignInFailed).toBe(false);

        act(() => signaling[0]!.deliver({ type: "steam-login", state: "failed" }));
        await act(() => vi.advanceTimersByTimeAsync(60_000));

        expect(result.current.steamSignInFailed).toBe(true);
        expect(result.current.phase).toBe("connecting");
        expect(signaling[0]!.closed).toBe(false);

        act(() => signaling[0]!.deliver({ type: "steam-login", state: "qr", url: "https://s.team/q/1/43" }));
        expect(result.current.steamSignInFailed).toBe(false);
        expect(result.current.steamLogin).toEqual({
          type: "steam-login",
          state: "qr",
          url: "https://s.team/q/1/43",
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("holds Ignition again when the PC says the launch failed after signing in", async () => {
      serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("matched", 1_000)),
        "POST /api/bookings/b-1/claim": json(200, RENTAL_TICKET),
      });
      streams();
      const result = await openLive();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        act(() => result.current.launch());
        await waitFor(() => expect(signaling).toHaveLength(1));
        act(() => signaling[0]!.open());
        act(() => signaling[0]!.deliver({ type: "steam-login", state: "qr", url: "https://s.team/q/1/42" }));
        act(() => signaling[0]!.deliver({ type: "steam-login", state: "signed-in" }));
        act(() => signaling[0]!.deliver({ type: "steam-login", state: "failed" }));

        await act(() => vi.advanceTimersByTimeAsync(60_000));

        expect(result.current.phase).toBe("connecting");
        expect(result.current.steamSignInFailed).toBe(true);
        expect(signaling[0]!.closed).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("tries a failed Steam sign-in again on the claimed room, keeping the booking and the machine", async () => {
      const calls = serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("queued")),
        "POST /api/bookings/b-1/claim": json(200, RENTAL_TICKET),
        "POST /api/bookings/b-1/end": json(200, booked("ended")),
      });
      const opened = streams();
      const result = await openLive();
      act(() => result.current.joinQueue());
      await waitFor(() => expect(opened.some((o) => o.url === "/api/events?booking=b-1")).toBe(true));
      act(() => opened.find((o) => o.url === "/api/events?booking=b-1")!.push(booked("matched", 1_000)));
      await waitFor(() => expect(signaling).toHaveLength(1));
      act(() => signaling[0]!.open());
      act(() => signaling[0]!.deliver({ type: "joined", hostId: "pc-1", hostOnline: true }));
      act(() => signaling[0]!.deliver({ type: "steam-login", state: "qr", url: "https://s.team/q/1/42" }));
      act(() => signaling[0]!.deliver({ type: "steam-login", state: "failed" }));
      expect(result.current.steamSignInFailed).toBe(true);

      act(() => result.current.retrySignIn());

      expect(signaling[0]!.sent).toContainEqual({ type: "steam-login", state: "retry" });
      expect(signaling[0]!.closed).toBe(false);
      expect(signaling).toHaveLength(1);
      expect(result.current.steamSignInFailed).toBe(false);
      expect(result.current.steamLogin).toBeNull();
      expect(result.current.phase).toBe("connecting");
      expect(result.current.claim).toEqual(RENTAL_TICKET);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls.filter((c) => c.call === "POST /api/bookings")).toHaveLength(1);
      expect(fetched()).not.toContain("/api/bookings/b-1/end");

      act(() => signaling[0]!.deliver({ type: "steam-login", state: "qr", url: "https://s.team/q/1/43" }));
      expect(result.current.steamLogin).toEqual({
        type: "steam-login",
        state: "qr",
        url: "https://s.team/q/1/43",
      });
    });

    it("holds a Steam sign-in retry while the room is reconnecting, and sends it once joined again", async () => {
      serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("matched", 1_000)),
        "POST /api/bookings/b-1/claim": json(200, RENTAL_TICKET),
      });
      streams();
      const result = await openLive();
      act(() => result.current.launch());
      await waitFor(() => expect(signaling).toHaveLength(1));
      act(() => signaling[0]!.open());
      act(() => signaling[0]!.deliver({ type: "joined", hostId: "pc-1", hostOnline: true }));
      act(() => signaling[0]!.deliver({ type: "steam-login", state: "failed" }));
      act(() => signaling[0]!.drop());

      act(() => result.current.retrySignIn());

      expect(result.current.steamSignInFailed).toBe(false);
      expect(result.current.phase).toBe("connecting");
      await waitFor(() => expect(signaling).toHaveLength(2));
      const again = signaling[1]!;
      act(() => again.open());
      expect(again.sent).not.toContainEqual({ type: "steam-login", state: "retry" });
      act(() => again.deliver({ type: "joined", hostId: "pc-1", hostOnline: true }));
      expect(again.sent).toContainEqual({ type: "steam-login", state: "retry" });

      act(() => again.deliver({ type: "steam-login", state: "failed" }));
      expect(result.current.steamSignInFailed).toBe(true);
      expect(again.sent.filter((m) => JSON.stringify(m).includes("retry"))).toHaveLength(1);
    });

    it("holds a Steam sign-in retry while the PC is away, and sends it once the PC is heard again", async () => {
      serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("matched", 1_000)),
        "POST /api/bookings/b-1/claim": json(200, RENTAL_TICKET),
      });
      streams();
      const result = await openLive();
      act(() => result.current.launch());
      await waitFor(() => expect(signaling).toHaveLength(1));
      const room = signaling[0]!;
      const retries = () =>
        room.sent.filter(
          (m) => JSON.stringify(m) === JSON.stringify({ type: "steam-login", state: "retry" }),
        );
      act(() => room.open());
      act(() => room.deliver({ type: "joined", hostId: "pc-1", hostOnline: true }));
      act(() => room.deliver({ type: "steam-login", state: "failed" }));
      act(() => room.deliver({ type: "peer-left" }));

      act(() => result.current.retrySignIn());
      expect(retries()).toHaveLength(0);
      expect(result.current.steamSignInFailed).toBe(false);

      act(() => room.deliver({ type: "ice", candidate: { candidate: "" } }));
      act(() => room.deliver({ type: "ice", candidate: { candidate: "" } }));
      expect(retries()).toHaveLength(1);
      expect(room.closed).toBe(false);
      expect(signaling).toHaveLength(1);
    });

    it("counts the PC back on its Steam sign-in frame, so Try again reaches it", async () => {
      serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("matched", 1_000)),
        "POST /api/bookings/b-1/claim": json(200, RENTAL_TICKET),
      });
      streams();
      const result = await openLive();
      act(() => result.current.launch());
      await waitFor(() => expect(signaling).toHaveLength(1));
      const room = signaling[0]!;
      act(() => room.open());
      act(() => room.deliver({ type: "joined", hostId: "pc-1", hostOnline: true }));
      act(() => room.deliver({ type: "peer-left" }));
      act(() => room.deliver({ type: "steam-login", state: "failed" }));

      act(() => result.current.retrySignIn());

      expect(room.sent).toContainEqual({ type: "steam-login", state: "retry" });
    });

    it("leaves the Steam sign-in hold and ends the booking when the room refuses the ticket", async () => {
      serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("matched", 1_000)),
        "POST /api/bookings/b-1/claim": json(200, RENTAL_TICKET),
        "POST /api/bookings/b-1/end": json(200, booked("ended")),
      });
      streams();
      const result = await openLive();
      act(() => result.current.launch());
      await waitFor(() => expect(signaling).toHaveLength(1));
      act(() => signaling[0]!.open());

      act(() => signaling[0]!.deliver({ type: "denied", reason: "bad-ticket" }));

      expect(result.current.phase).toBe("idle");
      expect(result.current.bookingFailed).toBe(true);
      expect(result.current.claim).toBeNull();
      expect(signaling[0]!.closed).toBe(true);
      await waitFor(() => expect(fetched()).toContain("/api/bookings/b-1/end"));
    });

    it("never joins the room of a PC not in rental mode, and goes live on Ignition's timer", async () => {
      serve(unnamed, LIVE, {
        "POST /api/bookings": json(202, booked("matched", 1_000)),
        "POST /api/bookings/b-1/claim": json(200, TICKET),
      });
      streams();
      const result = await openLive();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        act(() => result.current.launch());
        await waitFor(() => expect(result.current.claim).toEqual(TICKET));
        await act(() => vi.advanceTimersByTimeAsync(60_000));

        expect(result.current.phase).toBe("live");
        expect(signaling).toHaveLength(0);
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
});
