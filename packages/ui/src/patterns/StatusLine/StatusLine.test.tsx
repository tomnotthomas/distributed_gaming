// Component tests for the status line.
//
// This is the only thing on screen that distinguishes "it connected" from "it
// connected for the reason I think", so the test holds it to showing both the
// connection state and the candidate type, and to keeping them current after
// the first render — ICE upgrades the selected pair late, and a status line
// that reads the stats once would quietly lie about it.

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusLine } from "./StatusLine";
import * as peer from "@swiff/rtc";

/** A peer connection stub whose state and listeners the test drives by hand. */
function fakePc(state: RTCPeerConnectionState = "new") {
  const listeners = new Set<() => void>();
  return {
    connectionState: state,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    /** Move to a new state and fire connectionstatechange, as the browser would. */
    moveTo(next: RTCPeerConnectionState) {
      this.connectionState = next;
      listeners.forEach((fn) => fn());
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

const asPc = (pc: ReturnType<typeof fakePc>) => pc as unknown as RTCPeerConnection;

/** Let the polled getStats promise settle and React flush the result. */
async function tick(ms = 1000) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("StatusLine", () => {
  it("shows a neutral state when there is no connection yet", () => {
    render(<StatusLine pc={null} />);

    expect(screen.getByText("new")).toBeInTheDocument();
    expect(screen.getByText("unknown")).toBeInTheDocument();
    expect(screen.getByText(/no candidate pair selected yet/)).toBeInTheDocument();
  });

  it("renders the note it is given", () => {
    render(<StatusLine pc={null} note="not capturing" />);

    expect(screen.getByText(/not capturing/)).toBeInTheDocument();
  });

  it("omits the note separator when there is no note", () => {
    const { container } = render(<StatusLine pc={null} />);

    expect(container.textContent).not.toContain(" · not");
  });

  it("picks up the connection state it was handed", () => {
    render(<StatusLine pc={asPc(fakePc("connecting"))} />);

    expect(screen.getByText("connecting")).toBeInTheDocument();
  });

  it("follows the connection into connected and then failed", () => {
    const pc = fakePc("connecting");
    render(<StatusLine pc={asPc(pc)} />);

    act(() => pc.moveTo("connected"));
    expect(screen.getByText("connected")).toBeInTheDocument();

    act(() => pc.moveTo("failed"));
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  it("marks the state on the dot so it can be styled", () => {
    const pc = fakePc("connecting");
    const { container } = render(<StatusLine pc={asPc(pc)} />);

    act(() => pc.moveTo("connected"));

    expect(container.querySelector(".status-dot")).toHaveAttribute("data-tone", "live");
  });

  it("shows the winning candidate type and what it means", async () => {
    vi.spyOn(peer, "selectedCandidateType").mockResolvedValue("srflx");
    render(<StatusLine pc={asPc(fakePc("connected"))} />);

    await tick();

    expect(screen.getByText("srflx")).toBeInTheDocument();
    expect(screen.getByText(/direct across the internet/)).toBeInTheDocument();
  });

  it("warns that a host candidate proves nothing about the internet path", async () => {
    vi.spyOn(peer, "selectedCandidateType").mockResolvedValue("host");
    render(<StatusLine pc={asPc(fakePc("connected"))} />);

    await tick();

    expect(screen.getByText(/same local network/)).toBeInTheDocument();
    expect(screen.getByText(/proves nothing/)).toBeInTheDocument();
  });

  it("says relay costs bandwidth when TURN is carrying the stream", async () => {
    vi.spyOn(peer, "selectedCandidateType").mockResolvedValue("relay");
    render(<StatusLine pc={asPc(fakePc("connected"))} />);

    await tick();

    expect(screen.getByText(/costing bandwidth/)).toBeInTheDocument();
  });

  it("keeps polling, so a late ICE upgrade is not missed", async () => {
    const spy = vi
      .spyOn(peer, "selectedCandidateType")
      .mockResolvedValueOnce("host")
      .mockResolvedValue("srflx");
    render(<StatusLine pc={asPc(fakePc("connected"))} />);

    await tick();
    expect(screen.getByText("host")).toBeInTheDocument();

    await tick();
    expect(screen.getByText("srflx")).toBeInTheDocument();
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("resets to neutral when the connection is torn down", async () => {
    vi.spyOn(peer, "selectedCandidateType").mockResolvedValue("srflx");
    const { rerender } = render(<StatusLine pc={asPc(fakePc("connected"))} />);
    await tick();
    expect(screen.getByText("srflx")).toBeInTheDocument();

    rerender(<StatusLine pc={null} />);

    expect(screen.getByText("new")).toBeInTheDocument();
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });

  it("stops polling and unsubscribes on unmount", async () => {
    const spy = vi.spyOn(peer, "selectedCandidateType").mockResolvedValue("srflx");
    const pc = fakePc("connected");
    const { unmount } = render(<StatusLine pc={asPc(pc)} />);
    await tick();
    const callsWhileMounted = spy.mock.calls.length;

    unmount();
    await tick(5000);

    expect(spy.mock.calls.length).toBe(callsWhileMounted);
    expect(pc.listenerCount).toBe(0);
  });
});
