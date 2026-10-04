import type { RenterSession, RenterSessionEvent, RenterSessionOptions, RenterStats } from "@swiff/rtc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Claim } from "./booking";
import {
  ignitionLabels,
  ignitionProgress,
  LAUNCH_TIMEOUT_MS,
  NEGOTIATE_TIMEOUT_MS,
  START_RETRY_MS,
  startPlay,
  WAKE_TIMEOUT_MS,
  type PlayState,
} from "./play";

const CLAIM: Claim = { sessionId: "s 1", roomId: "pc-1", signalingUrl: "ws://swiff.test", ticket: "t-1" };
const PC = {} as RTCPeerConnection;
const STATS: RenterStats = {
  fps: 59.9,
  bitrate: 18_000_000,
  rttMs: 12,
  candidateType: "host",
  path: "direct",
  framesDecoded: 120,
};

/** A renter session the test drives: the options it was started with, and its events on demand. */
type FakeSession = RenterSession & {
  options: RenterSessionOptions;
  emit: (event: RenterSessionEvent) => void;
  ended: boolean;
};

let sessions: FakeSession[];
let video: HTMLVideoElement;

beforeEach(() => {
  vi.useFakeTimers();
  sessions = [];
  video = document.createElement("video");
});

afterEach(() => {
  vi.useRealTimers();
});

const start = (options: RenterSessionOptions): RenterSession => {
  const listeners = new Set<(event: RenterSessionEvent) => void>();
  const session: FakeSession = {
    options,
    ended: false,
    on: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stats: () => null,
    end: () => {
      session.ended = true;
    },
    emit: (event) => listeners.forEach((fn) => fn(event)),
  };
  sessions.push(session);
  return session;
};

/** The session joined most recently. */
const latest = () => sessions[sessions.length - 1]!;

/** Start playing CLAIM with the fakes, recording every state and every start call. */
function play() {
  const states: PlayState[] = [];
  const fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
  const onFirstFrame = vi.fn();
  const handle = startPlay({
    claim: CLAIM,
    video,
    onChange: (s) => states.push(s),
    onFirstFrame,
    start,
    fetch,
  });
  return { handle, states, fetch, onFirstFrame, step: () => handle.state().step };
}

describe("startPlay", () => {
  it("joins the claimed room with its ticket, into the video, and is waking the PC", () => {
    const { step } = play();

    expect(sessions).toHaveLength(1);
    expect(latest().options).toMatchObject({
      url: "ws://swiff.test",
      ticket: "t-1",
      video,
      forceRelay: false,
    });
    expect(step()).toBe("waking");
  });

  it("moves through the steps on the connection's events, and is live once the game runs", () => {
    const { step, fetch, onFirstFrame } = play();

    latest().emit({ type: "peer-connection", pc: PC });
    expect(step()).toBe("negotiating");
    latest().emit({ type: "connected" });
    expect(step()).toBe("launching");

    latest().emit({ type: "first-frame" });
    expect(onFirstFrame).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/sessions/s%201/start", {
      method: "POST",
      headers: { authorization: "Bearer t-1" },
    });
    expect(step()).toBe("launching");

    latest().emit({ type: "game-started" });
    expect(step()).toBe("live");
  });

  it("waits for the first frame when the game says it runs before one has arrived", () => {
    const { step } = play();
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "connected" });

    latest().emit({ type: "game-started" });
    expect(step()).toBe("launching");
    latest().emit({ type: "first-frame" });
    expect(step()).toBe("live");
  });

  it("starts the session again on a new connection's first frame, counting the funnel once", () => {
    const { fetch, onFirstFrame } = play();
    latest().emit({ type: "first-frame" });
    latest().emit({ type: "peer-left" });
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "first-frame" });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onFirstFrame).toHaveBeenCalledTimes(1);
  });

  it("calls a PC that has not offered in 60 s slow, and clears it when the offer comes", async () => {
    const { handle, step } = play();

    await vi.advanceTimersByTimeAsync(WAKE_TIMEOUT_MS - 1);
    expect(handle.state().slow).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(handle.state().slow).toBe(true);
    expect(step()).toBe("waking");

    latest().emit({ type: "peer-connection", pc: PC });
    expect(step()).toBe("negotiating");
    expect(handle.state().slow).toBe(false);
  });

  it("tries a connection that has not come up in 20 s again through TURN, then calls it slow", async () => {
    const { handle, step } = play();
    latest().emit({ type: "peer-connection", pc: PC });
    const first = latest();

    await vi.advanceTimersByTimeAsync(NEGOTIATE_TIMEOUT_MS);
    expect(first.ended).toBe(true);
    expect(sessions).toHaveLength(2);
    expect(latest().options).toMatchObject({ ticket: "t-1", forceRelay: true });
    expect(handle.state()).toMatchObject({ step: "negotiating", relayed: true, slow: false });

    // The old session is gone: nothing it still says counts.
    first.emit({ type: "connected" });
    expect(step()).toBe("negotiating");

    await vi.advanceTimersByTimeAsync(NEGOTIATE_TIMEOUT_MS);
    expect(sessions).toHaveLength(2);
    expect(handle.state().slow).toBe(true);

    latest().emit({ type: "connected" });
    expect(handle.state()).toMatchObject({ step: "launching", slow: false });
  });

  it("shows the stream after 90 s even when the game never says it runs", async () => {
    const { step } = play();
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "connected" });
    latest().emit({ type: "first-frame" });

    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS - 1);
    expect(step()).toBe("launching");
    await vi.advanceTimersByTimeAsync(1);
    expect(step()).toBe("live");
  });

  it("never shows a stream whose session start the server refused, and says the ticket was refused", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "the session is over" }), { status: 409 }),
    );
    const handle = startPlay({ claim: CLAIM, video, onChange: () => {}, start, fetch });
    latest().emit({ type: "connected" });
    latest().emit({ type: "first-frame" });
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.state().denied).toBe(true);

    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS);
    expect(handle.state().step).toBe("launching");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("tries a lost start again, and shows the stream at 90 s only once the server has taken it", async () => {
    let up = false;
    const fetch = vi.fn(async () => {
      if (!up) throw new TypeError("offline");
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const handle = startPlay({ claim: CLAIM, video, onChange: () => {}, start, fetch });
    latest().emit({ type: "connected" });
    latest().emit({ type: "first-frame" });

    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS);
    expect(handle.state()).toMatchObject({ step: "launching", slow: true });
    expect(fetch.mock.calls.length).toBeGreaterThan(1);

    up = true;
    await vi.advanceTimersByTimeAsync(START_RETRY_MS);
    expect(handle.state()).toMatchObject({ step: "live", slow: false });
    const calls = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(START_RETRY_MS * 5);
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it("tries a start the server failed again", async () => {
    const answers = [500, 200];
    const fetch = vi.fn(async () => new Response("{}", { status: answers.shift() ?? 200 }));
    const handle = startPlay({ claim: CLAIM, video, onChange: () => {}, start, fetch });
    latest().emit({ type: "connected" });
    latest().emit({ type: "first-frame" });
    await vi.advanceTimersByTimeAsync(START_RETRY_MS);

    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS);
    expect(handle.state().step).toBe("live");
  });

  it("goes back to waking when the PC hands the room over before the game is on screen", () => {
    const { step } = play();
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "connected" });

    latest().emit({ type: "peer-left" });
    expect(step()).toBe("waking");
    latest().emit({ type: "peer-connection", pc: PC });
    expect(step()).toBe("negotiating");
  });

  it("stays live when the PC goes away mid-session", () => {
    const { step } = play();
    latest().emit({ type: "first-frame" });
    latest().emit({ type: "game-started" });

    latest().emit({ type: "peer-left" });
    expect(step()).toBe("live");
  });

  it("keeps the HUD's numbers, says when sound was refused, and when the ticket was", () => {
    const { handle } = play();

    latest().emit({ type: "stats", stats: STATS });
    latest().emit({ type: "autoplay-muted" });
    expect(handle.state()).toMatchObject({ stats: STATS, muted: true, denied: false });

    latest().emit({ type: "denied", reason: "bad-ticket" });
    expect(handle.state().denied).toBe(true);
  });

  it("hangs up and stops every timer when stopped", async () => {
    const { handle, states } = play();
    handle.stop();
    handle.stop();

    expect(latest().ended).toBe(true);
    const seen = states.length;
    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS * 2);
    latest().emit({ type: "connected" });
    expect(states).toHaveLength(seen);
  });

  it("does not let a start lost on the network stop the launch", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("offline");
    });
    const handle = startPlay({ claim: CLAIM, video, onChange: () => {}, start, fetch });
    latest().emit({ type: "first-frame" });
    await vi.advanceTimersByTimeAsync(0);
    latest().emit({ type: "game-started" });

    expect(handle.state().step).toBe("live");
  });
});

describe("Ignition's steps", () => {
  it("names the host and the game, with fallbacks", () => {
    expect(ignitionLabels("Basement rig", "Counter-Strike 2")).toEqual([
      "Reserving a machine",
      "Waking Basement rig",
      "Negotiating stream",
      "Launching Counter-Strike 2",
    ]);
    expect(ignitionLabels(null, undefined)).toEqual([
      "Reserving a machine",
      "Waking the machine",
      "Negotiating stream",
      "Launching your game",
    ]);
  });

  it("gives each step a quarter, creeping on within it but never into the next", () => {
    expect(ignitionProgress("reserving", 0)).toBe(0);
    expect(ignitionProgress("negotiating", 0)).toBe(0.5);
    expect(ignitionProgress("waking", 2_000)).toBeGreaterThan(0.25);
    expect(ignitionProgress("waking", 10 * 60_000)).toBeLessThan(0.5);
    expect(ignitionProgress("launching", 10 * 60_000)).toBeLessThan(1);
  });
});
