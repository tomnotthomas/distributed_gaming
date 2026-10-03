import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "./derive";
import { MAX_APPIDS } from "./live";
import {
  BACKSTOP_MS,
  MIN_GAP_MS,
  SLOW_POLL_MS,
  useLive,
  type EventStream,
  type LiveOptions,
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
});
