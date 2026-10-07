// Friend seats end to end, on the real server: the host app saves a seat at
// its PC for a friend, the friend opens the seat's link, grabs it with one
// tap, lands in the crew that plays on that PC, and can book that PC for a
// game of their own, which someone without a seat cannot. Taken back, the
// link opens nothing and the PC is closed to the friend again.

import { expect, test, type APIRequestContext } from "@playwright/test";
import { E2E_SEAT_PC, E2E_SEAT_PC_KEY, signIn } from "./credentials";
import { failOnPageError } from "./hosts";

const FRIEND = "76561198000000202";
const STRANGER = "76561198000000203";
const HOST_APP = { authorization: `Bearer ${E2E_SEAT_PC_KEY}` };

/** The heartbeat that keeps the seat PC on offer, while one runs. */
let beating: ReturnType<typeof setInterval> | undefined;

/** Offer the seat PC through the Host API as its PC would, beating as the host app does, or take it back. */
async function offerSeatPc(request: APIRequestContext, available: boolean) {
  clearInterval(beating);
  beating = undefined;
  const res = await request.put(`/api/machines/${E2E_SEAT_PC}/availability`, {
    headers: HOST_APP,
    data: {
      available,
      // For its crews alone: someone without a seat may not book it.
      crewOnly: true,
      name: "Lenas PC",
      hardware: {
        gpu: "AMD Radeon RX 7900 XT",
        vramMb: 20_480,
        ramMb: 32_768,
        cpu: "AMD Ryzen 7 7800X3D",
        cores: 8,
        encoders: ["h264", "hevc", "av1"],
        display: { width: 2560, height: 1440, refreshHz: 144 },
      },
      // Counter-Strike 2: free to play, so a friend with no library read may book it.
      games: [730],
      controls: ["kb", "mouse", "pad"],
      net: { rttMs: 1, jitterMs: 1, upMbps: 100 },
    },
  });
  expect(res.status()).toBe(200);
  if (available) {
    beating = setInterval(() => {
      void request.post(`/api/machines/${E2E_SEAT_PC}/heartbeat`, { headers: HOST_APP }).catch(() => {});
    }, 5_000);
  }
}

test.afterEach(async ({ request }) => {
  if (beating) await offerSeatPc(request, false);
});

test("the host saves a seat, the friend grabs it from its link and can book that PC", async ({
  browser,
  baseURL,
  request,
}) => {
  await offerSeatPc(request, true);

  // The host app saves a seat for Jonas, with the machine key alone.
  const made = await request.post(`/api/machines/${E2E_SEAT_PC}/seats`, {
    headers: HOST_APP,
    data: { friend: "Jonas" },
  });
  expect(made.status()).toBe(201);
  const { seat } = await made.json();
  expect(seat.token).toMatch(/^[\w-]{44}$/);

  // The friend opens the link, signed in already: it names the seat, and the token leaves the address bar.
  const friendContext = await browser.newContext();
  await signIn(friendContext, baseURL!, FRIEND);
  const friend = await friendContext.newPage();
  const friendErrors = failOnPageError(friend, "friend");
  await friend.goto(`/seat/${seat.token}`);
  await expect(friend.getByText("Saved for Jonas · 14 days")).toBeVisible();
  await expect(friend.getByText("1 of 1, for Jonas")).toBeVisible();
  await expect(friend).toHaveURL(/\/seat$/);

  // Before taking it, the PC is closed to them.
  const book = (page: typeof friend) =>
    page.evaluate(async (machineId) => {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameId: 730, minutes: 30, machineId }),
      });
      return { status: res.status, body: (await res.json()) as { bookingId?: string; status?: string } };
    }, E2E_SEAT_PC);
  expect((await book(friend)).status).toBe(409);

  // One tap: the seat is theirs, and they land in the crew that plays on the PC.
  await friend.getByRole("button", { name: /Grab your seat/ }).click();
  await expect(friend).toHaveURL(/\/crews\/[\w-]{22}$/);
  await expect(friend.getByRole("heading", { name: "The gaming PC is free. Who goes first?" })).toBeVisible();

  // The host app sees who took it.
  const listed = await (
    await request.get(`/api/machines/${E2E_SEAT_PC}/seats`, { headers: HOST_APP })
  ).json();
  expect(listed.seats).toMatchObject([{ friend: "Jonas", state: "taken" }]);

  // They book that PC; someone without a seat cannot.
  const booked = await book(friend);
  expect(booked.status).toBe(202);
  expect(booked.body.status).toBe("matched");
  const strangerContext = await browser.newContext();
  await signIn(strangerContext, baseURL!, STRANGER);
  const stranger = await strangerContext.newPage();
  await stranger.goto("/");
  expect((await book(stranger)).status).toBe(409);

  // The friend hands the PC back, and the host takes the seat back: the link opens nothing and the PC is closed again.
  await friend.evaluate(async (id) => {
    await fetch(`/api/bookings/${id}/end`, { method: "POST" });
  }, booked.body.bookingId!);
  const revoked = await request.delete(`/api/machines/${E2E_SEAT_PC}/seats?seat=${seat.id}`, {
    headers: HOST_APP,
  });
  expect(revoked.status()).toBe(200);
  expect((await request.get(`/api/seats/${seat.token}`)).status()).toBe(404);
  expect((await book(friend)).status).toBe(409);

  expect(friendErrors).toEqual([]);
  await friendContext.close();
  await strangerContext.close();
});
