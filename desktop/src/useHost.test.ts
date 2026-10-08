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
import { rentalOf, type RentalPlan } from "../rental.cjs";
import FACTS from "./test/rental-facts.json";
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

// Sharing this Windows desktop is a development path (devShare.ts): these tests
// drive it, unless one turns it off as in the build hosts download.
const devShare = vi.hoisted(() => ({ on: true }));
vi.mock("./devShare", () => ({
  get WINDOWS_SHARE() {
    return devShare.on;
  },
}));

vi.mock("./useScreenShare", () => ({
  useScreenShare: (e: ShareEvents) => {
    events = e;
    return share;
  },
}));

const { CREW_RETRY_MS, useHost } = await import("./useHost");
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
    readRental: vi.fn(async () => null),
    planRental: vi.fn(async () => null),
    runRental: vi.fn(async () => null),
    restartRental: vi.fn(async () => false),
    answerRentalKey: vi.fn(async () => false),
    saveRecoveryKey: vi.fn(async () => true),
    openBitLocker: vi.fn(async () => true),
    seenRemoval: vi.fn(async () => true),
    reportRental: vi.fn(async () => null),
    onRentalEvent: vi.fn(() => () => {}),
    downloadImage: vi.fn(async () => null),
    onImageProgress: vi.fn(() => () => {}),
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

  it("keeps a choice of crews made off offer, shows it at once, and offers with it on going live", async () => {
    // The platform answers each offer and beat with who may play, as it holds it.
    let playing = ["c1"];
    const crews = () =>
      ["c1", "c2"].map((id) => ({
        id,
        name: "Alex",
        crewName: null,
        own: false,
        size: 2,
        plays: playing.includes(id),
      }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/demand")) throw new TypeError("no network in tests");
        if (path.endsWith("/upload-test")) return new Response(null, { status: 204 });
        const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
        calls.push({ method: init.method ?? "GET", path, body, keepalive: Boolean(init.keepalive) });
        if (Array.isArray(body?.crews)) playing = body.crews;
        return Response.json({ crew: { only: true, crews: crews() } });
      }),
    );
    const plays = () => result.current.view.crew?.crews.map((c) => c.plays);
    const { result, rerender } = await host();
    await act(async () => result.current.actions.goLive());
    rerender();
    await settle();
    expect(plays()).toEqual([true, false]);

    act(() => result.current.actions.pause());
    rerender();
    await settle();
    act(() => result.current.actions.setCrews(["c2"]));
    expect(plays()).toEqual([false, true]);

    await act(async () => result.current.actions.resume());
    rerender();
    await settle();
    const offers = reports().filter((c) => c.method === "PUT" && c.body?.available === true);
    expect(offers).toHaveLength(2);
    expect(offers[0]!.body).not.toHaveProperty("crews");
    expect(offers[1]!.body).toMatchObject({ crews: ["c2"] });
    expect(plays()).toEqual([false, true]);
  });

  describe("who can play, in rental mode", () => {
    /** The platform's answers, in turn: who may play, a failure, or one held until the test lets it land. */
    type Answer = "ok" | "fail" | ((land: (ok: boolean) => void) => void);
    let answers: Answer[];
    let playing: string[];
    /** Who may play, as the platform says it: crew-only, playing for Alex's crew or for none. */
    const crewOf = (plays: boolean) => ({
      only: true,
      crews: [{ id: "c1", name: "Alex", crewName: null, own: false, size: 2, state: null, pcs: null, plays }],
    });
    const READY = {
      ...rentalOf(
        {
          ...structuredClone(FACTS),
          install: {
            complete: true,
            disk: 0,
            bootEntry: { partition: null, path: "\\EFI\\swiff\\shimx64.efi" },
            partitions: [],
            shrink: null,
            mok: true,
          },
        },
        [],
      ),
      key: { state: "confirmed" as const, code: null },
    };

    beforeEach(() => {
      devShare.on = false;
      answers = [];
      playing = ["c1"];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          const path = new URL(url).pathname;
          if (path.endsWith("/demand")) throw new TypeError("no network in tests");
          const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
          calls.push({ method: init.method ?? "GET", path, body, keepalive: Boolean(init.keepalive) });
          const answer = answers.shift() ?? "ok";
          const ok =
            typeof answer === "function"
              ? await new Promise<boolean>((land) => answer(land))
              : answer === "ok";
          if (!ok) throw new TypeError("offline");
          if (Array.isArray(body?.crews)) playing = body.crews;
          return Response.json({ crew: crewOf(playing.includes("c1")) });
        }),
      );
    });
    afterEach(() => {
      devShare.on = true;
    });

    /** The hook on a PC whose rental mode becomes ready to go live. */
    async function ready() {
      const bridge = (window as { swiffHost?: HostBridge }).swiffHost!;
      const hook = await host();
      bridge.readRental = vi.fn(async () => READY);
      act(() => hook.result.current.actions.checkRental());
      await settle();
      return hook;
    }

    it("reads and sets it with the PC off offer in Windows", async () => {
      const { result } = await host();
      // Not ready to go live yet: the platform is not asked.
      expect(result.current.view.crew).toBeNull();
      expect(reports()).toEqual([]);
      const bridge = (window as { swiffHost?: HostBridge }).swiffHost!;
      bridge.readRental = vi.fn(async () => READY);
      act(() => result.current.actions.checkRental());
      await settle();
      expect(reports()).toEqual([
        {
          method: "PUT",
          path: "/api/machines/gaming-pc-1/availability",
          body: { available: false },
          keepalive: false,
        },
      ]);
      expect(result.current.view.crew).toEqual(crewOf(true));

      act(() => result.current.actions.setCrews([]));
      expect(result.current.view.crew?.crews[0]!.plays).toBe(false);
      await settle();
      expect(reports().at(-1)!.body).toEqual({ available: false, crews: [] });
      expect(result.current.view.crew?.crews[0]!.plays).toBe(false);
      expect(result.current.view.crewNote).toBeNull();
      // Nothing offers this PC from Windows.
      expect(reports().some((c) => c.body?.available === true)).toBe(false);
    });

    it("puts a choice that did not save back to the platform's, and says so", async () => {
      const { result } = await ready();
      answers.push("fail");
      act(() => result.current.actions.setCrews([]));
      expect(result.current.view.crew?.crews[0]!.plays).toBe(false);
      await settle();
      expect(result.current.view.crew).toEqual(crewOf(true));
      expect(result.current.view.crewNote).toBe("Couldn't save who can play. Try again.");

      act(() => result.current.actions.setCrews([]));
      expect(result.current.view.crewNote).toBeNull();
      await settle();
      expect(result.current.view.crew?.crews[0]!.plays).toBe(false);
      expect(result.current.view.crewNote).toBeNull();
    });

    it("reads it again when the first read failed: once after a while, and on Check again", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
      answers.push("fail", "fail");
      const { result } = await ready();
      expect(result.current.view.crew).toBeNull();
      await act(async () => void (await vi.advanceTimersByTimeAsync(CREW_RETRY_MS)));
      await settle();
      expect(reports()).toHaveLength(2);
      expect(result.current.view.crew).toBeNull();
      // Retried once only; Check again asks once more.
      await act(async () => void (await vi.advanceTimersByTimeAsync(CREW_RETRY_MS * 3)));
      expect(reports()).toHaveLength(2);
      act(() => result.current.actions.checkRental());
      await settle();
      expect(result.current.view.crew).toEqual(crewOf(true));
      expect(result.current.view.crewNote).toBeNull();
    });

    it("sends no read once Check again got the answer, so none can overtake the owner's choice", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
      answers.push("fail");
      const { result } = await ready();
      expect(result.current.view.crew).toBeNull();
      act(() => result.current.actions.checkRental());
      await settle();
      expect(result.current.view.crew).toEqual(crewOf(true));

      let set: (ok: boolean) => void = () => {};
      answers.push((land) => (set = land));
      act(() => result.current.actions.setCrews([]));
      await settle();
      const sent = reports().length;
      await act(async () => void (await vi.advanceTimersByTimeAsync(CREW_RETRY_MS * 2)));
      act(() => result.current.actions.checkRental());
      await settle();
      expect(reports()).toHaveLength(sent);
      set(true);
      await settle();
      expect(playing).toEqual([]);
      expect(result.current.view.crew?.crews[0]!.plays).toBe(false);
      expect(result.current.view.crewNote).toBeNull();
    });

    it("shows the answer to the owner's latest choice, whatever order the answers land in", async () => {
      const { result } = await ready();
      let first: (ok: boolean) => void = () => {};
      answers.push((land) => (first = land));
      act(() => result.current.actions.setCrews([]));
      act(() => result.current.actions.setCrews(["c1"]));
      await settle();
      expect(result.current.view.crew?.crews[0]!.plays).toBe(true);
      first(true);
      await settle();
      expect(result.current.view.crew?.crews[0]!.plays).toBe(true);
    });

    it("goes back to a choice the platform took after a newer one did not save", async () => {
      const { result } = await ready();
      let first: (ok: boolean) => void = () => {};
      let second: (ok: boolean) => void = () => {};
      answers.push(
        (land) => (first = land),
        (land) => (second = land),
      );
      act(() => result.current.actions.setCrews([]));
      act(() => result.current.actions.setCrews(["c1"]));
      await settle();
      first(true);
      await settle();
      second(false);
      await settle();
      expect(playing).toEqual([]);
      expect(result.current.view.crew?.crews[0]!.plays).toBe(false);
      expect(result.current.view.crewNote).toBe("Couldn't save who can play. Try again.");
    });

    it("shows a choice the platform took late, after a newer one already failed", async () => {
      const { result } = await ready();
      let first: (ok: boolean) => void = () => {};
      answers.push((land) => (first = land), "fail");
      act(() => result.current.actions.setCrews([]));
      act(() => result.current.actions.setCrews(["c1"]));
      await settle();
      expect(result.current.view.crew?.crews[0]!.plays).toBe(true);
      expect(result.current.view.crewNote).toBe("Couldn't save who can play. Try again.");
      first(true);
      await settle();
      expect(playing).toEqual([]);
      expect(result.current.view.crew?.crews[0]!.plays).toBe(false);
      expect(result.current.view.crewNote).toBe("Couldn't save who can play. Try again.");
    });

    it("lets nothing still under way for the last PC touch the new one's reads", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
      let last: (ok: boolean) => void = () => {};
      answers.push((land) => (last = land), "fail");
      const { result } = await ready();
      expect(reports().at(-1)!.path).toBe("/api/machines/gaming-pc-1/availability");
      await act(async () =>
        result.current.actions.saveConnection({
          url: "signal.example",
          machineId: "pc-2",
          machineKey: "k2",
          name: "",
        }),
      );
      await settle();
      expect(result.current.view.crew).toBeNull();
      last(true);
      await settle();
      expect(result.current.view.crew).toBeNull();
      const sent = reports().length;
      await act(async () => void (await vi.advanceTimersByTimeAsync(CREW_RETRY_MS)));
      await settle();
      expect(reports()).toHaveLength(sent + 1);
      expect(reports().at(-1)!.path).toBe("/api/machines/pc-2/availability");
      expect(result.current.view.crew).toEqual(crewOf(true));
    });

    it("forgets the last PC's crew when the connection changes, and reads the new one again", async () => {
      const { result } = await ready();
      expect(result.current.view.crew).toEqual(crewOf(true));
      answers.push("fail");
      await act(async () =>
        result.current.actions.saveConnection({
          url: "signal.example",
          machineId: "pc-2",
          machineKey: "k2",
          name: "",
        }),
      );
      await settle();
      expect(reports().at(-1)!.path).toBe("/api/machines/pc-2/availability");
      expect(result.current.view.crew).toBeNull();
      expect(result.current.view.crewNote).toBeNull();
      act(() => result.current.actions.checkRental());
      await settle();
      expect(reports().at(-1)!.path).toBe("/api/machines/pc-2/availability");
      expect(result.current.view.crew).toEqual(crewOf(true));
    });
  });

  describe("Go live's TPM registration", () => {
    const EK = { ek: true, certificate: "QUFB", intermediates: [] as string[] };
    const ONCE = {
      kind: "once",
      steps: [{ id: "ek", title: "Read", confirm: null, commands: [], ops: [{ op: "ek" }] }],
    } as unknown as RentalPlan;
    /** Every Host API ask Go live made, as "METHOD url". */
    let asked: string[];

    beforeEach(() => {
      devShare.on = false;
      localStorage.setItem("swiff.machineId", "geekom");
      asked = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (!url.endsWith("/ek")) throw new TypeError("no network in tests");
          asked.push(`${init?.method ?? "GET"} ${url}`);
          return init?.method === "PUT"
            ? new Response(null, { status: 204 })
            : Response.json({ fingerprint: null });
        }),
      );
    });
    afterEach(() => {
      devShare.on = true;
    });

    /** Go live on a PC whose last check read the TPM's EK, with the bridge's machine key as `machineKey`. */
    async function goLive(machineKey = "test-machine-key") {
      const bridge = fakeBridge();
      (window as { swiffHost?: HostBridge }).swiffHost = bridge;
      bridge.loadMachineKey = vi.fn(async () => machineKey);
      bridge.readRental = vi.fn(async () => rentalOf({ ...structuredClone(FACTS), check: EK }, []));
      bridge.planRental = vi.fn(async () => ONCE);
      const hook = renderHook(() => useHost());
      await settle();
      act(() => hook.result.current.actions.goLiveRental());
      // The EK's fingerprint is hashed off the main thread: wait for Go live to end, not a few ticks.
      await vi.waitFor(async () => {
        await settle();
        expect(hook.result.current.view.rental.run.status).toBe("failed");
      });
      return { ...hook, bridge };
    }

    it("registers the TPM with Lanterel's server in the build hosts download, which has no field for one", async () => {
      // What 0.1.0 keeps on a PC: an empty address from its Settings, or one an earlier build kept.
      for (const kept of ["", "hushed-otter-42.trycloudflare.com"]) {
        localStorage.setItem("swiff.signalingUrl", kept);
        asked = [];
        const { result, bridge, unmount } = await goLive();
        expect(asked).toEqual([
          "GET https://swiff.onrender.com/api/machines/geekom/ek",
          "PUT https://swiff.onrender.com/api/machines/geekom/ek",
        ]);
        expect(result.current.view.rental.run.failed?.step).not.toBe("ek");
        expect(bridge.runRental).toHaveBeenCalledOnce();
        // Lanterel OS is provisioned with the same server.
        expect(bridge.planRental).toHaveBeenCalledWith(
          expect.objectContaining({
            machine: { serverUrl: "wss://swiff.onrender.com", machineId: "geekom" },
          }),
        );
        unmount();
      }
    });

    it("says whether the server's address or the machine key is missing when sharing this Windows desktop", async () => {
      devShare.on = true;
      localStorage.setItem("swiff.signalingUrl", "");
      const noServer = await goLive();
      expect(noServer.result.current.view.rental.run.failed).toEqual({ step: "ek", error: "no-server" });
      noServer.unmount();

      localStorage.setItem("swiff.signalingUrl", "signal.example");
      const noKey = await goLive("");
      expect(noKey.result.current.view.rental.run.failed).toEqual({ step: "ek", error: "no-machine" });
      expect(asked).toEqual([]);
      expect(noKey.bridge.runRental).not.toHaveBeenCalled();
    });
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
      note: "You went offline at 23:00, as planned.",
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
      note: "You went offline at 22:00, as planned.",
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
    expect(result.current.view.connection.notice).toBe("This PC can't encrypt the key, so it wasn't saved.");
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
      result.current.actions.saveConnection({
        url: "otter.example",
        machineId: "pc-2",
        machineKey: "k2",
        name: "",
      }),
    );
    Object.assign(share, { connection: "registered", offlineSince: null });
    rerender();
    expect(result.current.view.live).toMatchObject({ kind: "waiting", until });

    act(() => result.current.actions.pause());
    act(() => void vi.advanceTimersByTime(3_600_000));
    rerender();
    await act(async () =>
      result.current.actions.saveConnection({
        url: "otter.example",
        machineId: "pc-3",
        machineKey: "k3",
        name: "",
      }),
    );
    rerender();
    expect(result.current.view.live).toMatchObject({ kind: "waiting", until });
  });
});
