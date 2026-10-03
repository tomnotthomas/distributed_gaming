import { beforeEach, describe, expect, it, vi } from "vitest";
import { book, resumeBooking, watchBooking, type Booking, type BookingStatus } from "./booking";

const booking = (status: BookingStatus): Booking => ({ bookingId: "b-1", status, gameId: 730, minutes: 30 });

/** A server that answers GET /api/bookings/b-1 with each status in turn, and POST with a queued booking. */
function fakeServer(statuses: (BookingStatus | 404 | 401)[]) {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    if (init?.method === "POST") return new Response(JSON.stringify(booking("queued")), { status: 202 });
    const next = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
    if (next === 404) return new Response(JSON.stringify({ error: "no such booking" }), { status: 404 });
    if (next === 401)
      return new Response(JSON.stringify({ error: "sign in with Steam first" }), { status: 401 });
    return new Response(JSON.stringify(booking(next)), { status: 200 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("booking across a closed tab", () => {
  beforeEach(() => localStorage.clear());

  it("sends the round trips the page measured with the booking", async () => {
    const server = fakeServer(["queued"]);
    await book(730, 30, { fetch: server.fetch, rtts: { server: 12, machines: { "pc-1": 9 } } });
    await book(730, 30, { fetch: server.fetch });
    const bodies = vi.mocked(server.fetch).mock.calls.map(([, init]) => JSON.parse(String(init!.body)));
    expect(bodies).toEqual([
      { gameId: 730, minutes: 30, rtts: { server: 12, machines: { "pc-1": 9 } } },
      { gameId: 730, minutes: 30 },
    ]);
  });

  it("remembers a new booking and resumes watching it on the next page load", async () => {
    const server = fakeServer(["queued", "matched"]);
    await book(730, 30, { fetch: server.fetch });

    // The tab closes; a new page loads and finds the booking.
    const updates: (BookingStatus | null)[] = [];
    const stop = resumeBooking((b) => updates.push(b?.status ?? null), {
      fetch: server.fetch,
      intervalMs: 5,
      eventSource: null,
    });
    expect(stop).not.toBeNull();
    await settle();
    stop!();

    expect(server.calls[0]).toBe("POST /api/bookings");
    expect(server.calls[1]).toBe("GET /api/bookings/b-1");
    expect(updates.slice(0, 2)).toEqual(["queued", "matched"]);
    expect(localStorage.getItem("swiff.booking")).toBe("b-1");
  });

  it("has nothing to resume when no booking was made", () => {
    expect(resumeBooking(() => {}, { fetch: fakeServer(["queued"]).fetch })).toBeNull();
  });

  for (const end of ["claimed", "ended", "expired", 404, 401] as const) {
    it(`forgets the booking and stops polling once it is ${end}`, async () => {
      const server = fakeServer(["queued", end]);
      await book(730, 30, { fetch: server.fetch });

      const updates: (BookingStatus | null)[] = [];
      resumeBooking((b) => updates.push(b?.status ?? null), {
        fetch: server.fetch,
        intervalMs: 5,
        eventSource: null,
      });
      await settle();

      expect(updates).toEqual(["queued", end === 404 || end === 401 ? null : end]);
      expect(localStorage.getItem("swiff.booking")).toBeNull();
      expect(resumeBooking(() => {}, { fetch: server.fetch })).toBeNull();
    });
  }
});

/** A stand-in for EventSource that the test drives: open, push a booking, drop. */
function fakeStream() {
  const listeners = new Map<string, ((event: Event) => void)[]>();
  const stream = {
    url: "",
    closed: false,
    addEventListener: (type: string, listener: (event: Event) => void) =>
      listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    close: () => {
      stream.closed = true;
    },
    emit: (type: string, event: Event = new Event(type)) => listeners.get(type)?.forEach((l) => l(event)),
    push: (status: BookingStatus) =>
      stream.emit("booking", new MessageEvent("booking", { data: JSON.stringify(booking(status)) })),
  };
  const open = (url: string) => {
    stream.url = url;
    return stream as unknown as EventSource;
  };
  return { stream, open };
}

describe("watching a booking over the event stream", () => {
  beforeEach(() => localStorage.clear());

  it("reports each booking the stream pushes, without polling", async () => {
    const server = fakeServer(["queued"]);
    const { stream, open } = fakeStream();
    const updates: (BookingStatus | null)[] = [];
    const stop = watchBooking("b-1", (b) => updates.push(b?.status ?? null), {
      fetch: server.fetch,
      intervalMs: 5,
      eventSource: open,
    });
    expect(stream.url).toBe("/api/events?booking=b-1");
    stream.push("queued");
    stream.push("matched");
    await settle();
    stop();

    expect(updates).toEqual(["queued", "matched"]);
    expect(server.calls).toEqual([]);
    expect(stream.closed).toBe(true);
  });

  it("closes the stream and forgets the booking once it is claimed", async () => {
    localStorage.setItem("swiff.booking", "b-1");
    const { stream, open } = fakeStream();
    const updates: (BookingStatus | null)[] = [];
    watchBooking("b-1", (b) => updates.push(b?.status ?? null), { eventSource: open });
    stream.push("matched");
    stream.push("claimed");
    stream.push("playing");

    expect(updates).toEqual(["matched", "claimed"]);
    expect(stream.closed).toBe(true);
    expect(localStorage.getItem("swiff.booking")).toBeNull();
  });

  it("falls back to a slow poll while the stream is down, and stops it when the stream is back", async () => {
    const server = fakeServer(["queued"]);
    const { stream, open } = fakeStream();
    const updates: (BookingStatus | null)[] = [];
    const stop = watchBooking("b-1", (b) => updates.push(b?.status ?? null), {
      fetch: server.fetch,
      intervalMs: 5,
      eventSource: open,
    });
    stream.emit("error");
    await settle();
    const polled = server.calls.length;
    expect(polled).toBeGreaterThan(1);
    expect(server.calls[0]).toBe("GET /api/bookings/b-1");

    stream.emit("open");
    stream.push("matched");
    await settle();
    expect(server.calls.length).toBeLessThanOrEqual(polled + 1);
    expect(updates.at(-1)).toBe("matched");
    stop();
  });

  it("keeps one poll going when the stream drops, comes back and drops again while a check is in flight", async () => {
    const waiting: (() => void)[] = [];
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) =>
          waiting.push(() => resolve(new Response(JSON.stringify(booking("queued")), { status: 200 }))),
        ),
    ) as unknown as typeof globalThis.fetch;
    const answerAll = () => waiting.splice(0).forEach((answer) => answer());
    const { stream, open } = fakeStream();
    const stop = watchBooking("b-1", () => {}, { fetch, intervalMs: 5, eventSource: open });

    stream.emit("error");
    stream.emit("open");
    stream.emit("error");
    expect(waiting).toHaveLength(2);

    for (let round = 0; round < 3; round++) {
      answerAll();
      await settle();
      expect(waiting).toHaveLength(1);
    }
    stop();
    answerAll();
  });

  it("beats while the stream is open, through network errors, and stops on stop()", async () => {
    const beats: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      beats.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (beats.length === 1) throw new TypeError("offline");
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;
    const { stream, open } = fakeStream();
    const stop = watchBooking("b-1", () => {}, { fetch, heartbeatMs: 5, eventSource: open });
    stream.push("queued");
    await settle();
    expect(beats.length).toBeGreaterThan(2);
    expect(new Set(beats)).toEqual(new Set(["POST /api/bookings/b-1/seen"]));

    stop();
    const sent = beats.length;
    await settle();
    expect(beats.length).toBe(sent);
  });

  for (const refused of [401, 404] as const) {
    it(`forgets the booking and stops when the heartbeat is refused with ${refused}`, async () => {
      localStorage.setItem("swiff.booking", "b-1");
      const beats: string[] = [];
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        beats.push(`${init?.method ?? "GET"} ${String(url)}`);
        return new Response(null, { status: refused });
      }) as unknown as typeof globalThis.fetch;
      const updates: (BookingStatus | null)[] = [];
      const { stream, open } = fakeStream();
      watchBooking("b-1", (b) => updates.push(b?.status ?? null), {
        fetch,
        heartbeatMs: 5,
        eventSource: open,
      });
      stream.push("queued");
      await settle();

      expect(updates).toEqual(["queued", null]);
      expect(localStorage.getItem("swiff.booking")).toBeNull();
      expect(stream.closed).toBe(true);
      const sent = beats.length;
      await settle();
      expect(beats.length).toBe(sent);
    });
  }

  it("stops beating once the booking is done", async () => {
    const server = fakeServer(["queued"]);
    const { stream, open } = fakeStream();
    watchBooking("b-1", () => {}, { fetch: server.fetch, heartbeatMs: 5, eventSource: open });
    stream.push("matched");
    await settle();
    expect(server.calls.length).toBeGreaterThan(0);

    stream.push("claimed");
    const sent = server.calls.length;
    await settle();
    expect(server.calls.length).toBe(sent);
  });

  it("ends on the poll when the server refused the stream for a booking that is gone", async () => {
    localStorage.setItem("swiff.booking", "b-1");
    const server = fakeServer([404]);
    const { stream, open } = fakeStream();
    const updates: (BookingStatus | null)[] = [];
    watchBooking("b-1", (b) => updates.push(b?.status ?? null), {
      fetch: server.fetch,
      intervalMs: 5,
      eventSource: open,
    });
    stream.emit("error");
    await settle();

    expect(updates).toEqual([null]);
    expect(stream.closed).toBe(true);
    expect(localStorage.getItem("swiff.booking")).toBeNull();
  });
});
