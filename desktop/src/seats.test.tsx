// Seats for friends: the Host API client over a fake fetch, and the panel the
// owner keeps them from, over a fake client.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  daysLeft,
  demoSeatClient,
  seatClient,
  seatLine,
  seatMessage,
  type HostSeat,
  type SeatClient,
  type SeatList,
} from "./seats";
import { FriendSeats } from "./screens/FriendSeats";

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 9, 6, 20);
const MACHINE = { url: "wss://swiff.example", machineId: "gaming pc", machineKey: "secret-key" };
const TOKEN = "a".repeat(44);

const seat = (over: Partial<HostSeat> = {}): HostSeat => ({
  id: "s1",
  friend: "Jonas",
  number: 1,
  state: "open",
  expiresAt: NOW + 12 * DAY,
  takenBy: null,
  crewId: "c1",
  token: TOKEN,
  ...over,
});

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the seats client", () => {
  it("reads, saves and takes back seats on the Host API with the machine key", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
      init?.method === "POST" ? answer(201, { seat: seat() }) : answer(200, { seats: [seat()], max: 4 }),
    );
    const client = seatClient(MACHINE, "https://swiff.example", fetch);
    const route = "https://swiff.example/api/machines/gaming%20pc/seats";

    expect(await client.list()).toEqual({ ok: true, value: { seats: [seat()], max: 4 } });
    expect(fetch).toHaveBeenLastCalledWith(route, { headers: { authorization: "Bearer secret-key" } });

    expect(await client.make("Jonas")).toEqual({ ok: true, value: seat() });
    expect(fetch).toHaveBeenLastCalledWith(route, {
      method: "POST",
      headers: { authorization: "Bearer secret-key", "content-type": "application/json" },
      body: JSON.stringify({ friend: "Jonas" }),
    });

    expect((await client.revoke("s1")).ok).toBe(true);
    expect(fetch).toHaveBeenLastCalledWith(`${route}?seat=s1`, {
      method: "DELETE",
      headers: { authorization: "Bearer secret-key" },
    });
    expect(client.link(seat())).toBe(`https://swiff.example/seat/${TOKEN}`);
    expect(client.link(seat({ token: null }))).toBeNull();
    expect(seatClient(MACHINE, null, fetch).link(seat())).toBeNull();
  });

  it("names why a call was refused", async () => {
    const refusing = (status: number, body: unknown) =>
      seatClient(MACHINE, null, async () => answer(status, body));
    expect(await refusing(409, { code: "full" }).make("Jonas")).toEqual({ ok: false, error: "full" });
    expect(await refusing(409, { code: "unknown-machine" }).list()).toEqual({
      ok: false,
      error: "unknown-machine",
    });
    expect(await refusing(409, { code: "too-many-crews" }).make("J")).toEqual({
      ok: false,
      error: "too-many-crews",
    });
    expect(await refusing(409, { code: "other" }).make("J")).toEqual({ ok: false, error: "failed" });
    expect(await refusing(400, {}).make(" ")).toEqual({ ok: false, error: "bad-name" });
    expect(await refusing(404, {}).revoke("s1")).toEqual({ ok: false, error: "not-found" });
    expect(await refusing(401, {}).list()).toEqual({ ok: false, error: "failed" });
    const offline = seatClient(MACHINE, null, async () => {
      throw new TypeError("network");
    });
    expect(await offline.list()).toEqual({ ok: false, error: "failed" });
  });

  it("says how long a seat waits, and what the friend is sent", () => {
    expect(daysLeft(NOW + 12 * DAY, NOW)).toBe(12);
    expect(daysLeft(NOW + 1, NOW)).toBe(1);
    expect(daysLeft(NOW, NOW)).toBe(0);
    expect(seatLine(seat(), NOW)).toBe("Waiting for Jonas · 12 days left");
    expect(seatLine(seat({ expiresAt: NOW + 3_600_000 }), NOW)).toBe("Waiting for Jonas · 1 day left");
    expect(seatLine(seat({ state: "taken", takenBy: "jonas_k" }), NOW)).toBe("Taken by jonas_k");
    expect(seatMessage("https://x/seat/t")).toMatch(
      /^Saved you a seat at my rig\..*14 days: https:\/\/x\/seat\/t$/,
    );
  });

  it("keeps the demo's seats in memory, up to four", async () => {
    const demo = demoSeatClient(() => NOW);
    const first = await demo.list();
    expect(first.ok && first.value.seats.map((s) => s.friend)).toEqual(["Jonas", "Mia"]);
    expect((await demo.make("Lea")).ok).toBe(true);
    expect((await demo.make("Ben")).ok).toBe(true);
    expect(await demo.make("Too many")).toEqual({ ok: false, error: "full" });
    const left = await demo.revoke("demo-seat-1");
    expect(left.ok && left.value.seats.map((s) => [s.number, s.friend])).toEqual([
      [1, "Mia"],
      [2, "Lea"],
      [3, "Ben"],
    ]);
  });
});

/** A client over a list kept here, recording each call. */
function fakeClient(
  start: SeatList,
  refuse?: { make?: "full" | "unknown-machine" },
): SeatClient & {
  calls: string[];
} {
  let list = start;
  const calls: string[] = [];
  return {
    calls,
    list: async () => ({ ok: true, value: list }),
    make: async (friend) => {
      calls.push(`make ${friend}`);
      if (refuse?.make) return { ok: false, error: refuse.make };
      const made = seat({ id: `s${list.seats.length + 1}`, friend, number: list.seats.length + 1 });
      list = { ...list, seats: [...list.seats, made] };
      return { ok: true, value: made };
    },
    revoke: async (id) => {
      calls.push(`revoke ${id}`);
      list = { ...list, seats: list.seats.filter((s) => s.id !== id) };
      return { ok: true, value: list };
    },
    link: (s) => `https://swiff.example/seat/${s.token}`,
  };
}

/** Render the panel and let its first read land. */
async function renderSeats(client: SeatClient) {
  render(<FriendSeats client={client} now={NOW} />);
  await act(async () => {});
}

describe("seats for friends", () => {
  afterEach(cleanup);

  it("lists each seat with how it stands", async () => {
    await renderSeats(
      fakeClient({
        max: 4,
        seats: [seat(), seat({ id: "s2", number: 2, friend: "Mia", state: "taken", takenBy: "mia" })],
      }),
    );
    const list = screen.getByRole("list", { name: "Seats at this PC" });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(first).toHaveTextContent("Seat 1 · Jonas");
    expect(first).toHaveTextContent("Waiting for Jonas · 12 days left");
    expect(within(first!).getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(second).toHaveTextContent("Taken by mia");
    expect(within(second!).queryByRole("button", { name: "Copy link" })).toBeNull();
    expect(screen.getByText(/plays their own Steam games here, on their own account/)).toBeInTheDocument();
  });

  it("saves a seat for a friend by name", async () => {
    const client = fakeClient({ max: 4, seats: [] });
    await renderSeats(client);
    const save = screen.getByRole("button", { name: "Save a seat" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Friend's name"), { target: { value: "  Lea " } });
    await act(async () => fireEvent.click(save));
    expect(client.calls).toEqual(["make Lea"]);
    expect(screen.getByText("Seat 1 · Lea")).toBeInTheDocument();
    expect(screen.getByLabelText("Friend's name")).toHaveValue("");
  });

  it("copies the message with the seat's link", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    await renderSeats(fakeClient({ max: 4, seats: [seat()] }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy link" })));
    expect(writeText).toHaveBeenCalledWith(seatMessage(`https://swiff.example/seat/${TOKEN}`));
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("takes a seat back only once the owner says so again", async () => {
    const client = fakeClient({ max: 4, seats: [seat()] });
    await renderSeats(client);
    fireEvent.click(screen.getByRole("button", { name: "Take back" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(client.calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Take back" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Yes, take it back" })));
    expect(client.calls).toEqual(["revoke s1"]);
    expect(screen.queryByText("Seat 1 · Jonas")).toBeNull();
  });

  it("offers no more seats once every one is given out", async () => {
    const seats = [1, 2, 3, 4].map((n) => seat({ id: `s${n}`, number: n, friend: `F${n}` }));
    await renderSeats(fakeClient({ max: 4, seats }));
    expect(screen.getByText("All 4 seats are given out.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save a seat" })).toBeNull();
  });

  it("asks for the PC to be offered once before seats can be saved", async () => {
    await renderSeats(fakeClient({ max: 4, seats: [] }, { make: "unknown-machine" }));
    fireEvent.change(screen.getByLabelText("Friend's name"), { target: { value: "Lea" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save a seat" })));
    expect(screen.getByRole("status")).toHaveTextContent("Offer this PC once, then save seats for friends.");
  });

  it("shows nothing without a client", () => {
    const { container } = render(<FriendSeats client={null} now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });
});
