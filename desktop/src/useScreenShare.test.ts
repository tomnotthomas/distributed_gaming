// The screen share: which addresses the machine key may be sent to, and that
// a capture is never left running when it cannot be used.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refusedAddress, toSocketUrl } from "./settings";

const session = { stop: vi.fn() };
const startHostSession = vi.fn((_options: unknown) => session);

vi.mock("@swiff/rtc", () => ({
  DEFAULT_CAPTURE: { width: 1920, frameRate: 60 },
  startHostSession: (options: unknown) => startHostSession(options),
}));

const { useScreenShare } = await import("./useScreenShare");

const CREDENTIALS = { machineId: "gaming-pc-1", machineKey: "test-machine-key" };

/** A captured screen whose tracks record being stopped. */
function fakeCapture({ constraintsFail = false } = {}) {
  const track = {
    stop: vi.fn(),
    applyConstraints: vi.fn(async () => {
      if (constraintsFail) throw new Error("constraints refused");
    }),
    addEventListener: vi.fn(),
    contentHint: "",
  };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}

function stubCapture(getDisplayMedia: () => Promise<MediaStream>) {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getDisplayMedia } });
}

beforeEach(() => {
  startHostSession.mockClear();
});

afterEach(() => {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

describe("the signaling address", () => {
  it("is encrypted unless it is this PC itself", () => {
    expect(refusedAddress(toSocketUrl("hushed-otter-42.trycloudflare.com"))).toBeNull();
    expect(refusedAddress(toSocketUrl("https://swiff.example"))).toBeNull();
    expect(refusedAddress(toSocketUrl("wss://swiff.example"))).toBeNull();
    expect(refusedAddress(toSocketUrl("http://127.0.0.1:8099"))).toBeNull();
    expect(refusedAddress(toSocketUrl("ws://localhost:8080"))).toBeNull();
    expect(refusedAddress(toSocketUrl("http://[::1]:8080"))).toBeNull();
  });

  it("refuses to carry the key unencrypted across the network, and says why", () => {
    for (const address of [
      "http://swiff.example",
      "ws://192.168.1.20:8080",
      "http://127.0.0.1.example.com",
    ]) {
      expect(refusedAddress(toSocketUrl(address))).toMatch(/^Use an https:\/\/ or wss:\/\/ address\./);
    }
    expect(refusedAddress("not a url")).toBe("That signaling server address is not valid.");
  });

  it("is checked before the screen is captured or any key is sent", async () => {
    const getDisplayMedia = vi.fn();
    stubCapture(getDisplayMedia);
    const { result } = renderHook(() => useScreenShare());
    let started = true;
    await act(async () => {
      started = await result.current.start("http://swiff.example", CREDENTIALS);
    });
    expect(started).toBe(false);
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(startHostSession).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/would cross the network unencrypted/);
  });
});

describe("the capture", () => {
  it("is shared once it is set up", async () => {
    const { stream } = fakeCapture();
    stubCapture(async () => stream);
    const { result } = renderHook(() => useScreenShare());
    await act(async () => void (await result.current.start("swiff.example", CREDENTIALS)));
    expect(result.current.stream).toBe(stream);
    expect(startHostSession).toHaveBeenCalledWith(
      expect.objectContaining({ url: "wss://swiff.example", hostId: "gaming-pc-1" }),
    );
  });

  it("is stopped when it cannot be set up, not left running", async () => {
    const { stream, track } = fakeCapture({ constraintsFail: true });
    stubCapture(async () => stream);
    const { result } = renderHook(() => useScreenShare());
    await act(async () => void (await result.current.start("swiff.example", CREDENTIALS)));
    expect(track.stop).toHaveBeenCalled();
    expect(result.current.stream).toBeNull();
    expect(result.current.error).toBe("constraints refused");
  });

  it("is let go when sharing stopped before it arrived", async () => {
    const { stream, track } = fakeCapture();
    let resolve!: (s: MediaStream) => void;
    stubCapture(() => new Promise((r) => (resolve = r)));
    const { result } = renderHook(() => useScreenShare());
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.start("swiff.example", CREDENTIALS);
    });
    act(() => result.current.stop());
    await act(async () => {
      resolve(stream);
      await pending;
    });
    expect(track.stop).toHaveBeenCalled();
    expect(result.current.stream).toBeNull();
    expect(startHostSession).not.toHaveBeenCalled();
  });
});
