// Unit tests for the signaling client, against a fake WebSocket.
//
// The reconnect path is the reason this file exists. A host sits in an empty
// room for hours, the socket drops, and nobody is watching — so the backoff
// doubling, the cap, the 25s keepalive and the "stop retrying once we closed on
// purpose" rule all have to hold without anyone there to notice.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectSignaling, type SignalMessage } from "./signaling";

const TEST_URL = "wss://signal.test";
const PING_MS = 25_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;

/** Minimal stand-in for the browser WebSocket, with the hooks a test needs. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closeCalls = 0;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = FakeSocket.CLOSED;
  }

  // --- test helpers ---
  accept() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(msg: unknown) {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }

  drop() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  get messages(): SignalMessage[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1];

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("connectSignaling", () => {
  it("hands the caller a send function once the socket opens", () => {
    const onOpen = vi.fn((send: (m: SignalMessage) => void) => send({ type: "register", hostId: "pc-1" }));
    connectSignaling({ url: TEST_URL, onOpen, onMessage: vi.fn() });

    expect(onOpen).not.toHaveBeenCalled(); // nothing before the socket is up
    latest().accept();

    expect(onOpen).toHaveBeenCalledOnce();
    expect(latest().messages).toEqual([{ type: "register", hostId: "pc-1" }]);
  });

  it("drops sends made before the socket is open instead of throwing", () => {
    const signaling = connectSignaling({ url: TEST_URL, onOpen: vi.fn(), onMessage: vi.fn() });

    signaling.send({ type: "offer", sdp: { type: "offer", sdp: "v=0" } });

    expect(latest().sent).toEqual([]);
  });

  it("forwards messages to onMessage", () => {
    const onMessage = vi.fn();
    connectSignaling({ url: TEST_URL, onOpen: vi.fn(), onMessage });
    latest().accept();

    latest().deliver({ type: "peer-joined" });

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0][0]).toEqual({ type: "peer-joined" });
  });

  it("swallows pong so the keepalive never reaches the state machine", () => {
    const onMessage = vi.fn();
    connectSignaling({ url: TEST_URL, onOpen: vi.fn(), onMessage });
    latest().accept();

    latest().deliver({ type: "pong" });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ignores a malformed frame without tearing the connection down", () => {
    const onMessage = vi.fn();
    connectSignaling({ url: TEST_URL, onOpen: vi.fn(), onMessage });
    latest().accept();

    latest().deliver("not json at all");
    latest().deliver({ type: "peer-joined" });

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0][0]).toEqual({ type: "peer-joined" });
  });

  it("pings every 25s so an idle socket survives the proxy", () => {
    connectSignaling({ url: TEST_URL, onOpen: vi.fn(), onMessage: vi.fn() });
    latest().accept();

    vi.advanceTimersByTime(PING_MS * 3);

    expect(latest().messages.filter((m) => m.type === "ping")).toHaveLength(3);
  });

  it("stops pinging once the socket is gone", () => {
    connectSignaling({ url: TEST_URL, onOpen: vi.fn(), onMessage: vi.fn() });
    const first = latest();
    first.accept();
    first.drop();

    vi.advanceTimersByTime(PING_MS * 3);

    expect(first.messages.filter((m) => m.type === "ping")).toHaveLength(0);
  });

  it("reconnects after an unexpected close", () => {
    connectSignaling({ url: TEST_URL, onOpen: vi.fn(), onMessage: vi.fn() });
    latest().accept();
    expect(FakeSocket.instances).toHaveLength(1);

    latest().drop();
    vi.advanceTimersByTime(BACKOFF_MIN_MS);

    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("doubles the backoff on each failure and caps it", () => {
    connectSignaling({ url: TEST_URL, onOpen: vi.fn(), onMessage: vi.fn() });

    // Fail repeatedly without ever opening: 500, 1000, 2000, 4000, 8000, 10000…
    const expected = [500, 1000, 2000, 4000, 8000, 10_000, 10_000];
    let sockets = 1;

    for (const delay of expected) {
      latest().drop();
      // One tick short of the delay: nothing should have been retried yet.
      vi.advanceTimersByTime(delay - 1);
      expect(FakeSocket.instances).toHaveLength(sockets);
      vi.advanceTimersByTime(1);
      sockets += 1;
      expect(FakeSocket.instances).toHaveLength(sockets);
    }
  });

  it("resets the backoff after a successful open", () => {
    connectSignaling({ url: TEST_URL, onOpen: vi.fn(), onMessage: vi.fn() });

    latest().drop();
    vi.advanceTimersByTime(BACKOFF_MIN_MS);
    latest().drop();
    vi.advanceTimersByTime(BACKOFF_MIN_MS * 2);
    expect(FakeSocket.instances).toHaveLength(3);

    // A connection that actually came up puts the next retry back at 500ms.
    latest().accept();
    latest().drop();
    vi.advanceTimersByTime(BACKOFF_MIN_MS);

    expect(FakeSocket.instances).toHaveLength(4);
  });

  it("never waits longer than the cap", () => {
    connectSignaling({ url: TEST_URL, onOpen: vi.fn(), onMessage: vi.fn() });
    for (let i = 0; i < 20; i++) {
      latest().drop();
      vi.advanceTimersByTime(BACKOFF_MAX_MS);
    }
    expect(FakeSocket.instances).toHaveLength(21);
  });

  it("stops reconnecting once the caller closes on purpose", () => {
    const signaling = connectSignaling({ url: TEST_URL, onOpen: vi.fn(), onMessage: vi.fn() });
    latest().accept();

    signaling.close();
    latest().drop();
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 5);

    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("closes the underlying socket when the caller closes", () => {
    const signaling = connectSignaling({ url: TEST_URL, onOpen: vi.fn(), onMessage: vi.fn() });
    latest().accept();

    signaling.close();

    expect(latest().closeCalls).toBe(1);
  });

  it("cancels a pending retry when the caller closes mid-backoff", () => {
    const signaling = connectSignaling({ url: TEST_URL, onOpen: vi.fn(), onMessage: vi.fn() });
    latest().drop();

    signaling.close();
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 5);

    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("reports connecting, open and closed in order", () => {
    const onStatus = vi.fn();
    connectSignaling({ url: TEST_URL, onOpen: vi.fn(), onMessage: vi.fn(), onStatus });

    latest().accept();
    latest().drop();
    expect(onStatus.mock.calls.map((c) => c[0])).toEqual(["connecting", "open", "closed"]);

    // The retry announces itself only once the backoff has actually elapsed.
    vi.advanceTimersByTime(BACKOFF_MIN_MS);
    expect(onStatus.mock.calls.map((c) => c[0])).toEqual([
      "connecting",
      "open",
      "closed",
      "connecting",
    ]);
  });
});
