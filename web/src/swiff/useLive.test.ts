import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "./derive";
import type { ProbeResult } from "@swiff/rtc";
import { MAX_APPIDS } from "./live";
import {
  BACKSTOP_MS,
  MEASURED_FOR_MS,
  MIN_GAP_MS,
  SLOW_POLL_MS,
  useLive,
  type EventStream,
  type LiveOptions,
  type Prober,
} from "./useLive";

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), init);
const NOTHING = { free: 0, ready: 0, best: null, busy: 0, backAt: null, backName: null };

/** A stand-in event stream: the test fires its events by name. */
function fakeStream() {
  const listeners = new Map<string, () => void>();
  const stream: EventStream = {
    addEventListener: ((name: string, fn: () => void) =>
      listeners.set(name, fn)) as unknown as EventStream["addEventListener"],
    close: vi.fn(),
  };
  return { stream, fire: (name: string) => act(() => listeners.get(name)?.()), opened: vi.fn() };
}

/** The server: the ping answers, availability answers `free` for every game, or `status` instead. */
function server() {
  let free = 0;
  let status = 200;
  const get = vi.fn(async (path: string) => {
    if (path.startsWith("/api/ping")) return new Response(null, { status: 204 });
    if (status !== 200) return json({}, { status, headers: { "retry-after": "5" } });
    if (path.startsWith("/api/availability")) {
      const appids = new URL(path, "http://x").searchParams.get("appids")!.split(",").map(Number);
      return json(appids.map((appid) => ({ appid, ...NOTHING, free, ready: free })));
    }
    return json({ appid: 730, minutes: 60, machines: [], reason: null, busy: [] });
  });
  const reads = () => get.mock.calls.filter(([p]) => String(p).startsWith("/api/availability")).length;
  return {
    get: get as unknown as typeof fetch,
    calls: get,
    reads,
    setFree: (n: number) => (free = n),
    setStatus: (n: number) => (status = n),
  };
}

/** Let the pending fetches and the state they set settle. */
const flush = () => act(async () => {});

/** Let the round trip be timed (three pings, a moment apart) and the first reads answer. */
const started = () => act(async () => void (await vi.advanceTimersByTimeAsync(400)));

describe("useLive", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const options = (over: Partial<LiveOptions>): LiveOptions => ({
    enabled: true,
    appids: [730, 570],
    appid: null,
    minutes: 60,
    prefs: DEFAULT_PREFS,
    eventSource: null,
    ...over,
  });

  it("reads nothing for a renter it is not enabled for", async () => {
    const api = server();
    const { result } = renderHook(() => useLive(options({ enabled: false, fetch: api.get })));
    await flush();
    expect(api.calls).not.toHaveBeenCalled();
    expect(result.current.wall).toBeNull();
  });

  it("reads the wall once the round trip is timed, and the open game's machines", async () => {
    const api = server();
    api.setFree(2);
    const { result } = renderHook(() => useLive(options({ appid: 730, fetch: api.get })));
    await started();
    expect(result.current.wall?.games.get(730)?.ready).toBe(2);
    expect(result.current.wall?.question).toBe("60|auto|kb,mouse,pad");
    expect(result.current.game?.machines.appid).toBe(730);
  });

  it("reads again on an availability event, no sooner than MIN_GAP_MS after the last read", async () => {
    const api = server();
    const { stream, fire } = fakeStream();
    const { result } = renderHook(() => useLive(options({ fetch: api.get, eventSource: () => stream })));
    await started();
    expect(api.reads()).toBe(1);

    api.setFree(1);
    fire("availability");
    fire("availability");
    await act(async () => vi.advanceTimersByTime(MIN_GAP_MS - 1));
    expect(api.reads()).toBe(1);
    await act(async () => vi.advanceTimersByTime(1));
    await flush();
    expect(api.reads()).toBe(2);
    expect(result.current.wall?.games.get(730)?.ready).toBe(1);
  });

  it("polls while the stream is down, and stops once it is back", async () => {
    const api = server();
    const { stream, fire } = fakeStream();
    renderHook(() => useLive(options({ fetch: api.get, eventSource: () => stream })));
    await started();

    fire("error");
    // The poll's read waits for a timer of its own, due the moment the poll ticks.
    await act(async () => vi.advanceTimersByTime(SLOW_POLL_MS + 1));
    await flush();
    expect(api.reads()).toBe(2);

    fire("open"); // back after a drop: what changed meanwhile was missed
    await act(async () => vi.advanceTimersByTime(MIN_GAP_MS));
    await flush();
    expect(api.reads()).toBe(3);
    await act(async () => vi.advanceTimersByTime(SLOW_POLL_MS));
    await flush();
    expect(api.reads()).toBe(3);
  });

  it("asks every BACKSTOP_MS even while the stream is quiet", async () => {
    const api = server();
    const { stream } = fakeStream();
    renderHook(() => useLive(options({ fetch: api.get, eventSource: () => stream })));
    await started();
    await act(async () => vi.advanceTimersByTime(BACKSTOP_MS + 1));
    await flush();
    expect(api.reads()).toBe(2);
  });

  it("waits out Retry-After when over budget, keeping the last answer up", async () => {
    const api = server();
    api.setFree(3);
    const { result, rerender } = renderHook((props: LiveOptions) => useLive(props), {
      initialProps: options({ fetch: api.get }),
    });
    await started();
    expect(result.current.wall?.games.get(730)?.ready).toBe(3);

    api.setStatus(429);
    rerender(options({ fetch: api.get, minutes: 180 }));
    await flush();
    expect(api.reads()).toBe(2);
    expect(result.current.wall?.games.get(730)?.ready).toBe(3);

    api.setStatus(200);
    await act(async () => vi.advanceTimersByTime(5_000));
    await flush();
    expect(api.reads()).toBe(3);
    expect(result.current.wall?.question).toBe("180|auto|kb,mouse,pad");
  });

  it("keeps the parts of a large wall already read over budget, and asks again only for the rest", async () => {
    // Room for one part now, then one part per Retry-After.
    let tokens = 1;
    const asked: number[][] = [];
    const get = vi.fn(async (path: string) => {
      if (path.startsWith("/api/ping")) return new Response(null, { status: 204 });
      if (!tokens) return json({}, { status: 429, headers: { "retry-after": "2" } });
      tokens--;
      const appids = new URL(path, "http://x").searchParams.get("appids")!.split(",").map(Number);
      asked.push(appids);
      return json(appids.map((appid) => ({ appid, ...NOTHING, free: 1, ready: 1 })));
    });
    const appids = Array.from({ length: MAX_APPIDS * 2 + 5 }, (_, i) => i + 1);
    const { result } = renderHook(() => useLive(options({ appids, fetch: get as unknown as typeof fetch })));
    await started();
    expect(asked).toHaveLength(1);
    expect(result.current.wall).toBeNull();

    for (let i = 0; i < 2; i++) {
      tokens = 1;
      await act(async () => vi.advanceTimersByTime(2_000));
      await flush();
    }
    expect(result.current.wall?.games.size).toBe(appids.length);
    expect(asked.flat()).toEqual(appids);
  });

  it("finishes a large wall with the budget spent while availability events keep coming", async () => {
    // One read now, then one more every two seconds, as the server's budget refills.
    const start = Date.now();
    let spent = 0;
    const get = vi.fn(async (path: string) => {
      if (path.startsWith("/api/ping")) return new Response(null, { status: 204 });
      if (spent >= 1 + Math.floor((Date.now() - start) / 2_000))
        return json({}, { status: 429, headers: { "retry-after": "2" } });
      spent++;
      const appids = new URL(path, "http://x").searchParams.get("appids")!.split(",").map(Number);
      return json(appids.map((appid) => ({ appid, ...NOTHING })));
    });
    const appids = Array.from({ length: MAX_APPIDS * 3 + 5 }, (_, i) => i + 1);
    const { stream, fire } = fakeStream();
    const { result } = renderHook(() =>
      useLive(options({ appids, fetch: get as unknown as typeof fetch, eventSource: () => stream })),
    );
    await started();

    for (let i = 0; i < 10 && !result.current.wall; i++) {
      fire("availability");
      await act(async () => void (await vi.advanceTimersByTimeAsync(MIN_GAP_MS)));
    }
    expect(result.current.wall?.games.size).toBe(appids.length);
  });

  it("closes the stream and forgets what it read once signed out", async () => {
    const api = server();
    const { stream } = fakeStream();
    const { result, rerender } = renderHook((props: LiveOptions) => useLive(props), {
      initialProps: options({ fetch: api.get, eventSource: () => stream }),
    });
    await started();
    expect(result.current.wall).not.toBeNull();

    rerender(options({ enabled: false, fetch: api.get, eventSource: () => stream }));
    await flush();
    expect(stream.close).toHaveBeenCalled();
    expect(result.current.wall).toBeNull();
  });

  describe("latency probes", () => {
    /** A machine as the list sends it; `probe` is its token when it is one of the top three not yet measured. */
    const machine = (id: string, probe: string | null) => ({
      id,
      name: id,
      gpu: "RTX 4070",
      cpu: "Ryzen 7",
      refreshHz: 144,
      availableUntil: null,
      minutesLeft: null,
      coversSession: true,
      latency: { rttMs: 20, jitterMs: 1, source: "estimate" },
      response: 2,
      picture: 3,
      probe,
    });

    /**
     * The server: lists `ids` (best estimate first) but those the read's
     * `links` say are unreachable, hands out a token for each of the first
     * three ids not in `links` with the relay `ice`, and keeps every `links` read.
     */
    function listing(ids: string[], ice: RTCIceServer[] = [{ urls: "turn:turn.test" }]) {
      const links: (Record<string, unknown> | null)[] = [];
      const get = vi.fn(async (path: string) => {
        if (path.startsWith("/api/ping")) return new Response(null, { status: 204 });
        const query = new URL(path, "http://x").searchParams;
        const sent = query.get("links") ? (JSON.parse(query.get("links")!) as Record<string, unknown>) : null;
        if (path.startsWith("/api/availability")) return json([]);
        links.push(sent);
        const tokened = ice.length ? ids.slice(0, 3).filter((id) => !(sent && id in sent)) : [];
        return json({
          appid: 730,
          minutes: 60,
          machines: ids
            .filter((id) => sent?.[id] !== null) // unreachable: not listed (E6)
            .map((id) => machine(id, tokened.includes(id) ? `token-${id}` : null)),
          reason: null,
          busy: [],
          ...(tokened.length ? { iceServers: ice } : {}),
        });
      });
      return { get: get as unknown as typeof fetch, links };
    }

    /** A prober that answers each round with `answer`, resolving when the test says. */
    function prober(answer: (hostId: string) => ProbeResult) {
      const rounds: { targets: string[]; iceServers: RTCIceServer[] }[] = [];
      let release: () => void = () => {};
      const probe = vi.fn<Prober>((targets, iceServers) => {
        rounds.push({ targets: targets.map((t) => t.hostId), iceServers });
        return new Promise<ProbeResult[]>((resolve) => {
          release = () => resolve(targets.map((t) => answer(t.hostId)));
        });
      });
      return { probe, rounds, finish: () => act(async () => release()) };
    }

    it("measures the top three on the game page, then ranks the list again by what it found", async () => {
      const api = listing(["pc-1", "pc-2", "pc-3", "pc-4"]);
      const probes = prober((hostId) =>
        hostId === "pc-2"
          ? { hostId, status: "unreachable" }
          : { hostId, status: "measured", link: { rttMs: hostId === "pc-3" ? 12 : 9, jitterMs: 1 } },
      );
      const { result } = renderHook(() =>
        useLive(options({ appid: 730, fetch: api.get, probe: probes.probe })),
      );
      await started();
      expect(probes.rounds).toEqual([
        { targets: ["pc-1", "pc-2", "pc-3"], iceServers: [{ urls: "turn:turn.test" }] },
      ]);
      expect(result.current.measuring).toEqual({ appid: 730, ids: ["pc-1", "pc-2", "pc-3"] });

      await probes.finish();
      await flush();
      expect(api.links).toEqual([
        null,
        {
          "pc-1": { rttMs: 9, jitterMs: 1 },
          "pc-2": null,
          "pc-3": { rttMs: 12, jitterMs: 1 },
        },
      ]);
      // pc-4 moved up the list, but the server's top three by estimate are spent: no more rounds.
      expect(probes.rounds).toHaveLength(1);
      expect(result.current.measuring).toBeNull();
      // A booking goes by the server and every machine reached.
      expect(result.current.rtts.machines).toEqual({ "pc-1": 9, "pc-3": 12 });
      expect(result.current.rtts.server).toEqual(expect.any(Number));
    });

    it("leaves the estimate standing when a probe learns nothing, and does not ask again at once", async () => {
      const api = listing(["pc-1"]);
      const probes = prober((hostId) => ({ hostId, status: "unanswered", reason: "too-many" }));
      const { stream, fire } = fakeStream();
      const { result } = renderHook(() =>
        useLive(options({ appid: 730, fetch: api.get, probe: probes.probe, eventSource: () => stream })),
      );
      await started();
      await probes.finish();
      await flush();
      expect(api.links).toEqual([null]);
      expect(result.current.measuring).toBeNull();

      fire("availability");
      await act(async () => vi.advanceTimersByTime(MIN_GAP_MS));
      await flush();
      expect(api.links).toEqual([null, null]);
      expect(probes.rounds).toHaveLength(1);

      // Past MEASURED_FOR_MS it is worth a try again.
      await act(async () => vi.advanceTimersByTime(MEASURED_FOR_MS));
      fire("availability");
      await act(async () => vi.advanceTimersByTime(MIN_GAP_MS));
      await flush();
      expect(probes.rounds).toHaveLength(2);
    });

    it("never probes without a relay to probe through, and the estimate stands", async () => {
      const api = listing(["pc-1"], []);
      const probes = prober((hostId) => ({ hostId, status: "unreachable" }));
      const { result } = renderHook(() =>
        useLive(options({ appid: 730, fetch: api.get, probe: probes.probe })),
      );
      await started();
      expect(result.current.game?.machines.machines.map((m) => m.probe)).toEqual([null]);
      expect(probes.probe).not.toHaveBeenCalled();
      expect(result.current.measuring).toBeNull();
    });

    it("never probes from the wall", async () => {
      const api = listing(["pc-1"]);
      const probes = prober((hostId) => ({ hostId, status: "unreachable" }));
      renderHook(() => useLive(options({ appid: null, fetch: api.get, probe: probes.probe })));
      await started();
      await act(async () => vi.advanceTimersByTime(BACKSTOP_MS + MIN_GAP_MS));
      await flush();
      expect(probes.probe).not.toHaveBeenCalled();
    });
  });
});
