// What this PC tells the platform, and when: the report's sections, the
// network figures, and the reporter's calls over a fake fetch and clock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PcRead } from "../pc.cjs";
import {
  BEAT_MS,
  BEAT_TIMEOUT_MS,
  changedSections,
  createHostReporter,
  crewOf,
  hostReport,
  netMoved,
  netOf,
  playingFor,
  reportHardware,
  UPLOAD_TEST_BYTES,
  UPLOAD_TEST_EVERY_MS,
  UPLOAD_TIMEOUT_MS,
  type HostReport,
} from "./report";

const HARDWARE: PcRead["hardware"] = {
  gpu: "NVIDIA GeForce RTX 4070",
  vramMb: 12_282,
  ramMb: 32_768,
  cpu: "Ryzen 7 7800X3D",
  cores: 8,
  encoders: ["h264", "hevc", "av1"],
  display: { width: 2560, height: 1440, refreshHz: 144 },
};
const PC: PcRead = {
  hardware: HARDWARE,
  controls: ["kb", "mouse", "pad"],
  games: [
    { appid: 1245620, name: "ELDEN RING" },
    { appid: 730, name: "Counter-Strike 2" },
  ],
};

describe("the report", () => {
  it("sends hardware only when every field is known", () => {
    expect(reportHardware(HARDWARE)).toEqual(HARDWARE);
    expect(reportHardware({ ...HARDWARE, cores: null })).toBeNull();
    expect(reportHardware({ ...HARDWARE, encoders: null })).toBeNull();
    expect(
      reportHardware({ ...HARDWARE, display: { width: 1920, height: 1080, refreshHz: null } }),
    ).toBeNull();
    expect(reportHardware(null)).toBeNull();
  });

  it("names the PC, and lists the offered games once the PC is read", () => {
    expect(hostReport({ name: "  Nova-01 ", pc: null, offered: null })).toEqual({ name: "Nova-01" });
    expect(hostReport({ name: "", pc: PC, offered: [1245620, 730] })).toEqual({
      hardware: HARDWARE,
      controls: ["kb", "mouse", "pad"],
      games: [730, 1245620],
    });
    expect(hostReport({ name: "x".repeat(80), pc: PC, offered: [] }).name).toHaveLength(64);
    expect(hostReport({ name: "Nova-01", pc: PC, offered: [] }).games).toEqual([]);
  });

  it("finds what changed since the last send", () => {
    const sent: HostReport = { name: "Nova-01", games: [730], controls: ["kb", "mouse"] };
    expect(changedSections(sent, { ...sent })).toEqual({});
    const hardware = reportHardware(HARDWARE)!;
    expect(changedSections(sent, { ...sent, games: [730, 570], hardware })).toEqual({
      games: [730, 570],
      hardware,
    });
  });
});

describe("the network figures", () => {
  it("are the median round trip and its mean change, once there are three and an upload speed", () => {
    expect(netOf([20, 22], 50)).toBeNull();
    expect(netOf([20, 22, 21], null)).toBeNull();
    expect(netOf([20, 30, 22, 24], 48.26)).toEqual({ rttMs: 23, jitterMs: 6.7, upMbps: 48.3 });
  });

  it("are sent again only once one has moved past noise", () => {
    const net = { rttMs: 20, jitterMs: 2, upMbps: 50 };
    expect(netMoved(null, net)).toBe(true);
    expect(netMoved(net, { ...net, rttMs: 24 })).toBe(false);
    expect(netMoved(net, { ...net, rttMs: 26 })).toBe(true);
    expect(netMoved(net, { ...net, jitterMs: 3.5 })).toBe(false);
    expect(netMoved(net, { ...net, jitterMs: 4.5 })).toBe(true);
    expect(netMoved(net, { ...net, upMbps: 45 })).toBe(false);
    expect(netMoved(net, { ...net, upMbps: 35 })).toBe(true);
  });
});

describe("createHostReporter", () => {
  type Call = { method: string; action: string; body: unknown; keepalive: boolean };
  let calls: Call[];
  let now: number;
  /** Answers by action; each call takes `took[action]` ms on the fake clock. */
  let answer: Record<string, number | "network">;
  let took: Record<string, number>;
  /** What a 200 answers, by action; an error body where none is set. */
  let replies: Record<string, unknown>;

  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const action = url.split("/").at(-1)!;
    expect(url).toBe(`https://signal.example/api/machines/pc%201/${action}`);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer key-1");
    calls.push({
      method: init.method!,
      action,
      body: typeof init.body === "string" ? JSON.parse(init.body) : (init.body as Uint8Array).byteLength,
      keepalive: Boolean(init.keepalive),
    });
    now += took[action] ?? 20;
    const status = answer[action] ?? (action === "upload-test" ? 204 : 200);
    if (status === "network") throw new TypeError("fetch failed");
    const body = status === 200 && replies[action] ? replies[action] : { error: "games must be a list" };
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
    });
  });

  const machine = { url: "wss://signal.example", machineId: "pc 1", machineKey: "key-1" };
  const reporter = (report: HostReport = { name: "Nova-01" }, extra = {}) =>
    createHostReporter(machine, {
      report,
      fetch: fetch as typeof globalThis.fetch,
      clock: () => now,
      ...extra,
    });
  const beat = () => vi.advanceTimersByTimeAsync(BEAT_MS);

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    now = 1_000;
    answer = {};
    took = {};
    replies = {};
    fetch.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("offers the PC with its report and time, then beats every 5 s with what changed", async () => {
    const r = reporter();
    r.offer(Date.UTC(2026, 9, 3, 22));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]).toEqual({
      method: "PUT",
      action: "availability",
      keepalive: false,
      body: { available: true, until: "2026-10-03T22:00:00.000Z", name: "Nova-01" },
    });
    expect(calls[1]).toMatchObject({ method: "POST", action: "upload-test", body: UPLOAD_TEST_BYTES });

    await beat();
    expect(calls.at(-1)).toEqual({ method: "POST", action: "heartbeat", keepalive: false, body: {} });
    r.update({ name: "Nova-01", games: [730] });
    await beat();
    expect(calls.at(-1)!.body).toEqual({ games: [730] });
    // The socket's round trips: three are enough for the first figures.
    [21, 19].forEach((ms) => r.addRtt(ms));
    await beat();
    expect(calls.at(-1)!.body).toEqual({});
    r.addRtt(26);
    await beat();
    expect(calls.at(-1)!.body).toEqual({ net: { rttMs: 21, jitterMs: 4.5, upMbps: expect.any(Number) } });
    // Noise is not news; a figure that moved is.
    [22, 20].forEach((ms) => r.addRtt(ms));
    await beat();
    expect(calls.at(-1)!.body).toEqual({});
    [60, 61, 62, 60, 61, 60, 62].forEach((ms) => r.addRtt(ms));
    await beat();
    expect(calls.at(-1)!.body).toEqual({
      net: { rttMs: 60, jitterMs: expect.any(Number), upMbps: expect.any(Number) },
    });
  });

  it("times the upload test for the upload speed, and runs none while a player is on", async () => {
    took["upload-test"] = 1_000;
    const uploads: number[] = [];
    const r = reporter({}, { onUpload: (mbps: number) => uploads.push(mbps) });
    r.offer(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(uploads).toEqual([33.6]); // 4 MiB in a second
    [20, 20, 20].forEach((ms) => r.addRtt(ms));
    await beat();
    expect(calls.at(-1)!.body).toEqual({ net: { rttMs: 20, jitterMs: 0, upMbps: 33.6 } });

    // A round trip taken while the test fills the link is left out.
    let release!: (res: Response) => void;
    const answering = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (!url.endsWith("/upload-test")) return answering(url, init);
      calls.push({ method: "POST", action: "upload-test", body: null, keepalive: false });
      return new Promise<Response>((resolve) => (release = resolve));
    });
    now += UPLOAD_TEST_EVERY_MS;
    await beat();
    expect(calls.filter((c) => c.action === "upload-test")).toHaveLength(2);
    [500, 500, 500].forEach((ms) => r.addRtt(ms));
    release(new Response(null, { status: 204 }));
    fetch.mockImplementation(answering);
    await vi.advanceTimersByTimeAsync(0);
    await beat();
    expect(calls.at(-1)!.body).toEqual({});

    r.setBusy(true);
    now += UPLOAD_TEST_EVERY_MS;
    await beat();
    expect(calls.filter((c) => c.action === "upload-test")).toHaveLength(2);
    r.setBusy(false);
    await beat();
    expect(calls.filter((c) => c.action === "upload-test")).toHaveLength(3);
  });

  it("gives up a hung beat before the next is due, and a hung upload test later", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const answering = fetch.getMockImplementation()!;
    const hung = new Set(["heartbeat"]);
    fetch.mockImplementation(async (url: string, init: RequestInit) => {
      const action = url.split("/").at(-1)!;
      if (!hung.has(action)) return answering(url, init);
      calls.push({ method: init.method!, action, body: null, keepalive: false });
      return new Promise<Response>((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
      );
    });
    const r = reporter();
    r.offer(null);
    await vi.advanceTimersByTimeAsync(0);

    // Each hung heartbeat is dropped in time for the next.
    expect(BEAT_TIMEOUT_MS).toBeLessThan(BEAT_MS);
    await beat();
    await beat();
    await beat();
    expect(calls.filter((c) => c.action === "heartbeat")).toHaveLength(3);

    // Round trips are left out while the upload test hangs, and kept once it is given up.
    hung.clear();
    hung.add("upload-test");
    now += UPLOAD_TEST_EVERY_MS;
    await beat();
    expect(calls.filter((c) => c.action === "upload-test")).toHaveLength(2);
    [500, 500, 500].forEach((ms) => r.addRtt(ms));
    await vi.advanceTimersByTimeAsync(UPLOAD_TIMEOUT_MS);
    [20, 20, 20].forEach((ms) => r.addRtt(ms));
    await beat();
    expect(calls.at(-1)).toMatchObject({ action: "heartbeat", body: { net: { rttMs: 20, jitterMs: 0 } } });
  });

  it("keeps offering until the platform has the offer, and sends a new time at once", async () => {
    answer.availability = "network";
    const r = reporter();
    r.offer(null);
    await vi.advanceTimersByTimeAsync(0);
    await beat();
    expect(calls.filter((c) => c.action !== "upload-test").map((c) => c.method)).toEqual(["PUT", "PUT"]);

    delete answer.availability;
    await beat();
    await beat();
    expect(calls.filter((c) => c.action !== "upload-test").map((c) => c.method)).toEqual([
      "PUT",
      "PUT",
      "PUT",
      "POST",
    ]);

    r.setUntil(Date.UTC(2026, 9, 3, 23));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toMatchObject({
      method: "PUT",
      body: { available: true, until: "2026-10-03T23:00:00.000Z" },
    });
  });

  it("hears who may play from every answer, and sends the owner's choice until the platform has it", async () => {
    const mika = { id: "c1", name: "mika_r", crewName: null, own: false, size: 3, state: "ready", pcs: 1 };
    const crew = { only: true, crews: [{ ...mika, plays: true }] };
    replies.availability = { id: "pc 1", status: "available", crew };
    replies.heartbeat = { id: "pc 1", status: "available", crew: { ...crew, only: false } };
    const onCrew = vi.fn();
    const r = reporter({ name: "Nova-01" }, { onCrew });
    r.offer(null);
    await vi.advanceTimersByTimeAsync(0);
    // Until the owner chooses, the offer leaves the choice to the platform.
    expect(calls[0]!.body).toEqual({ available: true, name: "Nova-01" });
    expect(onCrew).toHaveBeenLastCalledWith(crew);

    await beat();
    expect(onCrew).toHaveBeenLastCalledWith({ ...crew, only: false });

    r.setCrews(["c1", "c2"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: { available: true, crews: ["c1", "c2"] } });
    // A later offer, such as a new share-until time, leaves the platform's crews
    // alone: the PC may have been brought to another crew on the web since.
    r.setUntil(Date.UTC(2026, 9, 3, 23));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: { available: true } });
    expect(calls.at(-1)!.body).not.toHaveProperty("crews");
    // A new pick goes again.
    r.setCrews(["c2"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: { crews: ["c2"] } });
  });

  it("sends a refused choice again with the next offer, and the same choice once", async () => {
    const r = reporter({ name: "Nova-01" });
    r.offer(null);
    await vi.advanceTimersByTimeAsync(0);
    answer.availability = "network";
    r.setCrews(["c1"]);
    r.setCrews(["c1"]);
    await vi.advanceTimersByTimeAsync(0);
    const picks = () =>
      calls.filter((c) => c.action === "availability" && (c.body as { crews?: unknown }).crews);
    expect(picks()).toHaveLength(1);
    delete answer.availability;
    await beat();
    expect(picks()).toHaveLength(2);
    expect(picks().at(-1)).toMatchObject({ method: "PUT", body: { crews: ["c1"] } });
    await beat();
    expect(calls.at(-1)!.action).toBe("heartbeat");
    expect(picks()).toHaveLength(2);
  });

  it("does not send a refused section again until it changes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = reporter({ games: [730] });
    r.offer(null);
    await vi.advanceTimersByTimeAsync(0);
    answer.heartbeat = 400;
    r.update({ games: [0] });
    await beat();
    expect(calls.at(-1)).toMatchObject({ action: "heartbeat", body: { games: [0] } });
    expect(console.warn).toHaveBeenCalledWith(expect.any(String), "games must be a list");
    await beat();
    expect(calls.at(-1)!.body).toEqual({});
  });

  it("offers again after a refused offer, with its sections", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    answer.availability = 400;
    const r = reporter({ games: [730] });
    r.offer(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((c) => c.action === "upload-test")).toHaveLength(0);
    delete answer.availability;
    await beat();
    expect(calls.filter((c) => c.action !== "upload-test")).toEqual([
      { method: "PUT", action: "availability", keepalive: false, body: { available: true, games: [730] } },
      { method: "PUT", action: "availability", keepalive: false, body: { available: true, games: [730] } },
    ]);
    await beat();
    expect(calls.at(-1)).toMatchObject({ action: "heartbeat", body: {} });
  });

  it("takes the PC back and stops; the next offer waits for that", async () => {
    const r = reporter();
    r.offer(null);
    await vi.advanceTimersByTimeAsync(0);
    const withdrawn = r.withdraw({ keepalive: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toEqual({
      method: "PUT",
      action: "availability",
      keepalive: true,
      body: { available: false },
    });
    const count = calls.length;
    await beat();
    expect(calls).toHaveLength(count);

    // The next offer waits for the withdraw, so it cannot land first; a time set meanwhile goes with it.
    let release!: () => void;
    const next = reporter({}, { after: new Promise<void>((resolve) => (release = resolve)) });
    next.offer(null);
    next.setUntil(Date.UTC(2026, 9, 3, 23));
    await vi.advanceTimersByTimeAsync(BEAT_MS * 2);
    expect(calls).toHaveLength(count);
    await withdrawn;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[count]).toMatchObject({
      method: "PUT",
      body: { available: true, until: "2026-10-03T23:00:00.000Z" },
    });
    void next.withdraw();
  });

  it("gives up a hung withdraw, so the next offer still goes out", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const answering = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url: string, init: RequestInit) => {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      if (body?.available !== false) return answering(url, init);
      calls.push({ method: init.method!, action: "availability", body, keepalive: false });
      return new Promise<Response>((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
      );
    });
    const r = reporter();
    r.offer(null);
    await vi.advanceTimersByTimeAsync(0);
    const withdrawn = r.withdraw();
    const next = reporter({}, { after: withdrawn });
    next.offer(null);
    await vi.advanceTimersByTimeAsync(0);
    const count = calls.length;

    await vi.advanceTimersByTimeAsync(BEAT_TIMEOUT_MS);
    await expect(withdrawn).resolves.toBeUndefined();
    expect(calls[count]).toMatchObject({ method: "PUT", body: { available: true } });
    next.withdraw().catch(() => {});
    await vi.advanceTimersByTimeAsync(BEAT_TIMEOUT_MS);
    fetch.mockImplementation(answering);
  });

  it("sends the withdraw only after an offer still under way has settled", async () => {
    const answering = fetch.getMockImplementation()!;
    let release!: () => void;
    const r = reporter();
    r.offer(null);
    await vi.advanceTimersByTimeAsync(0);
    // A new time starts an offer, which the platform is slow to answer.
    fetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      calls.push({
        method: init.method!,
        action: "availability",
        body: JSON.parse(init.body as string),
        keepalive: false,
      });
      await new Promise<void>((resolve) => (release = resolve));
      return new Response("{}", { status: 200 });
    });
    r.setUntil(Date.UTC(2026, 9, 3, 23));
    const withdrawn = r.withdraw();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toMatchObject({ body: { available: true } });

    fetch.mockImplementation(answering);
    release();
    await withdrawn;
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: { available: false } });
  });

  it("sends a keepalive withdraw at once, even with an offer still under way", async () => {
    const answering = fetch.getMockImplementation()!;
    let release!: () => void;
    const r = reporter();
    r.offer(null);
    await vi.advanceTimersByTimeAsync(0);
    fetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      calls.push({
        method: init.method!,
        action: "availability",
        body: JSON.parse(init.body as string),
        keepalive: false,
      });
      await new Promise<void>((resolve) => (release = resolve));
      return new Response("{}", { status: 200 });
    });
    r.setUntil(Date.UTC(2026, 9, 3, 23));
    const withdrawn = r.withdraw({ keepalive: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toEqual({
      method: "PUT",
      action: "availability",
      keepalive: true,
      body: { available: false },
    });
    await withdrawn;

    fetch.mockImplementation(answering);
    release();
  });
});

describe("who may play", () => {
  it("reads every crew the owner is in, and whether this PC plays for it", () => {
    const friday = {
      id: "c1",
      name: "mika_r",
      crewName: "Friday Squad",
      own: false,
      size: 3,
      state: "ready",
      pcs: 1,
      plays: true,
    };
    const own = {
      id: "c2",
      name: "nova",
      crewName: null,
      own: true,
      size: 4,
      state: "no-pc",
      pcs: 0,
      plays: false,
    };
    expect(crewOf({ crew: { only: true, crews: [friday, own] } })).toEqual({
      only: true,
      crews: [friday, own],
    });
    expect(crewOf({ crew: { only: "yes", crews: [] } })).toBeNull();
    expect(crewOf({})).toBeNull();
  });

  it("reads an older server's crews: playing for a crew-only PC, and not to be picked without an id", () => {
    const old = { name: "mika_r", own: false, size: 3 };
    const read = { id: null, name: "mika_r", crewName: null, own: false, size: 3, state: null, pcs: null };
    expect(crewOf({ crew: { only: true, crews: [old] } })).toEqual({
      only: true,
      crews: [{ ...read, plays: true }],
    });
    expect(crewOf({ crew: { only: false, crews: [old, { name: 7 }] } })).toEqual({
      only: false,
      crews: [{ ...read, plays: false }],
    });
  });

  it("makes the PC crew-only, playing for exactly the crews picked", () => {
    const crew = crewOf({
      crew: {
        only: false,
        crews: [
          { id: "c1", name: "mika_r", own: false, size: 3, plays: true },
          { id: "c2", name: null, own: false, size: 2, plays: false },
          { name: "old", own: false, size: 2 },
        ],
      },
    })!;
    expect(playingFor(crew, ["c2"]).only).toBe(true);
    expect(playingFor(crew, ["c2"]).crews.map((c) => c.plays)).toEqual([false, true, false]);
  });
});
