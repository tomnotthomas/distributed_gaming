import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Booking } from "./booking";
import { GAMES, MACHINES } from "./data";
import type { PlayState } from "./play";
import { AwayDialog, MachineLost, minutesSeconds, QueueBackDialog, Reconnecting } from "./Reconnect";
import { Session } from "./Session";
import type { Lost, Swiff } from "./useSwiff";

const NOW = 1_000_000;
const cs2 = GAMES.find((g) => g.id === "cs")!;

const playing = (more: Partial<PlayState> = {}): PlayState => ({
  step: "live",
  since: 0,
  slow: false,
  relayed: false,
  stats: null,
  muted: false,
  denied: false,
  replaced: false,
  started: true,
  lostAt: null,
  droppedAt: null,
  gaveUp: false,
  ...more,
});

const booking = (more: Partial<Booking> = {}): Booking => ({
  bookingId: "b-1",
  status: "playing",
  gameId: cs2.appid,
  minutes: 180,
  machine: { id: "h1", name: "Glasshouse", gpu: null, cpu: null, price: 0 },
  ...more,
});

/** Just the slice of the hook the screens read. */
const swiffWith = (more: Partial<Swiff> = {}) =>
  ({
    demo: false,
    games: GAMES,
    game: cs2,
    picked: MACHINES.glass,
    machines: [],
    elapsedMs: 0,
    play: playing(),
    booking: null,
    away: null,
    rejoining: false,
    queueBack: false,
    lost: null,
    bookingFailed: false,
    attachVideo: vi.fn(),
    endSession: vi.fn(),
    stopLost: vi.fn(),
    chooseMachine: vi.fn(),
    reconnect: vi.fn(),
    endAway: vi.fn(),
    keepQueue: vi.fn(),
    leaveQueue: vi.fn(),
    retryConnection: vi.fn(),
    ...more,
  }) as unknown as Swiff;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("minutesSeconds", () => {
  it("reads m:ss, rounding a countdown up so 0:00 means out", () => {
    expect(minutesSeconds(102_000)).toBe("1:42");
    expect(minutesSeconds(12_900)).toBe("0:12");
    expect(minutesSeconds(12_100, true)).toBe("0:13");
    expect(minutesSeconds(-5_000, true)).toBe("0:00");
  });
});

describe("A: a session the page left", () => {
  it("says the game is still the renter's, how long its PC holds it, and counts down", () => {
    const swiff = swiffWith({ away: { booking: booking(), heldUntil: NOW + 102_000 } });
    render(<AwayDialog swiff={swiff} />);

    const dialog = screen.getByRole("dialog", { name: "Counter-Strike 2 is still yours" });
    expect(dialog).toHaveTextContent("Still yours");
    expect(dialog).toHaveTextContent("on Glasshouse");
    expect(dialog).toHaveTextContent("Held for you");
    expect(screen.getByTestId("away-held")).toHaveTextContent("1:42");
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByTestId("away-held")).toHaveTextContent("1:40");
    expect(screen.getByRole("button", { name: "Reconnect" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(swiff.reconnect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    expect(swiff.endAway).toHaveBeenCalledTimes(1);
  });

  it("says it still runs when the PC has not missed the renter yet, and shows a rejoin in flight", () => {
    render(
      <AwayDialog swiff={swiffWith({ away: { booking: booking(), heldUntil: null }, rejoining: true })} />,
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("Still running");
    expect(screen.getByTestId("away-held")).toHaveTextContent("Live");
    expect(screen.getByRole("button", { name: "Reconnecting…" })).toBeDisabled();
  });

  it("is not there without a session to come back to", () => {
    const { container } = render(<AwayDialog swiff={swiffWith()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("B: the connection dropped mid-session", () => {
  it("counts up while it reconnects by itself, with End always there", () => {
    const swiff = swiffWith({ play: playing({ lostAt: NOW - 12_000, droppedAt: NOW - 12_000 }) });
    render(<Session swiff={swiff} />);

    expect(screen.getByRole("dialog", { name: "Reconnecting to Glasshouse" })).toHaveTextContent(
      "on Glasshouse",
    );
    expect(screen.getByTestId("reconnecting-time")).toHaveTextContent("0:12");
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByTestId("reconnecting-time")).toHaveTextContent("0:13");
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Reconnecting to Glasshouse" })).toHaveFocus();
    expect(screen.getAllByRole("button", { name: "End session" }).length).toBeGreaterThan(0);
  });

  it("once it gave up, says how long the game keeps running and offers to try again", () => {
    const swiff = swiffWith({
      play: playing({ lostAt: NOW - 15_000, droppedAt: NOW - 15_000, gaveUp: true }),
    });
    render(<Reconnecting swiff={swiff} host="Glasshouse" />);

    expect(screen.getByRole("dialog", { name: "Can't reach Glasshouse" })).toHaveTextContent(
      "Your game is still running on Glasshouse",
    );
    expect(screen.getByTestId("reconnecting-time")).toHaveTextContent("1:45");
    expect(screen.getByRole("button", { name: "Reconnect" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(swiff.retryConnection).toHaveBeenCalledTimes(1);
  });

  it("counts the hold down from the first drop, however often the renter tried again", () => {
    const swiff = swiffWith({
      play: playing({ lostAt: NOW - 15_000, droppedAt: NOW - 100_000, gaveUp: true }),
    });
    render(<Reconnecting swiff={swiff} host="Glasshouse" />);
    expect(screen.getByTestId("reconnecting-time")).toHaveTextContent("0:20");
  });

  it("is not there while the stream plays", () => {
    render(<Session swiff={swiffWith()} />);
    expect(screen.queryByTestId("reconnecting")).toBeNull();
  });

  it("names a resumed session's machine when the game's list no longer shows it", () => {
    render(
      <Session
        swiff={swiffWith({
          picked: null,
          booking: booking(),
          play: playing({ lostAt: NOW, droppedAt: NOW }),
        })}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Reconnecting to Glasshouse" })).toBeInTheDocument();
  });
});

describe("C: a place in the queue kept", () => {
  it("says it is still finding a machine and that the place is held, with no time it cannot know", () => {
    const swiff = swiffWith({ booking: booking({ status: "queued" }), queueBack: true });
    render(<QueueBackDialog swiff={swiff} />);

    const dialog = screen.getByRole("dialog", { name: "Still finding a machine" });
    expect(dialog).toHaveTextContent("In the queue");
    expect(dialog).toHaveTextContent("held while Swiff stays open");
    expect(dialog).toHaveTextContent("kept for 2 minutes if you close it");
    expect(dialog.textContent).not.toMatch(/\d:\d\d/);
    fireEvent.click(screen.getByRole("button", { name: "Keep waiting" }));
    expect(swiff.keepQueue).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Leave the queue" }));
    expect(swiff.leaveQueue).toHaveBeenCalledTimes(1);
  });

  it("is gone once the booking is no longer queued", () => {
    const { container } = render(
      <QueueBackDialog swiff={swiffWith({ booking: booking({ status: "matched" }), queueBack: true })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("D: a machine lost mid-session", () => {
  /** Glasshouse, lost NOW: gone offline unless `more` says its owner took it back. */
  const lostOn = (more: Partial<Lost> = {}): Lost => ({
    booking: booking({ status: "ended", endReason: "host_offline" }),
    host: "Glasshouse",
    taken: false,
    at: NOW,
    next: null,
    failed: false,
    ...more,
  });

  it("says the machine went offline and counts while the next is found, with Stop for now", () => {
    const swiff = swiffWith({ lost: lostOn() });
    render(<MachineLost swiff={swiff} />);

    const dialog = screen.getByRole("dialog", {
      name: "Glasshouse went offline. Moving you to another machine",
    });
    expect(dialog).toHaveTextContent("Machine lost");
    expect(dialog).toHaveTextContent("Counter-Strike 2");
    expect(dialog).toHaveTextContent("Glasshouse went offline");
    expect(dialog).toHaveTextContent("Finding another machine");
    expect(dialog).not.toHaveTextContent(/save/i);
    expect(screen.getByTestId("machine-lost-time")).toHaveTextContent("0:00");
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.getByTestId("machine-lost-time")).toHaveTextContent("0:03");
    // Nothing to press to carry on: only the way out, and focus on the screen, not on it.
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(dialog).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Stop for now" }));
    expect(swiff.stopLost).toHaveBeenCalledTimes(1);
  });

  it("says the owner took it back, and that it waits for a machine when every one is busy", () => {
    const next = booking({ bookingId: "b-2", status: "queued", machine: undefined });
    render(<MachineLost swiff={swiffWith({ lost: lostOn({ taken: true, next }) })} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Taken back");
    expect(dialog).toHaveTextContent("Glasshouse’s owner took it back");
    expect(dialog).toHaveTextContent("Waiting for a machine");
    expect(dialog).toHaveTextContent("starts by itself the moment one is free");
  });

  it("hands the choice back when no machine could carry it on", () => {
    const swiff = swiffWith({ lost: lostOn({ failed: true }) });
    render(<MachineLost swiff={swiff} />);
    expect(screen.getByRole("dialog")).toHaveTextContent("Couldn't move you");
    expect(screen.queryByTestId("machine-lost-time")).toBeNull();
    expect(screen.getByRole("button", { name: "Choose a machine" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Choose a machine" }));
    expect(swiff.chooseMachine).toHaveBeenCalledTimes(1);
  });

  it("hands it back too when the next machine's claim was refused", () => {
    const next = booking({ bookingId: "b-2", status: "matched" });
    render(<MachineLost swiff={swiffWith({ lost: lostOn({ next }), bookingFailed: true })} />);
    expect(screen.getByRole("button", { name: "Choose a machine" })).toBeInTheDocument();
  });

  it("is not there without a lost machine", () => {
    const { container } = render(<MachineLost swiff={swiffWith()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
