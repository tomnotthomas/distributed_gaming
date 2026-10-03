// The PC session handoff, against a fake session host, a fake machine-key
// socket and a fake platform: every step from a claim to the PC being the
// owner's again, and what happens when one of them fails.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionClaim } from "@swiff/rtc";
import {
  GRACE_SLACK_MS,
  MAX_RESTARTS,
  startHandoff,
  type HandoffOptions,
  type HandoffSession,
  type MachineSocketEvents,
  type SessionHost,
  type StreamerCommand,
  type StreamerEvent,
  type StreamerInit,
} from "./handoff";

const CLAIM: SessionClaim = { sessionId: "s1", appid: 730, minutes: 45 };

/** The platform's answers, by call; each call is recorded as `METHOD path`. */
type Answer = number | "network";
let answers: Record<string, Answer[]> = {};
let calls: string[] = [];

function route(method: string, path: string): Answer {
  const key = `${method} ${path}`;
  return answers[key]?.shift() ?? (method === "DELETE" ? 204 : key.endsWith("/session") ? 201 : 200);
}

beforeEach(() => {
  vi.useFakeTimers();
  answers = {};
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const method = init.method ?? "GET";
      calls.push(`${method} ${path}`);
      const answer = route(method, path);
      if (answer === "network") throw new TypeError("fetch failed");
      const body = answer === 201 ? JSON.stringify({ sessionKey: `key-${calls.length}` }) : null;
      return new Response(body, { status: answer });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A session host that records what it is asked, and lets a test speak for the streamer. */
function fakeHost() {
  const listeners = new Set<(event: StreamerEvent) => void>();
  const host = {
    launched: [] as StreamerInit[],
    sent: [] as StreamerCommand[],
    logons: 0,
    ends: 0,
    logon: vi.fn(async () => {
      host.logons++;
    }),
    launch: vi.fn(async (init: StreamerInit) => {
      host.launched.push(init);
    }),
    send: (command: StreamerCommand) => host.sent.push(command),
    end: vi.fn(async () => {
      host.ends++;
    }),
    onEvent: (listener: (event: StreamerEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event: StreamerEvent) => listeners.forEach((l) => l(event)),
  };
  return host satisfies SessionHost & Record<string, unknown>;
}

/** Start a handoff, recording its sessions and its machine-key sockets. */
function start(extra: Partial<HandoffOptions> = {}) {
  const host = fakeHost();
  const sockets: (MachineSocketEvents & { stopped: boolean })[] = [];
  const sessions: (HandoffSession | null)[] = [];
  const denied = vi.fn();
  const handoff = startHandoff({
    url: "wss://signal.test",
    hostId: "pc-1",
    machineKey: "mk",
    host,
    openMachineSocket: (events) => {
      const socket = { ...events, stopped: false };
      sockets.push(socket);
      return { stop: () => void (socket.stopped = true) };
    },
    onSession: (session) => sessions.push(session && { ...session }),
    onDenied: denied,
    ...extra,
  });
  const steps = () => sessions.map((s) => s?.step ?? null);
  const live = () => sockets.filter((s) => !s.stopped);
  return { handoff, host, sockets, sessions, steps, live, denied };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

/** A handoff whose claim has been served up to a streamer holding the room. */
async function streaming(extra: Partial<HandoffOptions> = {}) {
  const run = start(extra);
  run.sockets[0]!.onClaim(CLAIM);
  await settle();
  run.host.emit({ type: "registered" });
  return run;
}

describe("the PC session handoff", () => {
  it("waits for a claim on the machine-key socket", () => {
    const { live, sessions } = start();
    expect(live()).toHaveLength(1);
    expect(sessions).toEqual([]);
  });

  it("gets a session key, signs the renter in and launches the streamer with it", async () => {
    const { sockets, host, steps } = start();
    sockets[0]!.onClaim(CLAIM);
    await settle();

    expect(sockets[0]!.stopped).toBe(true); // left before the session start puts it out
    expect(calls).toEqual(["POST /api/machines/pc-1/session"]);
    expect(host.logons).toBe(1);
    expect(host.launched).toEqual([
      { url: "wss://signal.test", hostId: "pc-1", sessionKey: "key-1", appid: 730 },
    ]);
    expect(steps()).toEqual(["starting", "logging-on", "launching"]);
  });

  it("starts the session on the first frame, then launches the game", async () => {
    const { host, steps, sessions } = await streaming();
    host.emit({ type: "peer-joined" });
    host.emit({ type: "first-frame" });
    await settle();
    expect(calls.at(-1)).toBe("POST /api/sessions/s1/start");
    expect(host.sent).toEqual([{ type: "launch-game" }]);

    host.emit({ type: "game-started", appid: 730 });
    expect(steps().slice(3)).toEqual(["waiting-player", "connecting", "launching-game", "game-started"]);
    expect(sessions.at(-1)).toMatchObject({ playerHere: true, graceUntil: null });

    // Another first frame (a later connection) starts nothing again.
    host.emit({ type: "first-frame" });
    await settle();
    expect(calls.filter((c) => c.endsWith("/start"))).toHaveLength(1);
  });

  it("launches the game even when the start could not be recorded", async () => {
    answers["POST /api/sessions/s1/start"] = [500, 500, 500];
    const { host } = await streaming();
    host.emit({ type: "first-frame" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(host.sent).toEqual([{ type: "launch-game" }]);
  });

  it("does not launch the game for a session that is already over", async () => {
    answers["POST /api/sessions/s1/start"] = [409];
    const { host } = await streaming();
    host.emit({ type: "first-frame" });
    await settle();
    expect(host.sent).toEqual([]);
  });

  it("holds the session through the grace while the player is away, and carries on when they return", async () => {
    vi.setSystemTime(1_000_000);
    const { host, sessions, steps } = await streaming();
    host.emit({ type: "peer-joined" });
    host.emit({ type: "first-frame" });
    await settle();
    host.emit({ type: "game-started", appid: 730 });

    host.emit({ type: "peer-left", grace: 120 });
    expect(sessions.at(-1)).toMatchObject({ step: "grace", playerHere: false, graceUntil: 1_120_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    host.emit({ type: "peer-joined" });
    expect(sessions.at(-1)).toMatchObject({ step: "game-started", playerHere: true, graceUntil: null });

    // The grace's own timer was dropped with it.
    await vi.advanceTimersByTimeAsync(120_000 + GRACE_SLACK_MS);
    expect(steps().at(-1)).toBe("game-started");
    expect(host.ends).toBe(0);
  });

  it("ends a session the server did not end once the grace ran out", async () => {
    const { host, steps, live } = await streaming();
    host.emit({ type: "peer-left", grace: 120 });
    await vi.advanceTimersByTimeAsync(120_000 + GRACE_SLACK_MS);
    expect(host.ends).toBe(1);
    expect(calls).toContain("POST /api/sessions/s1/end");
    expect(steps().at(-1)).toBe(null);
    expect(live()).toHaveLength(1);
  });

  it("gives the PC back when the session ends: streamer stopped, account wiped, keys revoked", async () => {
    const { host, sessions, live, steps } = await streaming();
    host.emit({ type: "denied", reason: "session-ended" });
    expect(steps().at(-1)).toBe("ending");
    await settle();

    expect(host.sent).toEqual([{ type: "stop" }]);
    expect(host.ends).toBe(1);
    expect(calls.at(-1)).toBe("DELETE /api/machines/pc-1/session");
    expect(calls).not.toContain("POST /api/sessions/s1/end"); // the server ended it already
    expect(sessions.at(-1)).toBe(null);
    // Back to the machine key, waiting for the next claim.
    expect(live()).toHaveLength(1);
  });

  it("revokes the keys again when the server could not be reached", async () => {
    answers["DELETE /api/machines/pc-1/session"] = [
      "network",
      "network",
      "network",
      "network",
      "network",
      "network",
    ];
    const { host, live } = await streaming();
    host.emit({ type: "denied", reason: "session-ended" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.filter((c) => c.startsWith("DELETE")).length).toBeGreaterThan(3);
    expect(live()).toHaveLength(1);
  });

  it("swaps an expired key for a fresh one, and gives up after a few", async () => {
    const { host } = await streaming();
    host.emit({ type: "denied", reason: "bad-session-key" });
    await settle();
    expect(calls.slice(-2)).toEqual(["DELETE /api/machines/pc-1/session", "POST /api/machines/pc-1/session"]);
    expect(host.sent.at(-1)).toEqual({ type: "key", sessionKey: "key-3" });

    for (let i = 1; i < MAX_RESTARTS; i++) {
      host.emit({ type: "denied", reason: "bad-session-key" });
      await settle();
    }
    expect(host.ends).toBe(0);
    host.emit({ type: "denied", reason: "bad-session-key" });
    await settle();
    expect(host.ends).toBe(1);
    expect(calls).toContain("POST /api/sessions/s1/end");
  });

  it("relaunches a streamer that exited, with a fresh key", async () => {
    const { host } = await streaming();
    host.emit({ type: "exit", code: 1 });
    await settle();
    expect(host.launched.map((l) => l.sessionKey)).toEqual(["key-1", "key-3"]);
    expect(host.logons).toBe(1);
  });

  it("ends the session when the renter's account is lost", async () => {
    const { host } = await streaming();
    host.emit({ type: "lost", why: "signed out" });
    await settle();
    expect(host.ends).toBe(1);
    expect(calls).toContain("POST /api/sessions/s1/end");
  });

  it("ends the session when the renter cannot be signed in, and waits for the next claim", async () => {
    const { sockets, host, live, sessions } = start();
    host.logon.mockRejectedValueOnce(new Error("no renter session"));
    sockets[0]!.onClaim(CLAIM);
    await settle();
    expect(host.launched).toEqual([]);
    expect(host.ends).toBe(1);
    expect(calls).toEqual([
      "POST /api/machines/pc-1/session",
      "POST /api/sessions/s1/end",
      "DELETE /api/machines/pc-1/session",
    ]);
    expect(sessions.at(-1)).toBe(null);
    expect(live()).toHaveLength(1);
  });

  it("goes back to the machine key when the session cannot be started", async () => {
    answers["POST /api/machines/pc-1/session"] = [409];
    const { sockets, host, live } = start();
    sockets[0]!.onClaim(CLAIM);
    await settle();
    expect(host.logons).toBe(0);
    expect(calls).not.toContain("POST /api/sessions/s1/end");
    expect(live()).toHaveLength(1);
  });

  it("turns down a claim it does not accept, and keeps the room", async () => {
    const refused = vi.fn();
    const { sockets, host, live } = start({ acceptClaim: () => false, onClaimRefused: refused });
    sockets[0]!.onClaim(CLAIM);
    await settle();
    expect(refused).toHaveBeenCalledWith(CLAIM);
    expect(calls).toEqual(["POST /api/sessions/s1/end"]);
    expect(host.logons).toBe(0);
    expect(live()).toEqual([sockets[0]]);
  });

  it("serves one claim at a time", async () => {
    const { sockets, host } = start();
    sockets[0]!.onClaim(CLAIM);
    sockets[0]!.onClaim(CLAIM);
    await settle();
    expect(host.logons).toBe(1);
  });

  it("ends a session it lost on a restart, and listens again for its claim", async () => {
    const { sockets, live, denied } = start();
    sockets[0]!.onDenied("session-active");
    await settle();
    expect(calls).toEqual(["DELETE /api/machines/pc-1/session"]);
    expect(live()).toEqual([sockets[1]]);
    expect(denied).not.toHaveBeenCalled();
  });

  it("stops for good when the machine key is refused", () => {
    const { sockets, denied } = start();
    sockets[0]!.onDenied("bad-machine-key");
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it("gives the PC back before it stops", async () => {
    const { handoff, host, live } = await streaming();
    await handoff.stop();
    expect(host.ends).toBe(1);
    expect(calls.at(-1)).toBe("DELETE /api/machines/pc-1/session");
    expect(live()).toHaveLength(0);
  });
});
