// Sharing: which addresses the machine key may be sent to, that the app
// window holds the room with no capture of its own, and that a claim is
// handed to a renter's session and the PC comes back after.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSessionOptions } from "@swiff/rtc";
import type { HostBridge } from "./bridge";
import type { StreamerEvent } from "./handoff";
import { refusedAddress, toSocketUrl } from "./settings";

const session = { stop: vi.fn(), gameStarted: vi.fn(), rekey: vi.fn() };
const startHostSession = vi.fn((_options: HostSessionOptions) => session);

vi.mock("@swiff/rtc", async (original) => ({
  ...(await original<typeof import("@swiff/rtc")>()),
  startHostSession: (options: HostSessionOptions) => startHostSession(options),
}));

const { useSharing } = await import("./useSharing");

const CREDENTIALS = { machineId: "gaming-pc-1", machineKey: "test-machine-key" };

let emit: (event: StreamerEvent) => void = () => {};
let calls: string[] = [];

function fakeBridge() {
  return {
    sessionLogon: vi.fn(async () => {}),
    sessionLaunch: vi.fn(async () => {}),
    sessionSend: vi.fn(async () => {}),
    sessionEnd: vi.fn(async () => {}),
    onSessionEvent: vi.fn((listener: (event: StreamerEvent) => void) => {
      emit = listener;
      return () => {};
    }),
  };
}

beforeEach(() => {
  startHostSession.mockClear();
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push(`${init.method} ${path}`);
      const status = init.method === "DELETE" ? 204 : path.endsWith("/session") ? 201 : 200;
      return new Response(status === 201 ? JSON.stringify({ sessionKey: "sk" }) : null, { status });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { swiffHost?: unknown }).swiffHost;
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

  it("is checked before any key is sent", async () => {
    const { result } = renderHook(() => useSharing());
    let started = true;
    await act(async () => {
      started = await result.current.start("http://swiff.example", CREDENTIALS);
    });
    expect(started).toBe(false);
    expect(startHostSession).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/would cross the network unencrypted/);
  });
});

describe("sharing", () => {
  it("holds the room with the machine key and no capture", async () => {
    const getDisplayMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getDisplayMedia } });
    const { result } = renderHook(() => useSharing());
    await act(async () => void (await result.current.start("swiff.example", CREDENTIALS)));
    expect(result.current.live).toBe(true);
    expect(startHostSession).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://swiff.example",
        hostId: "gaming-pc-1",
        machineKey: "test-machine-key",
      }),
    );
    expect(startHostSession.mock.calls[0]![0].stream).toBeUndefined();
    expect(getDisplayMedia).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
  });

  it("starts afresh when started again", async () => {
    const { result } = renderHook(() => useSharing());
    await act(async () => void (await result.current.start("swiff.example", CREDENTIALS)));
    await act(async () => void (await result.current.restart()));
    expect(session.stop).toHaveBeenCalled();
    expect(startHostSession).toHaveBeenCalledTimes(2);
  });

  it("hands a claim to a renter's session, and gives the PC back after", async () => {
    const host = fakeBridge();
    (window as { swiffHost?: unknown }).swiffHost = host as Partial<HostBridge>;
    const over = vi.fn();
    const { result } = renderHook(() => useSharing({ onClaimOver: over }));
    await act(async () => void (await result.current.start("swiff.example", CREDENTIALS)));

    const claim = { sessionId: "s1", appid: 730, minutes: 45 };
    await act(async () => {
      startHostSession.mock.calls[0]![0].onSessionClaimed!(claim);
      await vi.waitFor(() => expect(host.sessionLaunch).toHaveBeenCalled());
    });
    expect(host.sessionLogon).toHaveBeenCalled();
    expect(host.sessionLaunch).toHaveBeenCalledWith({
      url: "wss://swiff.example",
      hostId: "gaming-pc-1",
      sessionKey: "sk",
      appid: 730,
    });
    expect(result.current.claim).toMatchObject(claim);
    expect(result.current.step).toBe("launching");

    act(() => emit({ type: "peer-joined" }));
    expect(result.current.peerHere).toBe(true);
    expect(result.current.step).toBe("connecting");

    await act(async () => {
      emit({ type: "denied", reason: "session-ended" });
      await vi.waitFor(() => expect(over).toHaveBeenCalled());
    });
    expect(host.sessionEnd).toHaveBeenCalled();
    expect(result.current.claim).toBeNull();
    expect(calls.at(-1)).toBe("DELETE /api/machines/gaming-pc-1/session");
    // The machine key holds the room again.
    expect(startHostSession).toHaveBeenCalledTimes(2);
  });
});
