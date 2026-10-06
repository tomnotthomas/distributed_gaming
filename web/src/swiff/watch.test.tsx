// Watching a crewmate play, on the page: the wall's line for a crewmate
// playing, the player's say over who watches (over the stream), the voice
// chat's controls, and the viewer's watch, from asking to the player's answer.

import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CrewHub, CrewHubState, MyVoice, WatchSession, WatchSessionEvent } from "@swiff/rtc";
import { CrewLiveBand, CrewOverlay, usePushKey, VoiceBar } from "./Crew";
import type { Swiff } from "./useSwiff";
import { askToWatch, endedLine, fetchCrewLive, useCrewLive, useWatching, type CrewLiveEntry } from "./watch";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ENTRY: CrewLiveEntry = {
  sessionId: "s1",
  starting: false,
  player: "Mara",
  gameId: 1245620,
  machine: "Glasshouse",
  startedAt: 1,
  sharing: false,
  watching: 0,
  mine: null,
};

const VOICE: MyVoice = { inVoice: false, muted: false, mode: "open", talking: false, micRefused: false };

function hubDouble() {
  return {
    answer: vi.fn(),
    stop: vi.fn(),
    share: vi.fn(),
    joinVoice: vi.fn(async () => {}),
    leaveVoice: vi.fn(),
    setMuted: vi.fn(),
    setMode: vi.fn(),
    setTalking: vi.fn(),
    muteForMe: vi.fn(),
    muteForAll: vi.fn(),
  } as unknown as CrewHub & Record<string, ReturnType<typeof vi.fn>>;
}

const watcher = (watchId: string, extra: Partial<CrewHubState["watchers"][number]> = {}) => ({
  watchId,
  name: watchId === "w1" ? "Lea" : "Jon",
  state: "watching" as const,
  here: true,
  connected: true,
  inVoice: false,
  muted: false,
  mutedByPlayer: false,
  mutedForMe: false,
  ...extra,
});

describe("the wall's crew band", () => {
  const swiff = (entries: CrewLiveEntry[], watch = vi.fn()) =>
    ({
      crewLive: entries,
      demo: false,
      games: [{ appid: 1245620, title: "Elden Ring" }],
      watch,
    }) as unknown as Swiff;

  it("says who plays what where, and asks to watch on a click", () => {
    const watch = vi.fn();
    render(<CrewLiveBand swiff={swiff([ENTRY], watch)} />);
    expect(screen.getByTestId("crew-live-line").textContent).toContain(
      "Mara is playing Elden Ring on Glasshouse.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask to watch" }));
    expect(watch).toHaveBeenCalledWith(ENTRY);
  });

  it("watches at once when the player shares with the crew, and waits once asked", () => {
    render(
      <CrewLiveBand
        swiff={swiff([
          { ...ENTRY, sharing: true, watching: 2 },
          { ...ENTRY, sessionId: "s2", player: "Jon", mine: { state: "asking" } },
        ])}
      />,
    );
    expect(screen.getByRole("button", { name: "Watch" })).toBeEnabled();
    expect(screen.getByText("2 watching.", { exact: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Asked" })).toBeDisabled();
  });

  it("says a crewmate still starting is starting, with nothing to ask yet", () => {
    render(<CrewLiveBand swiff={swiff([{ ...ENTRY, starting: true }])} />);
    expect(screen.getByTestId("crew-live-line").textContent).toContain(
      "Mara is starting Elden Ring on Glasshouse.",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows nothing while no crewmate plays", () => {
    const { container } = render(<CrewLiveBand swiff={swiff([])} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("the player's crew overlay", () => {
  const state = (watchers: CrewHubState["watchers"], sharing = false): CrewHubState => ({
    sharing,
    watchers,
    voice: VOICE,
  });

  it("puts a crewmate asking over the game, with a yes and a no", () => {
    const hub = hubDouble();
    render(<CrewOverlay hub={hub} crew={state([watcher("w1", { state: "asking", connected: false })])} />);
    const asks = screen.getByTestId("crew-asks");
    expect(asks.textContent).toContain("Lea would like to watch you play.");
    fireEvent.click(screen.getByRole("button", { name: "Let them watch" }));
    expect(hub.answer).toHaveBeenCalledWith("w1", true);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(hub.answer).toHaveBeenCalledWith("w1", false);
  });

  it("asks nothing for a viewer whose page has gone", () => {
    render(<CrewOverlay hub={hubDouble()} crew={state([watcher("w1", { state: "asking", here: false })])} />);
    expect(screen.queryByTestId("crew-asks")).toBeNull();
  });

  it("lists who watches, each with Stop, and mutes for the player or for everyone", () => {
    const hub = hubDouble();
    render(
      <CrewOverlay
        hub={hub}
        crew={state([watcher("w1", { inVoice: true }), watcher("w2", { connected: false })])}
      />,
    );
    expect(screen.getAllByTestId("crew-watcher").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Lea"),
      expect.stringContaining("Connecting"),
    ]);
    expect(screen.getByText("2 watching")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Stop" })[1]!);
    expect(hub.stop).toHaveBeenCalledWith("w2");
    fireEvent.click(screen.getByRole("button", { name: "Mute for me" }));
    expect(hub.muteForMe).toHaveBeenCalledWith("w1", true);
    fireEvent.click(screen.getByRole("button", { name: "Mute for all" }));
    expect(hub.muteForAll).toHaveBeenCalledWith("w1", true);
  });

  it("shares with the crew, and stops sharing", () => {
    const hub = hubDouble();
    const { rerender } = render(<CrewOverlay hub={hub} crew={state([])} />);
    expect(screen.getByText("Nobody watching")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Share with my crew" }));
    expect(hub.share).toHaveBeenCalledWith(true);
    rerender(<CrewOverlay hub={hub} crew={state([], true)} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing with crew" }));
    expect(hub.share).toHaveBeenCalledWith(false);
  });
});

describe("the voice chat's controls", () => {
  const props = (voice: Partial<MyVoice> = {}, mutedBy: string | null = null) => ({
    voice: { ...VOICE, ...voice },
    mutedBy,
    onJoin: vi.fn(),
    onLeave: vi.fn(),
    onMute: vi.fn(),
    onMode: vi.fn(),
    onTalk: vi.fn(),
  });

  it("says the microphone is used only once joined, and joins", () => {
    const p = props();
    render(<VoiceBar {...p} />);
    expect(screen.getByText(/used only once you join\. Nothing is recorded/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Join voice" }));
    expect(p.onJoin).toHaveBeenCalled();
  });

  it("says so when the microphone was refused", () => {
    render(<VoiceBar {...props({ micRefused: true })} />);
    expect(screen.getByText(/couldn't use your microphone/)).toBeTruthy();
  });

  it("talks while push to talk is held", () => {
    const p = props({ inVoice: true, mode: "push" });
    render(<VoiceBar {...p} />);
    const talk = screen.getByRole("button", { name: "Hold to talk" });
    fireEvent.pointerDown(talk);
    expect(p.onTalk).toHaveBeenLastCalledWith(true);
    fireEvent.pointerUp(talk);
    expect(p.onTalk).toHaveBeenLastCalledWith(false);
  });

  it("mutes, switches mode and leaves", () => {
    const p = props({ inVoice: true });
    render(<VoiceBar {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(p.onMute).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByLabelText("Push to talk"));
    expect(p.onMode).toHaveBeenCalledWith("push");
    fireEvent.click(screen.getByRole("button", { name: "Leave voice" }));
    expect(p.onLeave).toHaveBeenCalled();
  });

  it("says who muted this person for everyone", () => {
    render(<VoiceBar {...props({ inVoice: true }, "Mara")} />);
    expect(screen.getByText("Mara muted you.")).toBeTruthy();
  });

  it("talks on push to talk while the key is held, and stops when the page loses focus", () => {
    const onTalk = vi.fn();
    const { unmount } = renderHook(() => usePushKey("KeyV", true, onTalk));
    fireEvent.keyDown(window, { code: "KeyV" });
    expect(onTalk).toHaveBeenLastCalledWith(true);
    fireEvent.keyUp(window, { code: "KeyV" });
    expect(onTalk).toHaveBeenLastCalledWith(false);
    fireEvent.keyDown(window, { code: "KeyV" });
    fireEvent.blur(window);
    expect(onTalk).toHaveBeenLastCalledWith(false);
    unmount();
  });
});

describe("watching", () => {
  function fetchAnswering(status: number, body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status }));
  }

  it("reads the crew's live sessions, and nothing when they cannot be read", async () => {
    expect(await fetchCrewLive(fetchAnswering(200, { live: [ENTRY] }))).toEqual([ENTRY]);
    expect(await fetchCrewLive(fetchAnswering(401, {}))).toBeNull();
  });

  it("drops a crew read still on its way when the list is turned off", async () => {
    let answer: (r: Response) => void = () => {};
    const get = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    const { result, rerender } = renderHook(({ enabled }) => useCrewLive({ enabled, tick: 0, fetch: get }), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    rerender({ enabled: false });
    await act(async () => answer(new Response(JSON.stringify({ live: [ENTRY] }), { status: 200 })));
    expect(result.current.live).toEqual([]);
  });

  it("tells apart why asking to watch did not go through", async () => {
    expect(await askToWatch("s1", fetchAnswering(404, {}))).toEqual({ ok: false, reason: "gone" });
    expect(await askToWatch("s1", fetchAnswering(409, {}))).toEqual({ ok: false, reason: "full" });
    expect(await askToWatch("s1", fetchAnswering(429, {}))).toEqual({ ok: false, reason: "cooldown" });
    const get = fetchAnswering(200, {
      watchId: "w1",
      state: "asking",
      player: "Mara",
      signalingUrl: "ws://x",
      ticket: "t",
    });
    expect(await askToWatch("s 1", get)).toMatchObject({ ok: true, grant: { watchId: "w1" } });
    expect(get).toHaveBeenCalledWith("/api/crew-live/s%201/watch", { method: "POST" });
  });

  it("asks, waits for the player's yes, plays, and says why it ended", async () => {
    const listeners: ((e: WatchSessionEvent) => void)[] = [];
    const session = { on: (fn: (e: WatchSessionEvent) => void) => listeners.push(fn), end: vi.fn() };
    const start = vi.fn(() => session as unknown as WatchSession);
    const get = fetchAnswering(200, {
      watchId: "w1",
      state: "asking",
      player: "Mara",
      signalingUrl: "ws://swiff.test",
      ticket: "watch-ticket",
    });
    const video = document.createElement("video");
    const { result, unmount } = renderHook(() => useWatching("s1", video, { fetch: get, start }));
    await waitFor(() => expect(result.current.state.phase).toBe("asking"));
    expect(start).toHaveBeenCalledWith({ url: "ws://swiff.test", ticket: "watch-ticket", video });

    const emit = (e: WatchSessionEvent) => act(() => listeners.forEach((fn) => fn(e)));
    emit({ type: "watching", state: "watching", player: "Mara", playerHere: true });
    emit({ type: "first-frame" });
    expect(result.current.state).toMatchObject({ phase: "watching", framed: true });
    emit({ type: "denied", reason: "watch-stopped" });
    expect(result.current.state).toMatchObject({ phase: "over", ended: "watch-stopped" });
    unmount();
    expect(session.end).toHaveBeenCalled();
  });

  it("says plainly why a watch is over", () => {
    expect(endedLine("watch-declined", "Mara")).toBe("Mara would rather play alone right now.");
    expect(endedLine("watch-stopped", "Mara")).toBe("Mara stopped sharing with you.");
    expect(endedLine("not-crew", "Mara")).toBe("You're no longer in a crew with Mara.");
    for (const reason of ["watch-unanswered", "watch-ended", "full", "cooldown", null] as const) {
      expect(endedLine(reason, "Mara")).not.toMatch(/[—–]/);
    }
  });
});
