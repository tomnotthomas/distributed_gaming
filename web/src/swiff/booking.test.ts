import { beforeEach, describe, expect, it, vi } from "vitest";
import { book, resumeBooking, type Booking, type BookingStatus } from "./booking";

const booking = (status: BookingStatus): Booking => ({ bookingId: "b-1", status, gameId: 730, minutes: 30 });

/** A server that answers GET /api/bookings/b-1 with each status in turn, and POST with a queued booking. */
function fakeServer(statuses: (BookingStatus | 404)[]) {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    if (init?.method === "POST") return new Response(JSON.stringify(booking("queued")), { status: 202 });
    const next = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
    if (next === 404) return new Response(JSON.stringify({ error: "no such booking" }), { status: 404 });
    return new Response(JSON.stringify(booking(next)), { status: 200 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("booking across a closed tab", () => {
  beforeEach(() => localStorage.clear());

  it("remembers a new booking and resumes watching it on the next page load", async () => {
    const server = fakeServer(["queued", "matched"]);
    await book(730, 30, { fetch: server.fetch });

    // The tab closes; a new page loads and finds the booking.
    const updates: (BookingStatus | null)[] = [];
    const stop = resumeBooking((b) => updates.push(b?.status ?? null), {
      fetch: server.fetch,
      intervalMs: 5,
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

  for (const end of ["claimed", "ended", "expired", 404] as const) {
    it(`forgets the booking and stops polling once it is ${end}`, async () => {
      const server = fakeServer(["queued", end]);
      await book(730, 30, { fetch: server.fetch });

      const updates: (BookingStatus | null)[] = [];
      resumeBooking((b) => updates.push(b?.status ?? null), { fetch: server.fetch, intervalMs: 5 });
      await settle();

      expect(updates).toEqual(["queued", end === 404 ? null : end]);
      expect(localStorage.getItem("swiff.booking")).toBeNull();
      expect(resumeBooking(() => {}, { fetch: server.fetch })).toBeNull();
    });
  }
});
