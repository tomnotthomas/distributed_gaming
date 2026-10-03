import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  book,
  bookMachine,
  BookingRefused,
  claim,
  endBooking,
  followBooking,
  resumeBooking,
  watchBooking,
  type Booking,
  type BookingStatus,
  type Claim,
} from "./booking";

const booking = (status: BookingStatus, claimBy?: number): Booking => ({
  bookingId: "b-1",
  status,
  gameId: 730,
  minutes: 30,
  ...(claimBy === undefined ? {} : { claimBy }),
});

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
    push: (status: BookingStatus, claimBy?: number) =>
      stream.emit("booking", new MessageEvent("booking", { data: JSON.stringify(booking(status, claimBy)) })),
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

const TICKET: Claim = { sessionId: "s-1", roomId: "pc-1", signalingUrl: "ws://localhost", ticket: "t" };

/** A server for the booking calls: each answers what `routes` says for "METHOD path", 404 otherwise. */
function routes(answers: Record<string, () => Response>) {
  const calls: { call: string; body: unknown }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = `${init?.method ?? "GET"} ${String(url)}`;
    calls.push({ call, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return answers[call]?.() ?? new Response("{}", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, made: () => calls.map((c) => c.call) };
}

const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });

describe("booking a picked machine", () => {
  beforeEach(() => localStorage.clear());

  it("books it with the renter's round trips and remembers the booking", async () => {
    const server = routes({ "POST /api/bookings": json(202, booking("matched", 1_000)) });
    const result = await bookMachine("pc-1", 730, 30, { fetch: server.fetch, rtts: { server: 8 } });
    expect(result).toEqual({ kind: "booked", booking: booking("matched", 1_000) });
    expect(server.calls[0]!.body).toEqual({
      gameId: 730,
      minutes: 30,
      machineId: "pc-1",
      rtts: { server: 8 },
    });
    expect(localStorage.getItem("swiff.booking")).toBe("b-1");
  });

  it("carries how the renter plays, picked or queued, for the server to rank by", async () => {
    const server = routes({ "POST /api/bookings": json(202, booking("matched", 1_000)) });
    await bookMachine("pc-1", 730, 30, { fetch: server.fetch, controls: ["kb", "pad"], picture: "4k" });
    await book(730, 30, { fetch: server.fetch, controls: ["kb", "pad"], picture: "4k" });
    expect(server.calls.map((c) => c.body)).toEqual([
      { gameId: 730, minutes: 30, machineId: "pc-1", controls: ["kb", "pad"], picture: "4k" },
      { gameId: 730, minutes: 30, controls: ["kb", "pad"], picture: "4k" },
    ]);
  });

  it("says it was taken, with the next best, and remembers nothing", async () => {
    const nextBest = { id: "pc-2", name: "Nova", gpu: "RTX 4070", price: 300, latency: { rttMs: 20 } };
    const server = routes({ "POST /api/bookings": json(409, { error: "the machine is taken", nextBest }) });
    expect(await bookMachine("pc-1", 730, 30, { fetch: server.fetch })).toEqual({ kind: "taken", nextBest });
    expect(localStorage.getItem("swiff.booking")).toBeNull();
  });

  it("throws on any other failure", async () => {
    const server = routes({ "POST /api/bookings": json(500, { error: "internal error" }) });
    await expect(bookMachine("pc-1", 730, 30, { fetch: server.fetch })).rejects.toThrow("500");
  });

  it("names the refusal when the server will not let the renter play the game, picked or queued", async () => {
    const server = routes({
      "POST /api/bookings": json(403, { error: "not in your library", code: "not-owned" }),
    });
    const picked = bookMachine("pc-1", 1245620, 30, { fetch: server.fetch });
    await expect(picked).rejects.toBeInstanceOf(BookingRefused);
    await expect(picked).rejects.toMatchObject({ refusal: "not-owned" });
    await expect(book(1245620, 30, { fetch: server.fetch })).rejects.toMatchObject({ refusal: "not-owned" });

    const unread = routes({
      "POST /api/bookings": json(403, { error: "cannot read", code: "library-unreadable" }),
    });
    await expect(book(1245620, 30, { fetch: unread.fetch })).rejects.toMatchObject({
      refusal: "library-unreadable",
    });
    expect(localStorage.getItem("swiff.booking")).toBeNull();
  });

  it("reads a 403 with no known code as an ordinary failure", async () => {
    const server = routes({ "POST /api/bookings": json(403, { error: "forbidden" }) });
    const result = book(730, 30, { fetch: server.fetch });
    await expect(result).rejects.not.toBeInstanceOf(BookingRefused);
    await expect(result).rejects.toThrow("403");
  });
});

describe("claiming and ending", () => {
  beforeEach(() => localStorage.clear());

  it("claims a matched booking, and reads a 409 as not claimable", async () => {
    const ok = routes({ "POST /api/bookings/b-1/claim": json(200, TICKET) });
    expect(await claim("b-1", { fetch: ok.fetch })).toEqual(TICKET);
    const lapsed = routes({ "POST /api/bookings/b-1/claim": json(409, { status: "queued" }) });
    expect(await claim("b-1", { fetch: lapsed.fetch })).toBeNull();
  });

  it("ends the booking and forgets it, over already or not", async () => {
    localStorage.setItem("swiff.booking", "b-1");
    const server = routes({ "POST /api/bookings/b-1/end": json(200, booking("ended")) });
    expect((await endBooking("b-1", { fetch: server.fetch }))?.status).toBe("ended");
    expect(localStorage.getItem("swiff.booking")).toBeNull();

    localStorage.setItem("swiff.booking", "b-1");
    const over = routes({ "POST /api/bookings/b-1/end": json(409, { status: "ended" }) });
    expect(await endBooking("b-1", { fetch: over.fetch })).toBeNull();
    expect(localStorage.getItem("swiff.booking")).toBeNull();
  });
});

describe("following a booking to its claim", () => {
  beforeEach(() => localStorage.clear());

  /** Follow b-1 against `server`, recording what is reported. */
  function follow(first: Booking | string, server: ReturnType<typeof routes>, hidden = false) {
    const { stream, open } = fakeStream();
    const chime = vi.fn();
    const claimed: Claim[] = [];
    const updates: (BookingStatus | null)[] = [];
    const stop = followBooking(
      first,
      { onUpdate: (b) => updates.push(b?.status ?? null), onClaimed: (c) => claimed.push(c) },
      {
        fetch: server.fetch,
        eventSource: open,
        intervalMs: 5,
        heartbeatMs: 1_000,
        chime,
        hidden: () => hidden,
      },
    );
    return { stream, chime, claimed, updates, stop };
  }

  it("claims a picked machine the moment it is booked, with no click", async () => {
    const server = routes({ "POST /api/bookings/b-1/claim": json(200, TICKET) });
    const { claimed, chime, stream } = follow(booking("matched", 1_000), server);
    stream.push("matched", 1_000);
    await settle();
    expect(claimed).toEqual([TICKET]);
    expect(server.made().filter((c) => c.endsWith("/claim"))).toHaveLength(1);
    expect(chime).not.toHaveBeenCalled();
    expect(stream.closed).toBe(true);
  });

  it("claims a queued booking when the open stream pushes its match", async () => {
    localStorage.setItem("swiff.booking", "b-1");
    const server = routes({ "POST /api/bookings/b-1/claim": json(200, TICKET) });
    const { claimed, stream, updates } = follow("b-1", server);
    stream.push("queued");
    await settle();
    expect(claimed).toEqual([]);

    stream.push("matched", 1_000);
    await settle();
    expect(updates).toEqual(["queued", "matched"]);
    expect(claimed).toEqual([TICKET]);
    expect(localStorage.getItem("swiff.booking")).toBeNull();
  });

  it("chimes for a match that arrives while the tab is out of sight", async () => {
    const server = routes({ "POST /api/bookings/b-1/claim": json(200, TICKET) });
    const { chime, stream, claimed } = follow("b-1", server, true);
    stream.push("matched", 1_000);
    await settle();
    expect(chime).toHaveBeenCalledTimes(1);
    expect(claimed).toEqual([TICKET]);
  });

  it("claims a match the poll finds while the stream is down, once, chiming out of sight", async () => {
    localStorage.setItem("swiff.booking", "b-1");
    const server = routes({
      "GET /api/bookings/b-1": json(200, booking("matched", 1_000)),
      "POST /api/bookings/b-1/claim": json(200, TICKET),
    });
    const { stream, claimed, updates, chime } = follow("b-1", server, true);
    stream.emit("error");
    await settle();
    expect(updates).toContain("matched");
    expect(claimed).toEqual([TICKET]);
    expect(server.made().filter((c) => c.endsWith("/claim"))).toHaveLength(1);
    expect(chime).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("swiff.booking")).toBeNull();
  });

  it("says so when a claim is refused or fails, and follows on", async () => {
    let answers = 0;
    const server = routes({
      "POST /api/bookings/b-1/claim": () => {
        if (++answers === 1) throw new TypeError("network down");
        return new Response(JSON.stringify({ status: "expired" }), { status: 409 });
      },
    });
    const failed = vi.fn();
    const { stream, open } = fakeStream();
    followBooking(
      booking("matched", 1_000),
      { onUpdate: () => {}, onClaimed: () => {}, onClaimFailed: failed },
      { fetch: server.fetch, eventSource: open, intervalMs: 5, heartbeatMs: 1_000 },
    );
    await settle();
    expect(failed).toHaveBeenCalledTimes(1);
    stream.push("matched", 1_000);
    await settle();
    expect(failed).toHaveBeenCalledTimes(2);
  });

  it("passes on the refusal when the server will not let the renter play the claimed game", async () => {
    const server = routes({
      "POST /api/bookings/b-1/claim": json(403, { error: "not in your library", code: "not-owned" }),
    });
    const failed = vi.fn();
    const { open } = fakeStream();
    followBooking(
      booking("matched", 1_000),
      { onUpdate: () => {}, onClaimed: () => {}, onClaimFailed: failed },
      { fetch: server.fetch, eventSource: open, intervalMs: 5, heartbeatMs: 1_000 },
    );
    await settle();
    expect(failed).toHaveBeenCalledExactlyOnceWith("not-owned");
  });

  it("tries a match's claim again when the network loses it, and claims it", async () => {
    let answers = 0;
    const server = routes({
      "POST /api/bookings/b-1/claim": () => {
        if (++answers === 1) throw new TypeError("network down");
        return new Response(JSON.stringify(TICKET), { status: 200 });
      },
    });
    const failed = vi.fn();
    const claimed: Claim[] = [];
    const { stream, open } = fakeStream();
    followBooking(
      "b-1",
      { onUpdate: () => {}, onClaimed: (c) => claimed.push(c), onClaimFailed: failed },
      { fetch: server.fetch, eventSource: open, intervalMs: 5, heartbeatMs: 1_000, retryMs: 5 },
    );
    stream.push("matched", Date.now() + 60_000);
    await settle();
    expect(answers).toBe(2);
    expect(claimed).toEqual([TICKET]);
    expect(failed).not.toHaveBeenCalled();
  });

  it("claims, for a renter back after a match made while away, on the reopened stream through the restored window", async () => {
    // The page reloads on the booking it kept; the server started the claim's
    // 60 s as its stream reopened, so the match arrives with all of them left.
    localStorage.setItem("swiff.booking", "b-1");
    const lost = 2;
    let answers = 0;
    const server = routes({
      "POST /api/bookings/b-1/claim": () => {
        if (++answers <= lost) throw new TypeError("network down");
        return new Response(JSON.stringify(TICKET), { status: 200 });
      },
    });
    const failed = vi.fn();
    const claimed: Claim[] = [];
    const { stream, open } = fakeStream();
    followBooking(
      "b-1",
      { onUpdate: () => {}, onClaimed: (c) => claimed.push(c), onClaimFailed: failed },
      { fetch: server.fetch, eventSource: open, intervalMs: 5, heartbeatMs: 1_000, retryMs: 30 },
    );
    expect(stream.url).toBe("/api/events?booking=b-1");
    const back = Date.now();
    stream.push("matched", back + 60_000);
    await vi.waitFor(() => expect(claimed).toEqual([TICKET]), { timeout: 2_000 });
    // Past the few seconds a clock run from the match would have left (here 40 ms).
    expect(Date.now() - back).toBeGreaterThan(40);
    expect(answers).toBe(lost + 1);
    expect(failed).not.toHaveBeenCalled();
    expect(localStorage.getItem("swiff.booking")).toBeNull();
  });

  it("gives up on a lost claim once its reservation lapses, and says so", async () => {
    const server = routes({
      "POST /api/bookings/b-1/claim": () => {
        throw new TypeError("network down");
      },
    });
    const failed = vi.fn();
    const { stream, open } = fakeStream();
    followBooking(
      "b-1",
      { onUpdate: () => {}, onClaimed: () => {}, onClaimFailed: failed },
      { fetch: server.fetch, eventSource: open, intervalMs: 5, heartbeatMs: 1_000, retryMs: 5 },
    );
    stream.push("matched", Date.now() + 60);
    await new Promise((r) => setTimeout(r, 150));
    const tries = server.made().filter((c) => c.endsWith("/claim")).length;
    expect(tries).toBeGreaterThan(1);
    expect(failed).toHaveBeenCalledTimes(1);
    await settle();
    expect(server.made().filter((c) => c.endsWith("/claim"))).toHaveLength(tries);
  });

  it("stops trying a lost claim once the booking leaves its match", async () => {
    const server = routes({
      "POST /api/bookings/b-1/claim": () => {
        throw new TypeError("network down");
      },
    });
    const { stream, open } = fakeStream();
    followBooking(
      "b-1",
      { onUpdate: () => {}, onClaimed: () => {} },
      { fetch: server.fetch, eventSource: open, intervalMs: 5, heartbeatMs: 1_000, retryMs: 20 },
    );
    stream.push("matched", Date.now() + 60_000);
    await new Promise((r) => setTimeout(r, 5));
    stream.push("expired");
    await new Promise((r) => setTimeout(r, 80));
    expect(server.made().filter((c) => c.endsWith("/claim"))).toHaveLength(1);
  });

  it("hands the machine back when a lost claim went through and the retry is refused as claimed", async () => {
    let answers = 0;
    const server = routes({
      "POST /api/bookings/b-1/claim": () => {
        if (++answers === 1) throw new TypeError("response lost");
        return new Response(JSON.stringify({ status: "claimed" }), { status: 409 });
      },
      "POST /api/bookings/b-1/end": json(200, booking("ended")),
    });
    const failed = vi.fn();
    const updates: (BookingStatus | null)[] = [];
    const { stream, open } = fakeStream();
    followBooking(
      "b-1",
      { onUpdate: (b) => updates.push(b?.status ?? null), onClaimed: () => {}, onClaimFailed: failed },
      { fetch: server.fetch, eventSource: open, intervalMs: 5, heartbeatMs: 1_000, retryMs: 5 },
    );
    stream.push("matched", Date.now() + 60_000);
    await settle();
    expect(server.made()).toEqual([
      "POST /api/bookings/b-1/claim",
      "POST /api/bookings/b-1/claim",
      "POST /api/bookings/b-1/end",
    ]);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(updates).toEqual(["matched", "ended"]);
    expect(stream.closed).toBe(true);
  });

  it("hands the machine back when the stream reports claimed a claim whose answer was lost", async () => {
    let answers = 0;
    const server = routes({
      "POST /api/bookings/b-1/claim": () => {
        answers += 1;
        throw new TypeError("response lost");
      },
      "POST /api/bookings/b-1/end": json(200, booking("ended")),
    });
    const failed = vi.fn();
    const updates: (BookingStatus | null)[] = [];
    const { stream, open } = fakeStream();
    followBooking(
      "b-1",
      { onUpdate: (b) => updates.push(b?.status ?? null), onClaimed: () => {}, onClaimFailed: failed },
      { fetch: server.fetch, eventSource: open, intervalMs: 5, heartbeatMs: 1_000, retryMs: 1_000 },
    );
    stream.push("matched", Date.now() + 60_000);
    await settle();
    stream.push("claimed");
    await settle();
    expect(answers).toBe(1);
    expect(server.made()).toEqual(["POST /api/bookings/b-1/claim", "POST /api/bookings/b-1/end"]);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(updates).toEqual(["matched", "claimed", "ended"]);
  });

  it("ends nothing when a claim is refused as claimed with no answer lost", async () => {
    const server = routes({
      "POST /api/bookings/b-1/claim": json(409, { status: "claimed" }),
      "POST /api/bookings/b-1/end": json(200, booking("ended")),
    });
    const failed = vi.fn();
    const { stream, open } = fakeStream();
    followBooking(
      "b-1",
      { onUpdate: () => {}, onClaimed: () => {}, onClaimFailed: failed },
      { fetch: server.fetch, eventSource: open, intervalMs: 5, heartbeatMs: 1_000 },
    );
    stream.push("matched", 1_000);
    await settle();
    stream.push("claimed");
    await settle();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(server.made()).toEqual(["POST /api/bookings/b-1/claim"]);
  });

  it("leaves a reservation it could not claim, and claims the next match", async () => {
    let answers = 0;
    const server = routes({
      "POST /api/bookings/b-1/claim": () =>
        ++answers === 1
          ? new Response(JSON.stringify({ status: "queued" }), { status: 409 })
          : new Response(JSON.stringify(TICKET), { status: 200 }),
    });
    const { stream, claimed } = follow("b-1", server);
    stream.push("matched", 1_000);
    await settle();
    stream.push("matched", 1_000);
    await settle();
    expect(claimed).toEqual([]);
    expect(answers).toBe(1);

    stream.push("queued");
    stream.push("matched", 2_000);
    await settle();
    expect(claimed).toEqual([TICKET]);
  });

  it("claims nothing once stopped", async () => {
    const server = routes({ "POST /api/bookings/b-1/claim": json(200, TICKET) });
    const { stream, claimed, stop } = follow("b-1", server);
    stop();
    stream.push("matched", 1_000);
    await settle();
    expect(claimed).toEqual([]);
    expect(server.made()).toEqual([]);
  });
});
