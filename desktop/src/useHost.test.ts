// This PC's view-model, over a fake screen share and a fake preload bridge:
// what the app reads, what the owner chooses, and how the live session reads.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PcRead, SteamGame } from "../pc.cjs";
import type { SteamRead } from "../steam.cjs";
import type { HostBridge } from "./bridge";
import { DEMAND_EVERY_MS } from "./demand";
import { untilChoices } from "./model";
import { BUSY_MS, IDLE_MS } from "./useSteam";
import type { ShareEvents } from "./useScreenShare";

type Share = {
  stream: MediaStream | null;
  pc: RTCPeerConnection | null;
  peerHere: boolean;
  claim: { sessionId: string; appid: number; minutes: number; at: number } | null;
  connection: "connecting" | "registered" | "offline" | null;
  lastContact: number | null;
  offlineSince: number | null;
  error: string | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
};

const share: Share = {} as Share;
let events: ShareEvents = {};
/** The bridge's listener for installed games changing. */
let gamesChanged: ((games: SteamGame[]) => void) | null = null;
/** Every Host API call the app made: method, path and parsed body. */
let calls: { method: string; path: string; body: Record<string, unknown> | null; keepalive: boolean }[] = [];

vi.mock("./useScreenShare", () => ({
  useScreenShare: (e: ShareEvents) => {
    events = e;
    return share;
  },
}));

const { useHost } = await import("./useHost");
const { trayDo } = await import("./App");

const STREAM = {} as MediaStream;
const STEAM_READY: SteamRead = {
  installed: true,
  path: "C:\\Program Files (x86)\\Steam",
  running: true,
  signedIn: true,
  installs: [],
};
const DOTA = { appid: 570, name: "Dota 2", phase: "downloading" as const, done: 1, total: 4 };
const NOW = new Date(2026, 8, 24, 21, 0).getTime();

function resetShare() {
  Object.assign(share, {
    stream: null,
    pc: null,
    peerHere: false,
    claim: null,
    connection: null,
    lastContact: null,
    offlineSince: null,
    error: null,
    start: vi.fn(async () => {
      share.stream = STREAM;
      return true;
    }),
    stop: vi.fn(() => {
      share.stream = null;
    }),
    restart: vi.fn(async () => true),
  });
}

const PC: PcRead = {
  hardware: {
    gpu: "NVIDIA GeForce RTX 4080",
    vramMb: 16_384,
    ramMb: 32_768,
    cpu: "Ryzen 7 7800X3D",
    cores: 8,
    encoders: ["h264", "hevc", "av1"],
    display: { width: 2560, height: 1440, refreshHz: 144 },
  },
  controls: ["kb", "mouse"],
  games: [
    { appid: 730, name: "Counter-Strike 2" },
    { appid: 1245620, name: "ELDEN RING" },
  ],
};

function fakeBridge(idle = 600): HostBridge {
  return {
    loadMachineKey: vi.fn(async () => "test-machine-key"),
    saveMachineKey: vi.fn(async () => true),
    readPc: vi.fn(async () => PC),
    onGamesChanged: vi.fn((listener) => {
      gamesChanged = listener;
      return () => {
        gamesChanged = null;
      };
    }),
    readSteam: vi.fn(async (): Promise<SteamRead> => STEAM_READY),
    installSteam: vi.fn(async () => null),
    secondsSinceInput: vi.fn(async () => idle),
    setGlance: vi.fn(),
    onTrayAction: vi.fn(() => () => {}),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  localStorage.setItem("swiff.signalingUrl", "signal.example");
  resetShare();
  (window as { swiffHost?: HostBridge }).swiffHost = fakeBridge();
  calls = [];
  // The Host API's report routes answer; demand has no platform to ask, so
  // each test that wants it answers for it.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/demand")) throw new TypeError("no network in tests");
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ method: init.method ?? "GET", path, body, keepalive: Boolean(init.keepalive) });
      return new Response(path.endsWith("/upload-test") ? null : "{}", {
        status: path.endsWith("/upload-test") ? 204 : 200,
      });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as { swiffHost?: HostBridge }).swiffHost;
});

/** The Host API calls made, upload tests left out. */
const reports = () => calls.filter((c) => !c.path.endsWith("/upload-test"));

/** Let the bridge's promises and the state they set land. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

/** Render the hook and let the bridge's reads land. */
async function host() {
  const hook = renderHook(() => useHost());
  await settle();
  expect(hook.result.current.view.pc.reading).toBe(false);
  expect(hook.result.current.view.connection.machineKey).toBe("test-machine-key");
  return hook;
}

describe("useHost", () => {
  it("reads this PC, and offers every installed game until the owner turns one off", async () => {
    const { result } = await host();
    const { view } = result.current;
    expect(view.demo).toBe(false);
    expect(view.pc.hardware?.gpu).toBe("NVIDIA GeForce RTX 4080");
    expect(view.games.installed.map((g) => g.appid)).toEqual([730, 1245620]);
    expect(view.games.offered).toEqual([730, 1245620]);

    act(() => result.current.actions.toggleOffer!(730));
    expect(result.current.view.games.offered).toEqual([1245620]);
    expect(localStorage.getItem("swiff.notOffered")).toBe("730");
    act(() => result.current.actions.toggleOffer!(730));
    expect(result.current.view.games.offered).toEqual([730, 1245620]);
    // Nothing the platform does not report.
    expect([view.rate, view.standing, view.earnings, view.earlyEnd]).toEqual([null, null, null, null]);
  });

  it("shows what renters ask for, read with the machine key, named from this PC where the platform cannot", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ windowMinutes: 60, games: [{ appid: 730, name: null, looking: 2, waiting: 1 }] }),
    );
    vi.stubGlobal("fetch", fetch);
    const { result } = await host();
    expect(fetch).toHaveBeenCalledWith("https://signal.example/api/machines/gaming-pc-1/demand", {
      headers: { authorization: "Bearer test-machine-key" },
    });
    expect(result.current.view.games.demand).toEqual([
      { appid: 730, name: "Counter-Strike 2", looking: 2, waiting: 1 },
    ]);

    // A read that fails keeps the last one; the next good one replaces it.
    fetch.mockRejectedValueOnce(new TypeError("offline"));
    await act(async () => void vi.advanceTimersByTime(DEMAND_EVERY_MS));
    await settle();
    expect(result.current.view.games.demand).toHaveLength(1);
    fetch.mockResolvedValueOnce(Response.json({ windowMinutes: 60, games: [] }));
    await act(async () => void vi.advanceTimersByTime(DEMAND_EVERY_MS));
    await settle();
    expect(result.current.view.games.demand).toEqual([]);
  });

  it("reads Steam, and this PC's games again once Steam finishes installing one", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const bridge = (window as { swiffHost?: HostBridge }).swiffHost!;
    vi.mocked(bridge.readSteam)
      .mockResolvedValueOnce({ ...STEAM_READY, installs: [DOTA] })
      .mockResolvedValue(STEAM_READY);
    const { result } = await host();
    expect(result.current.view.steam.status).toEqual({ installed: true, running: true, signedIn: true });
    expect(result.current.view.steam.installs).toEqual([DOTA]);
    expect(bridge.readPc).toHaveBeenCalledTimes(1);

    await act(async () => void vi.advanceTimersByTime(BUSY_MS));
    await settle();
    expect(result.current.view.steam.installs).toEqual([]);
    expect(bridge.readPc).toHaveBeenCalledTimes(2);
  });

  it("follows a game sent to Steam until Steam starts installing it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const bridge = (window as { swiffHost?: HostBridge }).swiffHost!;
    const { result } = await host();
    act(() => result.current.actions.askInstall(570));
    expect(result.current.view.steam.asked).toEqual([570]);

    // Nothing was under way at the last read: the next comes at the idle pace.
    vi.mocked(bridge.readSteam).mockResolvedValue({ ...STEAM_READY, installs: [DOTA] });
    await act(async () => void vi.advanceTimersByTime(IDLE_MS));
    await settle();
    expect(result.current.view.steam.asked).toEqual([]);
    expect(result.current.view.steam.installs).toEqual([DOTA]);
  });

  it("opens Valve's installer when asked, and says why when it cannot", async () => {
    const bridge = (window as { swiffHost?: HostBridge }).swiffHost!;
    vi.mocked(bridge.readSteam).mockResolvedValue({ ...STEAM_READY, installed: false, path: null });
    const { result } = await host();
    expect(result.current.view.steam.status?.installed).toBe(false);

    vi.mocked(bridge.installSteam).mockResolvedValueOnce("Steam's installer could not be opened. Try again.");
    await act(async () => result.current.actions.installSteam());
    await settle();
    expect(result.current.view.steam.installer).toEqual({
      kind: "failed",
      error: "Steam's installer could not be opened. Try again.",
    });

    await act(async () => result.current.actions.installSteam());
    await settle();
    expect(result.current.view.steam.installer).toEqual({ kind: "opened" });
    expect(bridge.installSteam).toHaveBeenCalledTimes(2);
  });

  it("picks up games installed while it runs, offered until turned off", async () => {
    localStorage.setItem("swiff.notOffered", "1245620");
    const { result } = await host();
    expect(result.current.view.games.offered).toEqual([730]);

    act(() => gamesChanged!([...PC.games, { appid: 1091500, name: "Cyberpunk 2077" }]));
    expect(result.current.view.games.installed.map((g) => g.appid)).toEqual([730, 1245620, 1091500]);
    expect(result.current.view.games.offered).toEqual([730, 1091500]);
  });

  it("offers this PC to the platform while it shares, beats every 5 s, and takes it back on pause", async () => {
    localStorage.setItem("swiff.name", "Nova-01");
    const { result, rerender } = await host();
    const until = NOW + 4 * 3_600_000;
    act(() => result.current.actions.plan(until));
    await act(async () => result.current.actions.goLive());
    rerender();
    await settle();

    expect(reports()).toEqual([
      {
        method: "PUT",
        path: "/api/machines/gaming-pc-1/availability",
        keepalive: false,
        body: {
          available: true,
          until: new Date(until).toISOString(),
          name: "Nova-01",
          hardware: { ...PC.hardware },
          controls: ["kb", "mouse"],
          games: [730, 1245620],
        },
      },
    ]);
    expect(calls.some((c) => c.path === "/api/machines/gaming-pc-1/upload-test")).toBe(true);

    // A plain beat says nothing new; a game turned off goes with the next one.
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect(reports().at(-1)).toMatchObject({
      method: "POST",
      path: "/api/machines/gaming-pc-1/heartbeat",
      body: {},
    });
    act(() => result.current.actions.toggleOffer!(730));
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect(reports().at(-1)).toMatchObject({ method: "POST", body: { games: [1245620] } });

    // Round trips on the signaling socket, with the upload test, make the net figures.
    act(() => [12, 14, 13].forEach((ms) => events.onRtt?.(ms)));
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect(reports().at(-1)!.body).toMatchObject({ net: { rttMs: 13, jitterMs: 1.5 } });
    expect(result.current.view.pc.hardware?.upMbps).toBeGreaterThan(0);

    // A new share-until time is sent at once.
    act(() => result.current.actions.setUntil(null));
    await settle();
    expect(reports().at(-1)).toMatchObject({ method: "PUT", body: { available: true } });
    expect(reports().at(-1)!.body).not.toHaveProperty("until");

    act(() => result.current.actions.pause());
    rerender();
    await settle();
    expect(reports().at(-1)).toMatchObject({ method: "PUT", body: { available: false } });
    const sent = calls.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(calls).toHaveLength(sent);
  });

  it("turns down a claim for a game the owner does not offer", async () => {
    const { result } = await host();
    const claim = { sessionId: "s1", appid: 730, minutes: 45 };
    expect(events.acceptClaim?.(claim)).toBe(true);
    act(() => result.current.actions.toggleOffer!(730));
    expect(events.acceptClaim?.(claim)).toBe(false);
    expect(events.acceptClaim?.({ ...claim, appid: 1245620 })).toBe(true);
  });

  it("takes this PC back when the app quits, unless a player is on", async () => {
    const { result, rerender } = await host();
    await act(async () => result.current.actions.goLive());
    rerender();
    await settle();
    share.claim = { sessionId: "s1", appid: 730, minutes: 45, at: NOW };
    rerender();
    window.dispatchEvent(new Event("pagehide"));
    expect(reports().filter((c) => c.body?.available === false)).toEqual([]);

    share.claim = null;
    rerender();
    window.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(reports().at(-1)).toMatchObject({ method: "PUT", keepalive: true, body: { available: false } });
  });

  it("keeps the default end time the ~4 hours choice from now until the owner picks one", async () => {
    const { result } = await host();
    expect(result.current.view.plan).toBe(untilChoices(NOW)[1]!.at);

    act(() => void vi.advanceTimersByTime(5 * 3_600_000));
    const later = result.current.view.now;
    expect(result.current.view.plan).toBe(untilChoices(later)[1]!.at);
    expect(result.current.view.plan).toBeGreaterThan(later);

    act(() => result.current.actions.plan(null));
    act(() => void vi.advanceTimersByTime(3_600_000));
    expect(result.current.view.plan).toBeNull();
  });

  it("goes live with the saved connection and the planned end time", async () => {
    const { result, rerender } = await host();
    const until = NOW + 4 * 3_600_000;
    act(() => result.current.actions.plan(until));
    await act(async () => result.current.actions.goLive());
    expect(share.start).toHaveBeenCalledWith("signal.example", {
      machineId: "gaming-pc-1",
      machineKey: "test-machine-key",
    });

    share.connection = "registered";
    rerender();
    expect(result.current.view.live).toMatchObject({ kind: "waiting", until, registered: true });
  });

  it("stops at the end time when no session is running", async () => {
    const { result, rerender } = await host();
    const until = NOW + 2 * 3_600_000;
    act(() => result.current.actions.plan(until));
    await act(async () => result.current.actions.goLive());
    rerender();

    act(() => void vi.advanceTimersByTime(2 * 3_600_000 + 5_000));
    expect(share.stop).toHaveBeenCalled();
    rerender();
    expect(result.current.view.live).toEqual({
      kind: "off",
      note: "Sharing stopped at 23:00, as you chose.",
    });
  });

  it("lets a session that started before the end time run to its end", async () => {
    const { result, rerender } = await host();
    act(() => result.current.actions.plan(NOW + 3_600_000));
    await act(async () => result.current.actions.goLive());
    share.claim = { sessionId: "s1", appid: 1245620, minutes: 90, at: NOW + 50 * 60_000 };
    rerender();

    act(() => void vi.advanceTimersByTime(65 * 60_000));
    expect(share.stop).not.toHaveBeenCalled();
    expect(result.current.view.live).toMatchObject({
      kind: "session",
      claim: { name: "ELDEN RING", rate: null },
    });

    share.claim = null;
    act(() => events.onClaimOver?.());
    expect(share.stop).toHaveBeenCalledOnce();
    rerender();
    expect(result.current.view.live).toMatchObject({
      kind: "off",
      note: "Sharing stopped at 22:00, as you chose.",
    });
  });

  it("counts a claimed session once for today", async () => {
    const { result, rerender } = await host();
    await act(async () => result.current.actions.goLive());
    share.claim = { sessionId: "s1", appid: 730, minutes: 45, at: NOW };
    rerender();
    rerender();
    expect(result.current.view.sessionsToday).toBe(1);
  });

  it("pauses after the session when new sessions are stopped", async () => {
    const { result, rerender } = await host();
    await act(async () => result.current.actions.goLive());
    share.claim = { sessionId: "s1", appid: 730, minutes: 45, at: NOW };
    rerender();
    act(() => result.current.actions.setStopNew(true));
    expect(result.current.view.live).toMatchObject({ kind: "session", stopNew: true });

    share.claim = null;
    act(() => events.onClaimOver?.());
    rerender();
    expect(share.stop).toHaveBeenCalledOnce();
    expect(result.current.view.live).toEqual({ kind: "paused", at: NOW });
  });

  it("pauses and resumes", async () => {
    const { result, rerender } = await host();
    await act(async () => result.current.actions.goLive());
    act(() => result.current.actions.pause());
    rerender();
    expect(result.current.view.live).toEqual({ kind: "paused", at: NOW });

    await act(async () => result.current.actions.resume());
    expect(share.start).toHaveBeenCalledTimes(2);
    rerender();
    expect(result.current.view.live.kind).toBe("waiting");
  });

  it("reads a dropped connection as offline while waiting, and retries", async () => {
    const { result, rerender } = await host();
    await act(async () => result.current.actions.goLive());
    Object.assign(share, { connection: "offline", offlineSince: NOW + 60_000, lastContact: NOW });
    rerender();
    expect(result.current.view.live).toEqual({
      kind: "offline",
      since: NOW + 60_000,
      lastContact: NOW,
      until: expect.any(Number),
    });
    act(() => result.current.actions.retry());
    expect(share.restart).toHaveBeenCalledOnce();
  });

  it("ignores a pause or a retry that no longer fits, so a player's session runs on", async () => {
    const { result, rerender } = await host();
    await act(async () => result.current.actions.goLive());
    share.claim = { sessionId: "s1", appid: 730, minutes: 45, at: NOW };
    rerender();
    expect(result.current.view.live.kind).toBe("session");

    // The tray still showed "Pause sharing" or "Try again" when the claim came.
    act(() => trayDo(result.current, "pause"));
    act(() => trayDo(result.current, "retry"));
    act(() => result.current.actions.pause());
    act(() => result.current.actions.retry());
    await act(async () => result.current.actions.resume());
    rerender();
    expect(share.stop).not.toHaveBeenCalled();
    expect(share.restart).not.toHaveBeenCalled();
    expect(share.start).toHaveBeenCalledOnce();
    expect(result.current.view.live.kind).toBe("session");

    act(() => trayDo(result.current, "stop-new"));
    expect(result.current.view.live).toMatchObject({ kind: "session", stopNew: true });
  });

  it("stays offline while the client retries, until Swiff confirms the room again", async () => {
    const { result, rerender } = await host();
    await act(async () => result.current.actions.goLive());
    Object.assign(share, { connection: "offline", offlineSince: NOW + 60_000, lastContact: NOW });
    rerender();
    // Each retry opens a socket: still offline, not "Connecting to Swiff" and back.
    Object.assign(share, { connection: "connecting" });
    rerender();
    expect(result.current.view.live).toMatchObject({ kind: "offline", since: NOW + 60_000 });

    Object.assign(share, { connection: "registered", offlineSince: null, lastContact: NOW + 90_000 });
    rerender();
    expect(result.current.view.live).toMatchObject({ kind: "waiting", registered: true });
  });

  it("knows the owner sat down when the keyboard is touched during a session", async () => {
    (window as { swiffHost?: HostBridge }).swiffHost = fakeBridge(1);
    const { result, rerender } = await host();
    await act(async () => result.current.actions.goLive());
    share.claim = { sessionId: "s1", appid: 730, minutes: 45, at: NOW };
    rerender();
    await settle();
    expect(result.current.view.live).toMatchObject({ kind: "session", atPc: true });
  });

  it("saves the connection, and keeps the key only where the OS encrypts it", async () => {
    const bridge = fakeBridge();
    bridge.saveMachineKey = vi.fn(async () => false);
    (window as { swiffHost?: HostBridge }).swiffHost = bridge;
    const { result } = await host();
    await act(async () =>
      result.current.actions.saveConnection({
        url: "otter.example",
        machineId: "pc-2",
        machineKey: "k2",
        name: " Nova-01 ",
      }),
    );
    expect(localStorage.getItem("swiff.signalingUrl")).toBe("otter.example");
    expect(localStorage.getItem("swiff.machineId")).toBe("pc-2");
    expect(localStorage.getItem("swiff.name")).toBe("Nova-01");
    expect(result.current.view.machine).toBe(" Nova-01 ".trim());
    expect(JSON.stringify({ ...localStorage })).not.toContain("k2");
    expect(bridge.saveMachineKey).toHaveBeenCalledWith("k2");
    expect(result.current.view.connection.notice).toBe(
      "This system cannot encrypt the key, so it was not saved.",
    );
    expect(share.start).toHaveBeenCalledWith("otter.example", { machineId: "pc-2", machineKey: "k2" });
  });

  it("keeps the end time in effect when the connection is saved while offline or paused", async () => {
    const { result, rerender } = await host();
    const until = untilChoices(NOW)[1]!.at;
    await act(async () => result.current.actions.goLive());
    act(() => void vi.advanceTimersByTime(3_600_000));
    Object.assign(share, { connection: "offline", offlineSince: Date.now(), lastContact: NOW });
    rerender();
    expect(result.current.view.live).toMatchObject({ kind: "offline", until });

    await act(async () =>
      result.current.actions.saveConnection({ url: "otter.example", machineId: "pc-2", machineKey: "k2" }),
    );
    Object.assign(share, { connection: "registered", offlineSince: null });
    rerender();
    expect(result.current.view.live).toMatchObject({ kind: "waiting", until });

    act(() => result.current.actions.pause());
    act(() => void vi.advanceTimersByTime(3_600_000));
    rerender();
    await act(async () =>
      result.current.actions.saveConnection({ url: "otter.example", machineId: "pc-3", machineKey: "k3" }),
    );
    rerender();
    expect(result.current.view.live).toMatchObject({ kind: "waiting", until });
  });
});
