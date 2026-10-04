import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
