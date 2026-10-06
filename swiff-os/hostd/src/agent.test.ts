// The agent's lifecycle against a platform kept in memory: the same state the
// server keeps for one machine (offer, claimed session, host session), so each
// test can say where the server stands and see what the agent did about it.
// integration.test.ts runs the same lifecycle against the real server.

import { afterEach, describe, expect, it } from "vitest";
import { createAgent, type Agent, type AgentDeps, type Outcome, type ReturnReply } from "./agent.ts";
import { HostApiError, type HostApi, type MachineView } from "./api.ts";
import type { Resume, Served } from "./resume.ts";
import type { SocketEvent } from "./socket.ts";
import type { Streamer } from "./streamer.ts";
import type { FloorCheck } from "./config.ts";
import { StateKeyRefused, UnsealFailed } from "./state-key.ts";

const FAST = { sessionBeatMs: 10, offeredBeatMs: 10, offlineBeatMs: 10 };
const HOUR = 3_600_000;

/** One machine as the server holds it. */
function fakeServer(start: Partial<FakeState> = {}) {
  const state: FakeState = {
    status: "available",
    until: null,
    sessionId: null,
    started: false,
    resetUntil: null,
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
    ...(state.sessionId && state.resetUntil !== null ? { resetUntil: state.resetUntil } : {}),
    crew: { only: false, crews: [] },
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
    setAvailability: async (available, until, { reset = false } = {}) => {
      guard(`availability ${available}${reset ? " reset" : ""}`);
      if (state.unreachable > 0) {
        state.unreachable--;
        throw new TypeError("fetch failed");
      }
      state.until = until;
      if (!available && reset && state.sessionId && !state.started) {
        // The reset hold: a claim not yet served is kept through the restart.
        state.resetUntil ??= Date.now() + 3 * 60_000;
      } else if (!available) {
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
      state.started = true;
      state.resetUntil = null;
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
      state.started = false;
      state.status = "in_session";
    },
    /** The platform session ends (the renter left, the time ran out): its host session with it. */
    endSession() {
      // A session that ends during a reset hold leaves the machine idle, as the reset would have.
      const held = state.resetUntil !== null;
      state.sessionId = null;
      state.started = false;
      state.resetUntil = null;
      state.hostSession = null;
      state.status = held ? "idle" : "available";
    },
  };
  return server;
}

type FakeState = {
  status: MachineView["status"];
  until: number | null;
  sessionId: string | null;
  /** Its host session has started: the server's `started_at`. */
  started: boolean;
  /** Until when a reset holds the claimed session through the restart. */
  resetUntil: number | null;
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
    served: servedBefore = null,
    bootId = "boot-now",
    rebootFails = false,
    ...deps
  }: {
    unmet?: FloorCheck[];
    saved?: Resume | null;
    /** The boot a renter was last served in, and their session, as a previous run of the agent noted it. */
    served?: Served | null;
    bootId?: string;
    /** `systemctl reboot` fails: the agent is left running in the same boot. */
    rebootFails?: boolean;
  } & Partial<AgentDeps> = {},
) {
  const streamers: FakeStreamer[] = [];
  const sockets: { emit: (event: SocketEvent) => void; closed: boolean }[] = [];
  const system = { reboots: 0, windows: 0 };
  let saved: Resume | null = initial;
  let served: Served | null = servedBefore;
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
      reboot: async () => {
        system.reboots++;
        if (rebootFails) throw new Error("systemctl reboot failed");
      },
      returnToWindows: async () => void system.windows++,
      unmetFloor: async () => unmet,
      bootId: async () => bootId,
    },
    resume: {
      save: async (resume) => void (saved = resume),
      read: async () => saved,
      clear: async () => void (saved = null),
      markServed: async (next) => void (served = next),
      servedBoot: async () => served,
      forgetServed: async () => void (served = null),
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
    served: () => served,
    socket: () => sockets.at(-1)!,
  };
}

/** Every agent a test started: each is brought to its end afterwards, so none keeps beating. */
const started: { agent: Agent; server: ReturnType<typeof fakeServer>; running: Promise<Outcome> }[] = [];
afterEach(async () => {
  for (const { agent, server, running } of started.splice(0)) {
    server.endSession();
    void agent.requestReturnToWindows();
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
    expect(h.saved()).toEqual({ until: until2h });
    expect(h.served()).toEqual({ bootId: "boot-now", sessionId: "s1" });
    expect(h.server.calls.slice(-3)).toEqual(["heartbeat", "availability false reset", "session end"]);
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
      saved: { until: until2h },
      served: { bootId: "boot-before", sessionId: "s0" },
    });
    await until(() => phase(h.agent) === "offered", "the offer");
    expect(h.server.state).toMatchObject({ status: "available", until: until2h });
    expect(h.saved()).toBeNull();
    expect(h.served()).toBeNull();
  });

  it("keeps trying to offer itself again after its reset while the server cannot be reached", async () => {
    const h = harness(fakeServer({ status: "idle", unreachable: 2 }), {
      saved: { until: null },
    });
    await until(() => phase(h.agent) === "offered", "the offer");
    expect(h.server.calls.filter((c) => c === "availability true")).toHaveLength(3);
    expect(h.system).toEqual({ reboots: 0, windows: 0 });
  });

  it("keeps its resume while it retries, and clears it once offered again", async () => {
    const h = harness(fakeServer({ status: "idle", unreachable: 1_000 }), { saved: { until: null } });
    await until(() => h.server.calls.includes("availability true"), "a try to offer again");
    // An agent restarted now still knows the reset was its own.
    expect(h.saved()).toEqual({ until: null });
    h.server.state.unreachable = 0;
    await until(() => phase(h.agent) === "offered", "the offer");
    expect(h.saved()).toBeNull();
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
      saved: { until: until2h },
      served: { bootId: "boot-now", sessionId: "s0" },
    });
    expect(await h.running).toBe("reset");
    expect(h.system).toEqual({ reboots: 1, windows: 0 });
    expect(h.server.calls).not.toContain("availability true");
    expect(h.server.state.status).toBe("idle");
    expect(h.sockets).toHaveLength(0);
    // Kept for the boot that does come back clean.
    expect(h.saved()).toEqual({ until: until2h });
    expect(h.served()).toEqual({ bootId: "boot-now", sessionId: "s0" });
  });

  it("refuses the owner as busy while it starts, and carries nothing into its restart", async () => {
    const h = harness(fakeServer(), { served: { bootId: "boot-now", sessionId: "s0" } });
    expect(await h.agent.requestReturnToWindows()).toEqual({ ok: false, reason: "busy" });
    expect(await h.running).toBe("reset");
    expect(h.system).toEqual({ reboots: 1, windows: 0 });
    expect(h.sockets).toHaveLength(0);
  });

  it("never serves the renter claimed as the last one left when the reboot never happened", async () => {
    const server = fakeServer();
    const h = harness(server, { rebootFails: true });
    await until(() => phase(h.agent) === "offered", "the offer");
    server.claim("s1");
    h.socket().emit({ type: "claimed", claim: { sessionId: "s1", appid: 730, minutes: 30 } });
    await until(() => h.streamers.length === 1, "the streamer");
    server.endSession();
    server.claim("s2");
    h.streamers[0]!.exit();
    await expect(h.running).rejects.toThrow("systemctl reboot failed");

    // systemd starts the agent again, in the same boot.
    const again = harness(server, { saved: h.saved(), served: h.served() });
    expect(await again.running).toBe("reset");
    expect(again.streamers).toHaveLength(0);
    expect(again.system).toEqual({ reboots: 1, windows: 0 });
    // Still the renter's, served once the PC is back.
    expect(server.state).toMatchObject({ status: "in_session", sessionId: "s2" });

    const back = harness(server, { saved: again.saved(), served: again.served(), bootId: "boot-next" });
    await until(() => back.streamers.length === 1, "the streamer after the reboot");
    expect(back.agent.status().sessionId).toBe("s2");
  });

  it("takes the PC off offer and restarts again after a broken streamer when the reboot never happened", async () => {
    const until2h = Date.now() + 2 * HOUR;
    const server = fakeServer({ until: until2h });
    const h = harness(server, { timing: { ...FAST, maxStreamerStarts: 1 }, rebootFails: true });
    await until(() => phase(h.agent) === "offered", "the offer");
    server.claim("s1");
    h.socket().emit({ type: "claimed", claim: { sessionId: "s1", appid: 730, minutes: 30 } });
    await until(() => h.streamers.length === 1, "the streamer");
    // Taking it off offer for the reset did not get through either.
    server.state.unreachable = 1;
    h.streamers[0]!.exit();
    await expect(h.running).rejects.toThrow("systemctl reboot failed");
    expect(server.calls).toContain("platform session end");
    expect(server.state.status).toBe("available");

    const again = harness(server, { saved: h.saved(), served: h.served() });
    expect(await again.running).toBe("reset");
    expect(again.sockets).toHaveLength(0);
    expect(server.calls).not.toContain("availability true");
    expect(server.state).toMatchObject({ status: "idle", until: until2h });
    expect(again.saved()).toEqual({ until: until2h });
  });

  it("never ends the session it served as the owner's when its reset again finds it still live", async () => {
    // The agent stopped mid-session, after the renter arrived, and systemd started it again in the same boot.
    const server = fakeServer({ status: "in_session", sessionId: "s1", started: true });
    const h = harness(server, { served: { bootId: "boot-now", sessionId: "s1" } });
    expect(await h.running).toBe("reset");
    expect(h.system).toEqual({ reboots: 1, windows: 0 });
    expect(server.calls.filter((call) => call.startsWith("availability"))).toEqual([]);
    expect(server.state).toMatchObject({ status: "in_session", sessionId: "s1" });
  });

  it("goes back to Windows when the share-until passed during the reset", async () => {
    const past = Date.now() - 1_000;
    const h = harness(fakeServer({ status: "idle", until: past }), {
      saved: { until: past },
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

  it("never ends the session it served as the owner's when ending it for a broken streamer failed", async () => {
    const server = fakeServer();
    server.api.endSession = async () => {
      throw new TypeError("fetch failed");
    };
    const h = harness(server, { timing: { ...FAST, maxStreamerStarts: 1 } });
    await until(() => phase(h.agent) === "offered", "the offer");
    server.claim("s1");
    h.socket().emit({ type: "claimed", claim: { sessionId: "s1", appid: 730, minutes: 30 } });
    await until(() => h.streamers.length === 1, "the streamer");
    h.streamers[0]!.exit();
    expect(await h.running).toBe("reset");
    expect(h.system).toEqual({ reboots: 1, windows: 0 });
    expect(server.calls.filter((call) => call.startsWith("availability false"))).toEqual([]);
    expect(server.state).toMatchObject({ status: "in_session", sessionId: "s1", started: true });
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

  it("holds a renter who claimed it as the last one left through the reset, and serves them after it", async () => {
    const h = harness();
    await until(() => phase(h.agent) === "offered", "the offer");
    h.server.claim("s1");
    h.socket().emit({ type: "claimed", claim: { sessionId: "s1", appid: 730, minutes: 30 } });
    await until(() => h.streamers.length === 1, "the streamer");
    h.server.endSession();
    h.server.claim("s2");
    h.streamers[0]!.exit();
    expect(await h.running).toBe("reset");
    // Off offer as a reset: s2 is kept, not ended as the owner's.
    expect(h.server.calls).toContain("availability false reset");
    expect(h.server.state).toMatchObject({ status: "in_session", sessionId: "s2", hostSession: null });
    expect(h.server.state.resetUntil).not.toBeNull();

    const back = harness(h.server, { saved: h.saved(), served: h.served(), bootId: "boot-next" });
    await until(() => back.streamers.length === 1, "the streamer after the reboot");
    expect(back.agent.status()).toMatchObject({ phase: "serving", sessionId: "s2" });
    expect(h.server.state.resetUntil).toBeNull();
    expect(back.saved()).toBeNull();
  });

  it("holds a renter who claims after its last heartbeat, as the reset takes it off offer", async () => {
    const until2h = Date.now() + 2 * HOUR;
    const h = harness(fakeServer({ until: until2h }));
    await until(() => phase(h.agent) === "offered", "the offer");
    h.server.claim("s1");
    h.socket().emit({ type: "claimed", claim: { sessionId: "s1", appid: 730, minutes: 30 } });
    await until(() => h.streamers.length === 1, "the streamer");
    const setAvailability = h.server.api.setAvailability;
    h.server.api.setAvailability = async (available, until, options) => {
      // The claim commits between the reset's heartbeat and its off-offer.
      if (!available) h.server.claim("s2");
      return setAvailability(available, until, options);
    };
    h.server.endSession();
    h.streamers[0]!.exit();
    expect(await h.running).toBe("reset");
    expect(h.system).toEqual({ reboots: 1, windows: 0 });
    expect(h.server.state).toMatchObject({ status: "in_session", sessionId: "s2", until: until2h });
    expect(h.saved()).toEqual({ until: until2h });
  });

  it("lets a held renter's session end during the reset leave the PC to offer itself again", async () => {
    const until2h = Date.now() + 2 * HOUR;
    const server = fakeServer({ until: until2h });
    const h = harness(server);
    await until(() => phase(h.agent) === "offered", "the offer");
    server.claim("s1");
    h.socket().emit({ type: "claimed", claim: { sessionId: "s1", appid: 730, minutes: 30 } });
    await until(() => h.streamers.length === 1, "the streamer");
    server.endSession();
    server.claim("s2");
    h.streamers[0]!.exit();
    expect(await h.running).toBe("reset");
    // The held renter leaves before the PC is back.
    server.endSession();
    expect(server.state.status).toBe("idle");

    const back = harness(server, { saved: h.saved(), served: h.served(), bootId: "boot-next" });
    await until(() => phase(back.agent) === "offered", "the offer after the reboot");
    expect(server.state).toMatchObject({ status: "available", until: until2h });
  });
});

/** Ask for the PC back on every heartbeat and off-offer call made while resetting, and keep the answers. */
function askWhileResetting(api: HostApi, agent: Agent) {
  const answers: ReturnReply[] = [];
  const heartbeat = api.heartbeat;
  api.heartbeat = async () => {
    if (phase(agent) === "resetting") answers.push(await agent.requestReturnToWindows());
    return heartbeat();
  };
  const setAvailability = api.setAvailability;
  api.setAvailability = async (available, until, options) => {
    if (phase(agent) === "resetting") answers.push(await agent.requestReturnToWindows());
    return setAvailability(available, until, options);
  };
  return answers;
}

describe("the owner taking the PC back (D8)", () => {
  it("goes back to Windows at once while no session is live", async () => {
    const h = harness();
    await until(() => phase(h.agent) === "offered", "the offer");
    expect(await h.agent.requestReturnToWindows()).toEqual({ ok: true });
    expect(h.server.calls).toContain("availability false reset");
    expect(h.server.state.status).toBe("idle");
    expect(await h.running).toBe("windows");
    expect(h.system).toEqual({ reboots: 0, windows: 1 });
    expect(h.socket().closed).toBe(true);
  });

  it("refuses while offered when the server shows a session the socket has not told of, and serves it", async () => {
    const h = harness();
    await until(() => phase(h.agent) === "offered", "the offer");
    h.server.claim("s1");
    expect(await h.agent.requestReturnToWindows()).toEqual({ ok: false, reason: "session-live" });
    expect(h.server.calls.some((c) => c.startsWith("availability false"))).toBe(false);
    await until(() => h.streamers.length === 1, "the streamer");
    expect(h.agent.status()).toMatchObject({ phase: "serving", sessionId: "s1" });
    h.server.endSession();
    expect(await h.running).toBe("reset");
    expect(h.system).toEqual({ reboots: 1, windows: 0 });
  });

  it("serves no claim once the owner's request has taken it off offer", async () => {
    const h = harness();
    await until(() => phase(h.agent) === "offered", "the offer");
    const setAvailability = h.server.api.setAvailability;
    h.server.api.setAvailability = async (available, until, options) => {
      const view = await setAvailability(available, until, options);
      h.socket().emit({ type: "claimed", claim: { sessionId: "late", appid: 730, minutes: 30 } });
      return view;
    };
    expect(await h.agent.requestReturnToWindows()).toEqual({ ok: true });
    expect(await h.running).toBe("windows");
    expect(h.streamers).toHaveLength(0);
    expect(h.server.calls).not.toContain("session start");
  });

  it("refuses when a renter claims after its heartbeat, as it takes the PC off offer, and serves them", async () => {
    const h = harness();
    await until(() => phase(h.agent) === "offered", "the offer");
    const setAvailability = h.server.api.setAvailability;
    h.server.api.setAvailability = async (available, until, options) => {
      if (!available) h.server.claim("s1");
      return setAvailability(available, until, options);
    };
    expect(await h.agent.requestReturnToWindows()).toEqual({ ok: false, reason: "session-live" });
    await until(() => h.streamers.length === 1, "the streamer");
    expect(h.agent.status()).toMatchObject({ phase: "serving", sessionId: "s1" });
    expect(h.server.state.resetUntil).toBeNull();
    h.server.api.setAvailability = setAvailability;
    h.server.endSession();
    expect(await h.running).toBe("reset");
    expect(h.system).toEqual({ reboots: 1, windows: 0 });
  });

  it("refuses while a renter's session is live, and resets as usual after it", async () => {
    const h = harness();
    await until(() => phase(h.agent) === "offered", "the offer");
    h.server.claim("s1");
    h.socket().emit({ type: "claimed", claim: { sessionId: "s1", appid: 730, minutes: 30 } });
    await until(() => h.streamers.length === 1, "the streamer");
    expect(await h.agent.requestReturnToWindows()).toEqual({ ok: false, reason: "session-live" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.server.state.sessionId).toBe("s1");
    h.server.endSession();
    expect(await h.running).toBe("reset");
    expect(h.system).toEqual({ reboots: 1, windows: 0 });
  });

  it("refuses as busy while it resets, and serves the renter claimed as the last one left after it", async () => {
    const h = harness();
    const answers = askWhileResetting(h.server.api, h.agent);
    await until(() => phase(h.agent) === "offered", "the offer");
    h.server.claim("s1");
    h.socket().emit({ type: "claimed", claim: { sessionId: "s1", appid: 730, minutes: 30 } });
    await until(() => h.streamers.length === 1, "the streamer");
    h.server.endSession();
    h.server.claim("s2");
    h.streamers[0]!.exit();
    expect(await h.running).toBe("reset");
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.every((a) => a.ok === false && a.reason === "busy")).toBe(true);
    expect(h.system).toEqual({ reboots: 1, windows: 0 });
    expect(h.server.state).toMatchObject({ status: "in_session", sessionId: "s2" });
  });

  it("refuses as busy while it resets with nobody waiting, and restarts into rental mode all the same", async () => {
    const h = harness();
    const answers = askWhileResetting(h.server.api, h.agent);
    await until(() => phase(h.agent) === "offered", "the offer");
    h.server.claim("s1");
    h.socket().emit({ type: "claimed", claim: { sessionId: "s1", appid: 730, minutes: 30 } });
    await until(() => h.streamers.length === 1, "the streamer");
    h.server.endSession();
    h.streamers[0]!.exit();
    expect(await h.running).toBe("reset");
    expect(answers.length).toBeGreaterThan(1);
    expect(answers.every((a) => a.ok === false && a.reason === "busy")).toBe(true);
    expect(h.system).toEqual({ reboots: 1, windows: 0 });
    expect(h.server.state.status).toBe("idle");
  });

  it("refuses as busy while its reset again cannot reach the server, and restarts all the same", async () => {
    const server = fakeServer();
    const h = harness(server, { served: { bootId: "boot-now", sessionId: "s0" } });
    let offline = 3;
    const heartbeat = server.api.heartbeat;
    server.api.heartbeat = async () => {
      if (phase(h.agent) === "resetting" && offline > 0) {
        offline--;
        throw new TypeError("fetch failed");
      }
      return heartbeat();
    };
    const answers = askWhileResetting(server.api, h.agent);
    expect(await h.running).toBe("reset");
    expect(offline).toBe(0);
    expect(answers.length).toBeGreaterThan(3);
    expect(answers.every((a) => a.ok === false && a.reason === "busy")).toBe(true);
    expect(h.system).toEqual({ reboots: 1, windows: 0 });
  });

  it("with takeover set to always, ends the live session as the owner's and goes back to Windows", async () => {
    const h = harness(fakeServer(), { ownerTakeover: "always" });
    await until(() => phase(h.agent) === "offered", "the offer");
    h.server.claim("s1");
    h.socket().emit({ type: "claimed", claim: { sessionId: "s1", appid: 730, minutes: 30 } });
    await until(() => h.streamers.length === 1, "the streamer");
    expect(await h.agent.requestReturnToWindows()).toEqual({ ok: true });
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

describe("a machine whose persistent state stays shut", () => {
  /** A state that opens after `failures` refused tries. */
  const state = (failures: number) => {
    const tries = { count: 0 };
    return {
      tries,
      unlock: async () => {
        tries.count++;
        if (tries.count <= failures)
          throw new StateKeyRefused("state key release", 403, "firmware-cooldown", null);
      },
    };
  };

  it("is kept off the market while the server keeps its share back, and offered once the state opens", async () => {
    const s = state(2);
    const h = harness(fakeServer(), { state: s, timing: { ...FAST, unlockRetryMs: [40] } });
    // The status page says why.
    await until(() => h.agent.status().locked === "firmware-cooldown", "locked");
    expect(phase(h.agent)).toBe("locked");
    // No socket, no heartbeat, no offer: nothing tells the server this PC may host.
    expect(h.server.calls).toEqual([]);
    expect(h.sockets).toHaveLength(0);
    await until(() => phase(h.agent) === "offered", "the offer");
    expect(s.tries.count).toBe(3);
    expect(h.agent.status()).not.toHaveProperty("locked");
  });

  it("waits longer after each refused try", async () => {
    const s = state(Infinity);
    const h = harness(fakeServer(), { state: s, timing: { ...FAST, unlockRetryMs: [10, 300] } });
    await until(() => s.tries.count === 2, "the second try");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(s.tries.count).toBe(2);
    expect(h.sockets).toHaveLength(0);
  });

  it("goes back to Windows when the owner asks while it is shut", async () => {
    const h = harness(fakeServer(), { state: state(Infinity), timing: { ...FAST, unlockRetryMs: [60_000] } });
    await until(() => phase(h.agent) === "locked", "locked");
    expect(await h.agent.requestReturnToWindows()).toEqual({ ok: true });
    expect(await h.running).toBe("windows");
    expect(h.sockets).toHaveLength(0);
  });

  it("goes back to Windows when the owner asks while a try is still under way", async () => {
    const h = harness(fakeServer(), { state: { unlock: () => new Promise<void>(() => {}) } });
    await until(() => phase(h.agent) === "locked", "locked");
    expect(h.agent.status()).toMatchObject({ locked: null });
    expect(await h.agent.requestReturnToWindows()).toEqual({ ok: true });
    expect(await h.running).toBe("windows");
    expect(h.sockets).toHaveLength(0);
  });

  it("shows unseal-failed while its own share did not open the state", async () => {
    const unlock = async () => {
      throw new UnsealFailed("the state did not open, nor could it be renewed (no network)");
    };
    const h = harness(fakeServer(), { state: { unlock }, timing: { ...FAST, unlockRetryMs: [60_000] } });
    await until(() => h.agent.status().locked === "unseal-failed", "unseal-failed");
    expect(h.sockets).toHaveLength(0);
  });

  it("serves a held renter only once the state is open", async () => {
    const server = fakeServer();
    server.claim("held");
    const s = state(1);
    const h = harness(server, { state: s, timing: { ...FAST, unlockRetryMs: [20] } });
    await until(() => h.streamers.length === 1, "the streamer");
    expect(s.tries.count).toBe(2);
    expect(h.server.calls[0]).toBe("session end");
  });
});

describe("a machine that cannot be offered", () => {
  it("is never offered below the hardware floor (D3), and goes back to Windows when asked", async () => {
    const h = harness(fakeServer(), { unmet: ["secureBoot", "iommu"] });
    await until(() => phase(h.agent) === "unfit", "unfit");
    expect(h.agent.status().unmet).toEqual(["secureBoot", "iommu"]);
    expect(h.server.calls).toEqual([]);
    expect(await h.agent.requestReturnToWindows()).toEqual({ ok: true });
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
