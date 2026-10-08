import { STEAM_SIGN_IN_MS } from "@swiff/rank";
import type {
  CrewHub,
  RenterSession,
  RenterSessionEvent,
  RenterSessionOptions,
  RenterStats,
} from "@swiff/rtc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Claim } from "./booking";
import { screenText } from "./screenCopy";
import {
  ignitionLabels,
  ignitionProgress,
  LAUNCH_TIMEOUT_MS,
  NEGOTIATE_TIMEOUT_MS,
  RECONNECT_AUTO_MS,
  RECONNECT_EVERY_MS,
  RECONNECT_WAIT_MS,
  START_RETRY_MS,
  startPlay,
  WAKE_TIMEOUT_MS,
  type PlayState,
} from "./play";

const CLAIM: Claim = {
  sessionId: "s 1",
  roomId: "pc-1",
  signalingUrl: "ws://swiff.test",
  ticket: "t-1",
  rentalMode: false,
};
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
  retries: number;
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
    retries: 0,
    retrySteamLogin: () => {
      session.retries += 1;
    },
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
function play(resume = false, droppedAt?: number, claim: Claim = CLAIM) {
  const states: PlayState[] = [];
  const fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
  const onFirstFrame = vi.fn();
  const handle = startPlay({
    claim,
    video,
    onChange: (s) => states.push(s),
    onFirstFrame,
    start,
    fetch,
    resume,
    droppedAt,
  });
  return { handle, states, fetch, onFirstFrame, step: () => handle.state().step };
}

/** Play until the game is on screen. */
function live() {
  const playing = play();
  latest().emit({ type: "peer-connection", pc: PC });
  latest().emit({ type: "connected" });
  latest().emit({ type: "first-frame" });
  latest().emit({ type: "game-started" });
  expect(playing.step()).toBe("live");
  return playing;
}

describe("reconnecting", () => {
  it("says the connection dropped, waits for it, and joins the room again with the same ticket", async () => {
    const { handle } = live();
    vi.setSystemTime(50_000);

    latest().emit({ type: "disconnected", failed: false });
    expect(handle.state()).toMatchObject({ step: "live", lostAt: 50_000, gaveUp: false, stats: null });
    expect(sessions).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(RECONNECT_WAIT_MS);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.ended).toBe(true);
    expect(latest().options).toMatchObject({ ticket: "t-1", forceRelay: false });

    await vi.advanceTimersByTimeAsync(RECONNECT_EVERY_MS);
    expect(sessions).toHaveLength(3);
  });

  it("lets a join the PC answered finish, and joins again only once it fails", async () => {
    live();
    latest().emit({ type: "disconnected", failed: false });
    await vi.advanceTimersByTimeAsync(RECONNECT_WAIT_MS);
    expect(sessions).toHaveLength(2);

    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "connected" });
    await vi.advanceTimersByTimeAsync(RECONNECT_EVERY_MS * 2);
    expect(sessions).toHaveLength(2);
    expect(latest().ended).toBe(false);

    latest().emit({ type: "disconnected", failed: true });
    await vi.advanceTimersByTimeAsync(RECONNECT_EVERY_MS);
    expect(sessions).toHaveLength(3);
  });

  it("joins again at once when the connection failed and cannot come back by itself", async () => {
    live();
    latest().emit({ type: "disconnected", failed: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions).toHaveLength(2);
  });

  it("is back when the connection comes back by itself, or a new one shows the game", async () => {
    const { handle } = live();
    latest().emit({ type: "disconnected", failed: false });
    latest().emit({ type: "connected" });
    expect(handle.state()).toMatchObject({ step: "live", lostAt: null });
    await vi.advanceTimersByTimeAsync(RECONNECT_AUTO_MS);
    expect(sessions).toHaveLength(1);

    latest().emit({ type: "disconnected", failed: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions).toHaveLength(2);
    // A new connection's frames may be the desktop: back only with a fresh game-started.
    latest().emit({ type: "connected" });
    latest().emit({ type: "first-frame" });
    expect(handle.state().lostAt).not.toBeNull();
    latest().emit({ type: "game-started" });
    expect(handle.state()).toMatchObject({ step: "live", lostAt: null, gaveUp: false });
  });

  it("never treats a drop before the game is on screen as a reconnect", () => {
    const { handle } = play();
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "disconnected", failed: true });
    expect(handle.state()).toMatchObject({ step: "negotiating", lostAt: null });
    expect(sessions).toHaveLength(1);
  });

  it("gives up reconnecting by itself after 15 s, and tries again when the renter asks", async () => {
    const { handle } = live();
    const dropped = Date.now();
    latest().emit({ type: "disconnected", failed: false });
    await vi.advanceTimersByTimeAsync(RECONNECT_AUTO_MS);
    expect(handle.state()).toMatchObject({ gaveUp: true });
    const joins = sessions.length;
    expect(latest().ended).toBe(true);
    await vi.advanceTimersByTimeAsync(RECONNECT_AUTO_MS);
    expect(sessions).toHaveLength(joins);

    vi.setSystemTime(90_000);
    handle.retry();
    // Reconnecting counts from the retry; the PC's hold still from the drop.
    expect(handle.state()).toMatchObject({ lostAt: 90_000, droppedAt: dropped, gaveUp: false });
    expect(sessions).toHaveLength(joins + 1);
    latest().emit({ type: "first-frame" });
    expect(handle.state().lostAt).not.toBeNull();
    latest().emit({ type: "game-started" });
    expect(handle.state()).toMatchObject({ lostAt: null, droppedAt: null });
  });

  it("stops reconnecting when the server refuses the ticket", async () => {
    const { handle } = live();
    latest().emit({ type: "disconnected", failed: true });
    latest().emit({ type: "denied", reason: "bad-ticket" });
    const joins = sessions.length;
    await vi.advanceTimersByTimeAsync(RECONNECT_AUTO_MS);
    expect(sessions).toHaveLength(joins);
    expect(handle.state()).toMatchObject({ denied: true, gaveUp: false });
  });

  it("stops, without taking the seat back, when another page took it with the same ticket", async () => {
    const { handle } = live();
    latest().emit({ type: "disconnected", failed: false });
    latest().emit({ type: "denied", reason: "replaced" });
    const joins = sessions.length;
    await vi.advanceTimersByTimeAsync(RECONNECT_AUTO_MS);
    expect(sessions).toHaveLength(joins);
    expect(handle.state()).toMatchObject({ replaced: true, denied: false });

    handle.retry();
    expect(sessions).toHaveLength(joins);
  });

  it("stops every reconnect timer when stopped", async () => {
    const { handle } = live();
    latest().emit({ type: "disconnected", failed: false });
    handle.stop();
    await vi.advanceTimersByTimeAsync(RECONNECT_AUTO_MS);
    expect(sessions).toHaveLength(1);
    expect(handle.state().gaveUp).toBe(false);
  });

  it("comes back to a session already playing with no Ignition, live once the game shows", async () => {
    vi.setSystemTime(10_000);
    const { handle, fetch } = play(true, 4_000);
    expect(handle.state()).toMatchObject({
      step: "live",
      lostAt: 10_000,
      droppedAt: 4_000,
      gaveUp: false,
      started: true,
    });
    expect(sessions).toHaveLength(1);

    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "first-frame" });
    expect(handle.state()).toMatchObject({ step: "live", lostAt: 10_000 });
    latest().emit({ type: "game-started" });
    expect(handle.state()).toMatchObject({ step: "live", lostAt: null });
    expect(fetch).toHaveBeenCalledWith("/api/sessions/s%201/start", expect.anything());
  });

  it("starts a resumed rental-mode session on its first frame: its renter signed in before", () => {
    const { handle, fetch } = play(true, 4_000, { ...CLAIM, rentalMode: true });
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "first-frame" });
    expect(fetch).toHaveBeenCalledWith("/api/sessions/s%201/start", expect.anything());
    latest().emit({ type: "game-started" });
    expect(handle.state()).toMatchObject({ step: "live", lostAt: null });
  });

  it("joins a resumed session again while no frame shows, and gives up after 15 s", async () => {
    const { handle } = play(true);
    await vi.advanceTimersByTimeAsync(RECONNECT_EVERY_MS);
    expect(sessions).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(RECONNECT_AUTO_MS);
    expect(handle.state().gaveUp).toBe(true);
  });
});

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

  it("never shows the stream before the game runs: at 90 s Ignition stays, and the launch is slow", async () => {
    const { handle, step } = play();
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "connected" });
    latest().emit({ type: "first-frame" });

    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS - 1);
    expect(handle.state()).toMatchObject({ step: "launching", slow: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(handle.state()).toMatchObject({ step: "launching", slow: true });
    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS * 3);
    expect(step()).toBe("launching");

    // The PC says the game runs after all: it is shown then.
    latest().emit({ type: "game-started" });
    expect(handle.state()).toMatchObject({ step: "live", slow: false });
  });

  it("says once the server has taken the session start, so leaving ends a session", async () => {
    const { handle } = play();
    expect(handle.state().started).toBe(false);
    latest().emit({ type: "first-frame" });
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.state().started).toBe(true);
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

  it("tries a lost start again every 2 s until the server takes it, and then no more", async () => {
    let up = false;
    const fetch = vi.fn(async () => {
      if (!up) throw new TypeError("offline");
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const handle = startPlay({ claim: CLAIM, video, onChange: () => {}, start, fetch });
    latest().emit({ type: "connected" });
    latest().emit({ type: "first-frame" });

    await vi.advanceTimersByTimeAsync(START_RETRY_MS * 3);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(handle.state().started).toBe(false);

    up = true;
    await vi.advanceTimersByTimeAsync(START_RETRY_MS);
    expect(handle.state().started).toBe(true);
    const calls = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(START_RETRY_MS * 5);
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect(handle.state().step).toBe("launching");
  });

  it("tries a start the server failed again", async () => {
    const answers = [500, 200];
    const fetch = vi.fn(async () => new Response("{}", { status: answers.shift() ?? 200 }));
    const handle = startPlay({ claim: CLAIM, video, onChange: () => {}, start, fetch });
    latest().emit({ type: "connected" });
    latest().emit({ type: "first-frame" });
    await vi.advanceTimersByTimeAsync(START_RETRY_MS);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(handle.state().started).toBe(true);
  });

  it("tries a reconnect's lost start again, so the PC still hears to launch the game", async () => {
    const answers = [200, 0, 500, 200];
    const fetch = vi.fn(async () => {
      const status = answers.shift() ?? 200;
      if (!status) throw new TypeError("offline");
      return new Response("{}", { status });
    });
    const handle = startPlay({ claim: CLAIM, video, onChange: () => {}, start, fetch });
    latest().emit({ type: "first-frame" });
    latest().emit({ type: "game-started" });
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.state()).toMatchObject({ step: "live", started: true });

    latest().emit({ type: "peer-left" });
    latest().emit({ type: "first-frame" });
    await vi.advanceTimersByTimeAsync(START_RETRY_MS * 2);
    expect(fetch).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(START_RETRY_MS * 5);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("drops a lost start's retry once its connection is gone", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 503 }));
    startPlay({ claim: CLAIM, video, onChange: () => {}, start, fetch });
    latest().emit({ type: "first-frame" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    latest().emit({ type: "peer-left" });
    await vi.advanceTimersByTimeAsync(START_RETRY_MS * 5);
    expect(fetch).toHaveBeenCalledTimes(1);
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

  it("goes back behind Ignition when the PC leaves mid-session, until a new frame and a fresh game-started", async () => {
    const { handle, step, fetch } = play();
    latest().emit({ type: "first-frame" });
    latest().emit({ type: "game-started" });
    expect(step()).toBe("live");

    latest().emit({ type: "peer-left" });
    expect(handle.state()).toMatchObject({ step: "waking", slow: false });

    // The old game-started does not count for the new connection.
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "connected" });
    latest().emit({ type: "first-frame" });
    expect(step()).toBe("launching");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);

    latest().emit({ type: "game-started" });
    expect(step()).toBe("live");
  });

  it("keeps the 60 s wake timeout after a mid-session drop", async () => {
    const { handle } = play();
    latest().emit({ type: "first-frame" });
    latest().emit({ type: "game-started" });
    latest().emit({ type: "peer-left" });

    await vi.advanceTimersByTimeAsync(WAKE_TIMEOUT_MS);
    expect(handle.state()).toMatchObject({ step: "waking", slow: true });
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

describe("crewmates watching", () => {
  /** A crew hub that records what the play tells it. */
  function fakeCrew() {
    const live: boolean[] = [];
    const crew = {
      setLive: vi.fn((on: boolean) => live.push(on)),
      end: vi.fn(),
    } as unknown as CrewHub & { setLive: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    return { crew, live: () => live[live.length - 1] };
  }

  it("hands one crew hub to every connection, shows viewers the game only while it is on screen, and ends it with the play", async () => {
    const { crew, live: viewersSee } = fakeCrew();
    const handle = startPlay({ claim: CLAIM, video, onChange: () => {}, start, startCrew: () => crew });
    expect(handle.crew).toBe(crew);
    expect(latest().options.crew).toBe(crew);
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "connected" });
    latest().emit({ type: "first-frame" });
    // The PC's desktop, before the game runs: viewers see nothing yet.
    expect(viewersSee()).toBe(false);
    latest().emit({ type: "game-started" });
    expect(viewersSee()).toBe(true);

    // Dropped: nothing while reconnecting, and the next connection gets the same hub.
    latest().emit({ type: "disconnected", failed: true });
    expect(viewersSee()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions).toHaveLength(2);
    expect(latest().options.crew).toBe(crew);

    handle.stop();
    expect(crew.end).toHaveBeenCalled();
  });
});

describe("Ignition's steps", () => {
  it("names the host and the game, with fallbacks", () => {
    expect(ignitionLabels(screenText("en"), "Basement rig", "Counter-Strike 2")).toEqual([
      "Reserving a PC",
      "Waking Basement rig",
      "Negotiating stream",
      "Launching Counter-Strike 2",
    ]);
    expect(ignitionLabels(screenText("en"), null, undefined)).toEqual([
      "Reserving a PC",
      "Waking the PC",
      "Negotiating stream",
      "Launching your game",
    ]);
    expect(ignitionLabels(screenText("de"), "Basement rig", null)).toEqual([
      "PC wird reserviert",
      "Basement rig wird geweckt",
      "Übertragung wird eingerichtet",
      "Dein Spiel wird gestartet",
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

describe("startPlay on a rental-mode PC (Steam sign-in)", () => {
  const QR = { type: "steam-login", state: "qr", url: "https://s.team/q/1/42" } as const;

  it("shows Steam's code as soon as the PC sends it, before the stream connects", () => {
    const { handle, step } = play();

    latest().emit(QR);
    expect(step()).toBe("waking");
    expect(handle.state().steamLogin).toEqual(QR);
  });

  it("is never slow while the renter scans the code, and goes live only once the game runs", async () => {
    const { handle, step } = play();
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit(QR);
    latest().emit({ type: "connected" });
    latest().emit({ type: "first-frame" });

    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS * 4);
    expect(handle.state()).toMatchObject({ step: "launching", slow: false });

    latest().emit({ type: "steam-login", state: "signed-in" });
    expect(handle.state().steamLogin).toEqual({ type: "steam-login", state: "signed-in" });
    // From approval the game has the launch's own time to come up.
    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS);
    expect(handle.state()).toMatchObject({ step: "launching", slow: true });

    latest().emit({ type: "game-started" });
    expect(step()).toBe("live");
  });

  it("says a failed sign-in, never slow and never live, and asks the same PC again on retry", async () => {
    const { handle, step } = play();
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "connected" });
    latest().emit({ type: "first-frame" });
    latest().emit(QR);
    latest().emit({ type: "steam-login", state: "signed-in" });
    latest().emit({ type: "steam-login", state: "failed" });

    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS * 2);
    expect(handle.state()).toMatchObject({
      step: "launching",
      slow: false,
      signInFailed: "sign-in-timeout",
      steamLogin: null,
    });

    handle.retrySignIn();
    expect(latest().retries).toBe(1);
    expect(sessions).toHaveLength(1);
    expect(handle.state().signInFailed).toBeNull();

    latest().emit({ ...QR, url: "https://s.team/q/1/43" });
    expect(handle.state().steamLogin).toEqual({ ...QR, url: "https://s.team/q/1/43" });
    expect(step()).toBe("launching");
  });

  it("offers Try again until the claim's sign-in time runs out, then nothing from that claim", async () => {
    vi.setSystemTime(0);
    const { handle, fetch } = play(false, undefined, {
      ...CLAIM,
      rentalMode: true,
      signInBy: STEAM_SIGN_IN_MS,
    });
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "connected" });
    latest().emit(QR);
    await vi.advanceTimersByTimeAsync(STEAM_SIGN_IN_MS - 2_000);
    latest().emit({ type: "steam-login", state: "failed" });

    // A second before the deadline the PC is still asked for a new code.
    await vi.advanceTimersByTimeAsync(1_000);
    handle.retrySignIn();
    expect(latest().retries).toBe(1);
    latest().emit({ ...QR, url: "https://s.team/q/1/43" });
    expect(handle.state().steamLogin).toEqual({ ...QR, url: "https://s.team/q/1/43" });

    // At it the code is gone, and no new one, retry or late approval starts anything.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(handle.state()).toMatchObject({ signInFailed: "time-up", steamLogin: null, slow: false });
    handle.retrySignIn();
    expect(latest().retries).toBe(1);
    latest().emit({ ...QR, url: "https://s.team/q/1/44" });
    latest().emit({ type: "steam-login", state: "signed-in" });
    latest().emit({ type: "first-frame" });
    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS);
    expect(handle.state()).toMatchObject({
      signInFailed: "time-up",
      steamLogin: null,
      slow: false,
      started: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says the sign-in time ran out, not a refusal, when the server ends the claim at its deadline", async () => {
    vi.setSystemTime(0);
    const { handle } = play(false, undefined, { ...CLAIM, rentalMode: true, signInBy: STEAM_SIGN_IN_MS });
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "connected" });
    latest().emit(QR);
    await vi.advanceTimersByTimeAsync(STEAM_SIGN_IN_MS);
    // The server's tick ends the claim and revokes its ticket.
    latest().emit({ type: "denied", reason: "bad-ticket" });
    expect(handle.state()).toMatchObject({ signInFailed: "time-up", denied: false, steamLogin: null });
  });

  it("keeps a session signed in before the claim's sign-in time ran out", async () => {
    vi.setSystemTime(0);
    const { handle, fetch } = play(false, undefined, {
      ...CLAIM,
      rentalMode: true,
      signInBy: STEAM_SIGN_IN_MS,
    });
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "connected" });
    latest().emit(QR);
    latest().emit({ type: "steam-login", state: "signed-in" });
    latest().emit({ type: "first-frame" });
    await vi.advanceTimersByTimeAsync(STEAM_SIGN_IN_MS);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(handle.state().signInFailed).toBeNull();
  });

  it("calls a PC that never answers a retry slow, like any launch", async () => {
    const { handle } = play();
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "connected" });
    latest().emit({ type: "steam-login", state: "failed" });

    handle.retrySignIn();
    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS);
    expect(handle.state()).toMatchObject({ step: "launching", slow: true });
  });

  it("does not start the session while the code is up, and starts it on the first frame after signed-in", async () => {
    const { fetch } = play();
    latest().emit(QR);
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "connected" });
    await vi.advanceTimersByTimeAsync(START_RETRY_MS * 3);
    expect(fetch).not.toHaveBeenCalled();

    latest().emit({ type: "steam-login", state: "signed-in" });
    expect(fetch).not.toHaveBeenCalled();
    latest().emit({ type: "first-frame" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/sessions/s%201/start", {
      method: "POST",
      headers: { authorization: "Bearer t-1" },
    });
  });

  it("starts the session at signed-in when a frame came while the code was up", async () => {
    const { handle, fetch } = play();
    latest().emit(QR);
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "connected" });
    latest().emit({ type: "first-frame" });
    expect(fetch).not.toHaveBeenCalled();

    latest().emit({ type: "steam-login", state: "signed-in" });
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.state().started).toBe(true);
  });

  it("never starts the session on a failed sign-in or its retry, only after the next signed-in", async () => {
    const { handle, fetch } = play();
    latest().emit(QR);
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "connected" });
    latest().emit({ type: "first-frame" });
    latest().emit({ type: "steam-login", state: "failed" });
    handle.retrySignIn();
    latest().emit({ type: "peer-left" });
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "connected" });
    latest().emit({ type: "first-frame" });
    latest().emit({ ...QR, url: "https://s.team/q/1/43" });
    latest().emit({ type: "first-frame" });
    await vi.advanceTimersByTimeAsync(START_RETRY_MS * 3);
    expect(fetch).not.toHaveBeenCalled();
    expect(handle.state().started).toBe(false);

    latest().emit({ type: "steam-login", state: "signed-in" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("on a rental-mode claim, does not start the session on a frame before any code, only on one after signed-in", () => {
    const { fetch } = play(false, undefined, { ...CLAIM, rentalMode: true });
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "connected" });
    latest().emit({ type: "first-frame" });
    expect(fetch).not.toHaveBeenCalled();

    latest().emit(QR);
    latest().emit({ type: "first-frame" });
    expect(fetch).not.toHaveBeenCalled();

    latest().emit({ type: "peer-left" });
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "connected" });
    latest().emit({ type: "steam-login", state: "signed-in" });
    expect(fetch).not.toHaveBeenCalled();
    latest().emit({ type: "first-frame" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never posts a lost start's retry once a code is up", async () => {
    const { fetch } = play();
    fetch.mockResolvedValueOnce(new Response("", { status: 503 }));
    latest().emit({ type: "peer-connection", pc: PC });
    latest().emit({ type: "connected" });
    latest().emit({ type: "first-frame" });
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);

    latest().emit(QR);
    await vi.advanceTimersByTimeAsync(START_RETRY_MS * 5);
    expect(fetch).toHaveBeenCalledTimes(1);

    latest().emit({ type: "steam-login", state: "signed-in" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps why the sign-in stopped short: the game never coming up after it, or the code by default", () => {
    const { handle } = play();
    latest().emit({ type: "steam-login", state: "failed", reason: "launch-timeout" });
    expect(handle.state().signInFailed).toBe("launch-timeout");
    handle.retrySignIn();
    latest().emit({ type: "steam-login", state: "failed" });
    expect(handle.state().signInFailed).toBe("sign-in-timeout");
  });

  it("asks for a retry only after a failed sign-in", () => {
    const { handle } = play();
    latest().emit(QR);

    handle.retrySignIn();
    expect(latest().retries).toBe(0);
  });
});
