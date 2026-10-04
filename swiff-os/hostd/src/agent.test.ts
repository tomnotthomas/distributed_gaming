// The agent's lifecycle against a platform kept in memory: the same state the
// server keeps for one machine (offer, claimed session, host session), so each
// test can say where the server stands and see what the agent did about it.
// integration.test.ts runs the same lifecycle against the real server.

import { afterEach, describe, expect, it } from "vitest";
import { createAgent, type Agent, type AgentDeps, type Outcome } from "./agent.ts";
import { HostApiError, type HostApi, type MachineView } from "./api.ts";
import type { Resume } from "./resume.ts";
import type { SocketEvent } from "./socket.ts";
import type { Streamer } from "./streamer.ts";
import type { FloorCheck } from "./config.ts";

const FAST = { sessionBeatMs: 10, offeredBeatMs: 10, offlineBeatMs: 10 };
const HOUR = 3_600_000;

/** One machine as the server holds it. */
function fakeServer(start: Partial<FakeState> = {}) {
  const state: FakeState = {
    status: "available",
    until: null,
    sessionId: null,
    hostSession: null,
    keys: 0,
    refuseKey: false,
    unreachable: 0,
    ...start,
  };
  const calls: string[] = [];
  const view = (): MachineView => ({
    id: "pc-1",
    status: state.status,
    gpu: null,
    cpu: null,
    price: 100,
    ...(state.until === null ? {} : { until: state.until }),
    ...(state.sessionId ? { session: { id: state.sessionId } } : {}),
  });
  const guard = (call: string) => {
    calls.push(call);
    if (state.refuseKey) throw new HostApiError(call, 401, null);
  };
  const api: HostApi = {
    heartbeat: async () => {
      guard("heartbeat");
      return view();
    },
    setAvailability: async (available, until) => {
      guard(`availability ${available}`);
      if (state.unreachable > 0) {
        state.unreachable--;
        throw new TypeError("fetch failed");
      }
      state.until = until;
      if (!available) {
        // Taking it back ends a live session: the owner's.
        state.sessionId = null;
        state.hostSession = null;
        state.status = "idle";
      } else if (state.status === "idle") state.status = "available";
      return view();
    },
    startHostSession: async (sessionId) => {
      guard("session start");
      if (sessionId !== state.sessionId) throw new HostApiError("session start", 409, "not-claimed");
      if (state.hostSession) throw new HostApiError("session start", 409, "session-active");
      state.hostSession = sessionId;
      state.keys++;
      return { sessionId, sessionKey: `key-${state.keys}`, expiresAt: 0 };
    },
    endHostSession: async () => {
      guard("session end");
      state.hostSession = null;
    },
    endSession: async (sessionId) => {
      guard("platform session end");
      if (sessionId === state.sessionId) server.endSession();
    },
  };
  const server = {
    state,
    calls,
    api,
    /** A renter claims the machine. */
    claim(sessionId: string) {
      state.sessionId = sessionId;
      state.status = "in_session";
    },
    /** The platform session ends (the renter left, the time ran out): its host session with it. */
    endSession() {
      state.sessionId = null;
      state.hostSession = null;
      state.status = "available";
    },
  };
  return server;
}

type FakeState = {
  status: MachineView["status"];
  until: number | null;
  sessionId: string | null;
  hostSession: string | null;
  keys: number;
  refuseKey: boolean;
  /** How many availability calls fail on the network before one gets through. */
  unreachable: number;
};

type FakeStreamer = Streamer & { key: string; appid: number | null; exit(): void; stopped: boolean };

function harness(
  server = fakeServer(),
  {
    unmet = [],
    saved: initial = null,
    ...deps
  }: { unmet?: FloorCheck[]; saved?: Resume | null } & Partial<AgentDeps> = {},
) {
  const streamers: FakeStreamer[] = [];
  const sockets: { emit: (event: SocketEvent) => void; closed: boolean }[] = [];
  const system = { reboots: 0, windows: 0 };
  let saved: Resume | null = initial;
  const agent = createAgent({
    api: server.api,
    openSocket: (onEvent) => {
      const socket = { emit: onEvent, closed: false };
      sockets.push(socket);
      return { close: () => (socket.closed = true) };
    },
    launchStreamer: (grant, appid) => {
      let exit = () => {};
      const exited = new Promise<void>((resolve) => (exit = resolve));
      const streamer: FakeStreamer = {
        key: grant.sessionKey,
        appid,
        exited,
        exit,
        stopped: false,
        stop: async () => {
          streamer.stopped = true;
          exit();
        },
      };
      streamers.push(streamer);
      return streamer;
    },
    system: {
      reboot: async () => void system.reboots++,
      returnToWindows: async () => void system.windows++,
      unmetFloor: async () => unmet,
      bootId: async () => "boot-now",
    },
    resume: {
      save: async (resume) => void (saved = resume),
      take: async () => {
        const taken = saved;
        saved = null;
        return taken;
      },
    },
    ownerTakeover: "when-idle",
    timing: FAST,
    log: () => {},
    ...deps,
  });
  const running = agent.run();
  running.catch(() => {});
  started.push({ agent, server, running });
  return {
    agent,
    server,
    streamers,
    sockets,
    system,
    running,
    saved: () => saved,
    socket: () => sockets.at(-1)!,
  };
}

/** Every agent a test started: each is brought to its end afterwards, so none keeps beating. */
const started: { agent: Agent; server: ReturnType<typeof fakeServer>; running: Promise<Outcome> }[] = [];
afterEach(async () => {
  for (const { agent, server, running } of started.splice(0)) {
    server.endSession();
    agent.requestReturnToWindows();
    await running.catch(() => {});
  }
});

/** Wait until `check` holds, or fail. */
async function until(check: () => boolean, what: string, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const phase = (agent: Agent) => agent.status().phase;

describe("offering and serving", () => {
  it("serves a claim with a session key, never the machine key, then restarts clean", async () => {
    const until2h = Date.now() + 2 * HOUR;
    const h = harness(fakeServer({ until: until2h }));
    await until(() => phase(h.agent) === "offered", "the offer");
    expect(h.server.calls.slice(0, 2)).toEqual(["session end", "heartbeat"]);

    h.server.claim("s1");
    h.socket().emit({ type: "claimed", claim: { sessionId: "s1", appid: 730, minutes: 30 } });
    await until(() => h.streamers.length === 1, "the streamer");
    expect(h.socket().closed).toBe(true);
    expect(h.streamers[0]).toMatchObject({ key: "key-1", appid: 730 });
    expect(h.agent.status()).toMatchObject({ phase: "serving", sessionId: "s1" });

    // The renter leaves: the server ends the session, the streamer is put out.
    h.server.endSession();
    h.streamers[0]!.exit();
    expect(await h.running).toBe("reset");

    expect(h.system).toEqual({ reboots: 1, windows: 0 });
    // Off offer for the reset, on the owner's terms, and remembered for the next boot.
    expect(h.server.state).toMatchObject({ status: "idle", until: until2h, hostSession: null });
    expect(h.saved()).toEqual({ until: until2h, bootId: "boot-now" });
    expect(h.server.calls.slice(-3)).toEqual(["heartbeat", "availability false", "session end"]);
  });

  it("learns of the end from its heartbeat when the streamer says nothing", async () => {
    const h = harness();
    await until(() => phase(h.agent) === "offered", "the offer");
    h.server.claim("s1");
    h.socket().emit({ type: "claimed", claim: { sessionId: "s1", appid: 730, minutes: 30 } });
    await until(() => h.streamers.length === 1, "the streamer");
    h.server.endSession();
    expect(await h.running).toBe("reset");
    expect(h.streamers[0]!.stopped).toBe(true);
  });

  it("offers again after its own reset, with the share-until it kept", async () => {
    const until2h = Date.now() + 2 * HOUR;
    const h = harness(fakeServer({ status: "idle", until: until2h }), {
      saved: { until: until2h, bootId: "boot-before" },
    });
    await until(() => phase(h.agent) === "offered", "the offer");
    expect(h.server.state).toMatchObject({ status: "available", until: until2h });
    expect(h.saved()).toBeNull();
  });

  it("keeps trying to offer itself again after its reset while the server cannot be reached", async () => {
    const h = harness(fakeServer({ status: "idle", unreachable: 2 }), {
      saved: { until: null, bootId: "boot-before" },
    });
    await until(() => phase(h.agent) === "offered", "the offer");
    expect(h.server.calls.filter((c) => c === "availability true")).toHaveLength(3);
    expect(h.system).toEqual({ reboots: 0, windows: 0 });
  });

  it("goes back to Windows when it boots off offer with no reset of its own behind it", async () => {
    const h = harness(fakeServer({ status: "idle" }));
    expect(await h.running).toBe("windows");
    expect(h.system).toEqual({ reboots: 0, windows: 1 });
    expect(h.sockets).toHaveLength(0);
  });

  it("stays off offer and restarts again when its reset's reboot never happened", async () => {
    const until2h = Date.now() + 2 * HOUR;
    const h = harness(fakeServer({ status: "idle", until: until2h }), {
      saved: { until: until2h, bootId: "boot-now" },
    });
    expect(await h.running).toBe("reset");
    expect(h.system).toEqual({ reboots: 1, windows: 0 });
    expect(h.server.calls).not.toContain("availability true");
    expect(h.server.state.status).toBe("idle");
    expect(h.sockets).toHaveLength(0);
    // Kept for the boot that does come back clean.
    expect(h.saved()).toEqual({ until: until2h, bootId: "boot-now" });
  });

  it("goes back to Windows when the share-until passed during the reset", async () => {
    const past = Date.now() - 1_000;
    const h = harness(fakeServer({ status: "idle", until: past }), {
      saved: { until: past, bootId: "boot-before" },
    });
    expect(await h.running).toBe("windows");
    expect(h.server.state.status).toBe("idle");
  });

  it("serves a session already live at boot, ending the old host session first", async () => {
    const server = fakeServer({ sessionId: "s1", status: "in_session", hostSession: "s1" });
    const h = harness(server);
    await until(() => h.streamers.length === 1, "the streamer");
    expect(server.calls.slice(0, 3)).toEqual(["session end", "heartbeat", "session start"]);
    expect(h.streamers[0]).toMatchObject({ key: "key-1", appid: null });
    expect(h.sockets).toHaveLength(0);
  });

  it("serves a claim its heartbeat finds when the socket missed it", async () => {
    const h = harness();
    await until(() => phase(h.agent) === "offered", "the offer");
    h.server.claim("s1");
    await until(() => h.streamers.length === 1, "the streamer");
    expect(h.agent.status().sessionId).toBe("s1");
  });

  it("starts a streamer that exits mid-session again on a fresh key", async () => {
    const h = harness();
    await until(() => phase(h.agent) === "offered", "the offer");
    h.server.claim("s1");
    h.socket().emit({ type: "claimed", claim: { sessionId: "s1", appid: 730, minutes: 30 } });
    await until(() => h.streamers.length === 1, "the streamer");
    h.streamers[0]!.exit();
    await until(() => h.streamers.length === 2, "the second streamer");
    expect(h.streamers[1]).toMatchObject({ key: "key-2", appid: 730 });
    expect(h.server.state.hostSession).toBe("s1");
  });

  it("ends a session whose streamer keeps stopping, and resets", async () => {
    const h = harness(fakeServer(), { timing: { ...FAST, maxStreamerStarts: 2 } });
    await until(() => phase(h.agent) === "offered", "the offer");
    h.server.claim("s1");
    h.socket().emit({ type: "claimed", claim: { sessionId: "s1", appid: 730, minutes: 30 } });
    await until(() => h.streamers.length === 1, "the streamer");
    h.streamers[0]!.exit();
    await until(() => h.streamers.length === 2, "the second streamer");
    h.streamers[1]!.exit();
    expect(await h.running).toBe("reset");
    expect(h.server.calls).toContain("platform session end");
  });

  it("keeps a long session whose streamer stops now and then, long after each start", async () => {
    let clock = 0;
    const h = harness(fakeServer(), { timing: { ...FAST, maxStreamerStarts: 2 }, now: () => clock });
    await until(() => phase(h.agent) === "offered", "the offer");
    h.server.claim("s1");
    h.socket().emit({ type: "claimed", claim: { sessionId: "s1", appid: 730, minutes: 180 } });
    await until(() => h.streamers.length === 1, "the streamer");
    for (let n = 1; n <= 4; n++) {
      // Its key expired before its socket dropped: routine, and started again.
      clock += 10 * 60_000;
      h.streamers[n - 1]!.exit();
      await until(() => h.streamers.length === n + 1, `streamer ${n + 1}`);
    }
    expect(h.server.calls).not.toContain("platform session end");
    expect(h.agent.status()).toMatchObject({ phase: "serving", sessionId: "s1" });

    // Two quick stops in a row are a broken streamer.
    h.streamers[4]!.exit();
    await until(() => h.streamers.length === 6, "streamer 6");
    h.streamers[5]!.exit();
    expect(await h.running).toBe("reset");
    expect(h.server.calls).toContain("platform session end");
  });

  it("goes back to offering when the claim is over before its host session starts", async () => {
    const h = harness();
    await until(() => phase(h.agent) === "offered", "the offer");
    h.socket().emit({ type: "claimed", claim: { sessionId: "gone", appid: 730, minutes: 30 } });
    await until(() => h.sockets.length === 2 && phase(h.agent) === "offered", "the offer again");
    expect(h.streamers).toHaveLength(0);
    expect(h.system).toEqual({ reboots: 0, windows: 0 });
  });

  it("ends a host session it does not know when the server keeps its key out, and registers again", async () => {
    const h = harness();
    await until(() => phase(h.agent) === "offered", "the offer");
    h.socket().emit({ type: "denied", reason: "session-active" });
    await until(() => h.sockets.length === 2, "the second socket");
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.server.calls.filter((c) => c === "session end")).toHaveLength(2);
  });

  it("restarts without taking the machine off offer when a renter claimed it as the last one left", async () => {
    const h = harness();
    await until(() => phase(h.agent) === "offered", "the offer");
    h.server.claim("s1");
    h.socket().emit({ type: "claimed", claim: { sessionId: "s1", appid: 730, minutes: 30 } });
    await until(() => h.streamers.length === 1, "the streamer");
    h.server.endSession();
    h.server.claim("s2");
    h.streamers[0]!.exit();
    expect(await h.running).toBe("reset");
    // Taking it off offer now would end s2 as the owner's; it is served after the reset.
    expect(h.server.calls).not.toContain("availability false");
    expect(h.server.state).toMatchObject({ status: "in_session", sessionId: "s2" });
    expect(h.saved()).toBeNull();
  });
});

describe("the owner taking the PC back (D8)", () => {
  it("goes back to Windows at once while no session is live", async () => {
    const h = harness();
    await until(() => phase(h.agent) === "offered", "the offer");
    expect(h.agent.requestReturnToWindows()).toEqual({ ok: true });
    expect(await h.running).toBe("windows");
    expect(h.server.state.status).toBe("idle");
    expect(h.socket().closed).toBe(true);
  });

  it("refuses while a renter's session is live, and resets as usual after it", async () => {
    const h = harness();
    await until(() => phase(h.agent) === "offered", "the offer");
    h.server.claim("s1");
    h.socket().emit({ type: "claimed", claim: { sessionId: "s1", appid: 730, minutes: 30 } });
    await until(() => h.streamers.length === 1, "the streamer");
    expect(h.agent.requestReturnToWindows()).toEqual({ ok: false, reason: "session-live" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.server.state.sessionId).toBe("s1");
    h.server.endSession();
    expect(await h.running).toBe("reset");
  });

  it("with takeover set to always, ends the live session as the owner's and goes back to Windows", async () => {
    const h = harness(fakeServer(), { ownerTakeover: "always" });
    await until(() => phase(h.agent) === "offered", "the offer");
    h.server.claim("s1");
    h.socket().emit({ type: "claimed", claim: { sessionId: "s1", appid: 730, minutes: 30 } });
    await until(() => h.streamers.length === 1, "the streamer");
    expect(h.agent.requestReturnToWindows()).toEqual({ ok: true });
    expect(await h.running).toBe("windows");
    expect(h.server.state).toMatchObject({ status: "idle", sessionId: null });
    expect(h.streamers[0]!.stopped).toBe(true);
  });

  it("goes back to Windows when the owner stops sharing from elsewhere", async () => {
    const h = harness();
    await until(() => phase(h.agent) === "offered", "the offer");
    h.server.state.status = "idle";
    expect(await h.running).toBe("windows");
  });

  it("goes back to Windows when the share-until passes while offered", async () => {
    const h = harness(fakeServer({ until: Date.now() + 100 }));
    await until(() => phase(h.agent) === "offered", "the offer");
    expect(await h.running).toBe("windows");
    expect(h.server.state.status).toBe("idle");
  });
});

describe("a machine that cannot be offered", () => {
  it("is never offered below the hardware floor (D3), and goes back to Windows when asked", async () => {
    const h = harness(fakeServer(), { unmet: ["secureBoot", "iommu"] });
    await until(() => phase(h.agent) === "unfit", "unfit");
    expect(h.agent.status().unmet).toEqual(["secureBoot", "iommu"]);
    expect(h.server.calls).toEqual([]);
    expect(h.agent.requestReturnToWindows()).toEqual({ ok: true });
    expect(await h.running).toBe("windows");
  });

  it("stops at a refused machine key", async () => {
    const h = harness(fakeServer({ refuseKey: true }));
    await until(() => phase(h.agent) === "refused", "refused");
    expect(h.sockets).toHaveLength(0);
  });

  it("stops when the socket's register is refused", async () => {
    const h = harness();
    await until(() => phase(h.agent) === "offered", "the offer");
    h.socket().emit({ type: "denied", reason: "bad-machine-key" });
    await until(() => phase(h.agent) === "refused", "refused");
    expect(h.socket().closed).toBe(true);
  });
});
