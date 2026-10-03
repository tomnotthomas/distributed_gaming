import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GAMES } from "./data";
import type { GameAvailability, GameMachines } from "./live";
import type { Renter } from "./steam";
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
 * The server: /api/me answers `renter` (404 when null), /api/ping answers, and
 * the availability reads answer from `hosts` for a signed-in renter (401
 * signed out); every catalog read comes back empty.
 */
function serve(renter: Renter | null, hosts: Hosts = {}) {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
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
}

const NOTHING = { free: 0, ready: 0, best: null, busy: 0, backAt: null, backName: null };
const NO_MACHINES = { minutes: 180, machines: [], reason: null, busy: [] };

/** The paths fetched so far. */
const fetched = () => vi.mocked(fetch).mock.calls.map(([path]) => String(path));

/** A free-to-play game with a machine free tonight, so only sign-in can stand in its way. */
const cs2 = GAMES.find((game) => game.id === "cs")!;

describe("useSwiff", () => {
  afterEach(() => vi.unstubAllGlobals());

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

  it("launches for a signed-in renter", async () => {
    serve(unnamed);
    const { result } = renderHook(() => useSwiff({ demo: true }));
    await waitFor(() => expect(result.current.signedIn).toBe(true));

    const game = result.current.games.find((g) => g.appid === cs2.appid)!;
    act(() => result.current.openGame(game));
    act(() => result.current.launch());

    expect(result.current.phase).toBe("connecting");
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
  });
});
