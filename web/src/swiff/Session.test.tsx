import { act, fireEvent, render, screen } from "@testing-library/react";
import type { RenterStats } from "@swiff/rtc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GAMES, MACHINES } from "./data";
import type { PlayState } from "./play";
import { HUD_IDLE_MS, hudReadings, Session } from "./Session";
import type { Swiff } from "./useSwiff";

const STATS: RenterStats = {
  fps: 59.6,
  bitrate: 18_460_000,
  rttMs: 12.4,
  candidateType: "relay",
  path: "relayed",
  framesDecoded: 600,
};

const playing = (more: Partial<PlayState> = {}): PlayState => ({
  step: "live",
  since: 0,
  slow: false,
  relayed: false,
  stats: STATS,
  muted: false,
  denied: false,
  replaced: false,
  started: true,
  lostAt: null,
  droppedAt: null,
  gaveUp: false,
  ...more,
});

/** Just the slice of the hook Session reads: a real session unless `demo`. */
const swiffWith = (more: Partial<Swiff> = {}) =>
  ({
    demo: false,
    game: GAMES[0],
    picked: MACHINES.glass,
    machines: [],
    elapsedMs: 65_000,
    play: playing(),
    attachVideo: vi.fn(),
    endSession: vi.fn(),
    ...more,
  }) as unknown as Swiff;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Session", () => {
  it("plays the stream in its own video and reads the HUD from the connection", () => {
    const swiff = swiffWith();
    render(<Session swiff={swiff} />);

    const video = screen.getByTestId("session-video");
    expect(swiff.attachVideo).toHaveBeenCalledWith(video);
    const hud = screen.getByTestId("hud-stats");
    expect(hud).toHaveTextContent("60 fps");
    expect(hud).toHaveTextContent("12 ms");
    expect(hud).toHaveTextContent("18.5 Mb/s");
    expect(hud).toHaveTextContent("Relayed");
    expect(screen.getByText("0:01:05")).toBeInTheDocument();
  });

  it("shows dashes until the browser has a reading", () => {
    render(<Session swiff={swiffWith({ play: playing({ stats: null }) })} />);
    expect(screen.getByTestId("hud-stats")).toHaveTextContent("– fps– ms– Mb/s");
  });

  it("hides the HUD when the pointer rests and brings it back when it moves", () => {
    render(<Session swiff={swiffWith()} />);
    const session = screen.getByTestId("session");
    expect(session.dataset.hud).toBe("shown");

    act(() => vi.advanceTimersByTime(HUD_IDLE_MS));
    expect(session.dataset.hud).toBe("hidden");

    fireEvent.pointerMove(session);
    expect(session.dataset.hud).toBe("shown");
  });

  it("stays inert behind Ignition, and puts the HUD up afresh once live", () => {
    const { rerender } = render(<Session swiff={swiffWith({ phase: "connecting" })} />);
    const session = screen.getByTestId("session");
    screen.getByTestId<HTMLVideoElement>("session-video").play = vi.fn(async () => {});
    expect(session).toHaveAttribute("inert");

    act(() => vi.advanceTimersByTime(HUD_IDLE_MS * 2));
    expect(session.dataset.hud).toBe("hidden");

    rerender(<Session swiff={swiffWith({ phase: "live" })} />);
    expect(session).not.toHaveAttribute("inert");
    expect(session.dataset.hud).toBe("shown");
    act(() => vi.advanceTimersByTime(HUD_IDLE_MS));
    expect(session.dataset.hud).toBe("hidden");
  });

  it("ends the session with End", () => {
    const swiff = swiffWith();
    render(<Session swiff={swiff} />);
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    expect(swiff.endSession).toHaveBeenCalledTimes(1);
  });

  it("goes full screen on the session, and back", async () => {
    render(<Session swiff={swiffWith()} />);
    const session = screen.getByTestId("session");
    let full: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => full });
    const flip = (next: Element | null) => async () => {
      full = next;
      document.dispatchEvent(new Event("fullscreenchange"));
    };
    session.requestFullscreen = vi.fn(flip(session));
    document.exitFullscreen = vi.fn(flip(null));
    try {
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Full screen" })));
      expect(session.requestFullscreen).toHaveBeenCalled();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Exit full screen" })));
      expect(document.exitFullscreen).toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Full screen" })).toBeInTheDocument();
    } finally {
      delete (document as { fullscreenElement?: unknown }).fullscreenElement;
    }
  });

  it("leaves full screen when the stream drops back behind Ignition", () => {
    const { rerender } = render(<Session swiff={swiffWith({ phase: "live" })} />);
    const session = screen.getByTestId("session");
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => session });
    document.exitFullscreen = vi.fn(async () => {});
    try {
      rerender(<Session swiff={swiffWith({ phase: "live" })} />);
      expect(document.exitFullscreen).not.toHaveBeenCalled();
      rerender(<Session swiff={swiffWith({ phase: "connecting" })} />);
      expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
      expect(session).toHaveAttribute("inert");
    } finally {
      delete (document as { fullscreenElement?: unknown }).fullscreenElement;
    }
  });

  it("offers sound when the browser refused it, and turns it on", () => {
    render(<Session swiff={swiffWith({ play: playing({ muted: true }) })} />);
    const video = screen.getByTestId<HTMLVideoElement>("session-video");
    video.muted = true;
    video.play = vi.fn(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Turn sound on" }));
    expect(video.muted).toBe(false);
    expect(screen.queryByRole("button", { name: "Turn sound on" })).not.toBeInTheDocument();
  });

  it("keeps the stream silent behind Ignition and sounds it once live", async () => {
    const { rerender } = render(<Session swiff={swiffWith({ phase: "connecting" })} />);
    const video = screen.getByTestId<HTMLVideoElement>("session-video");
    expect(video.muted).toBe(true);

    video.play = vi.fn(async () => {});
    await act(async () => rerender(<Session swiff={swiffWith({ phase: "live" })} />));
    expect(video.muted).toBe(false);
    expect(video.play).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Turn sound on" })).not.toBeInTheDocument();
  });

  it("offers sound once live when the browser refuses it after Ignition", async () => {
    const { rerender } = render(<Session swiff={swiffWith({ phase: "connecting" })} />);
    const video = screen.getByTestId<HTMLVideoElement>("session-video");
    video.play = vi.fn(async () => {
      if (!video.muted) throw new Error("NotAllowedError");
    });

    await act(async () => rerender(<Session swiff={swiffWith({ phase: "live" })} />));
    expect(video.muted).toBe(true);
    expect(video.play).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Turn sound on" }));
    expect(video.muted).toBe(false);
  });

  it("stands the trailer in for the stream in the demo, whose machines are invented", () => {
    render(<Session swiff={swiffWith({ demo: true, play: null })} />);
    expect(screen.queryByTestId("session-video")).not.toBeInTheDocument();
    expect(screen.getByTestId("hud-stats")).toHaveTextContent("59 fps");
  });
});

describe("hudReadings", () => {
  it("rounds what a player checks, and says which way the stream goes", () => {
    expect(hudReadings(STATS)).toEqual({ fps: "60", rtt: "12", bitrate: "18.5", path: "Relayed" });
    expect(hudReadings({ ...STATS, path: "direct" }).path).toBe("Direct");
    expect(hudReadings({ ...STATS, path: "unknown" }).path).toBeNull();
  });
});
