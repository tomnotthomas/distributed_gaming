// Crews end to end, on the real server: a player founds a crew in one tap and
// sets its Zockrunde, a friend opens its link, joins and says yes, brings a
// gaming PC later, and the crew is ready to play, which the founder's page
// shows by itself, with the first-PC celebration.

import { expect, test, type APIRequestContext } from "@playwright/test";
import { E2E_CREW_PC, E2E_CREW_PC_KEY, E2E_CREW_PC_OWNER, signIn } from "./credentials";
import { failOnPageError } from "./hosts";

const FOUNDER = "76561198000000101";

/** The heartbeat that keeps the crewmate's PC on offer, while one runs. */
let beating: ReturnType<typeof setInterval> | undefined;

/** Offer the crewmate's PC through the Host API as its PC would, beating as the host app does, or take it back. */
async function offerCrewPc(request: APIRequestContext, available: boolean) {
  clearInterval(beating);
  beating = undefined;
  const headers = { authorization: `Bearer ${E2E_CREW_PC_KEY}` };
  const res = await request.put(`/api/machines/${E2E_CREW_PC}/availability`, {
    headers,
    data: { available, name: "Jos PC", net: { rttMs: 1, jitterMs: 1, upMbps: 100 } },
  });
  expect(res.status()).toBe(200);
  if (available) {
    beating = setInterval(() => {
      void request.post(`/api/machines/${E2E_CREW_PC}/heartbeat`, { headers }).catch(() => {});
    }, 5_000);
  }
}

test.afterEach(async ({ request }) => {
  if (beating) await offerCrewPc(request, false);
});

test("found a crew, a friend joins without a PC, brings one later, and the crew is ready", async ({
  browser,
  baseURL,
  request,
}) => {
  const founderContext = await browser.newContext();
  await founderContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL! });
  await signIn(founderContext, baseURL!, FOUNDER);
  const founder = await founderContext.newPage();
  const founderErrors = failOnPageError(founder, "founder");

  // One tap: the crew exists at once, with its link, and asks for the date first.
  await founder.goto("/crews?found=1");
  await expect(founder).toHaveURL(/\/crews\/[\w-]{22}$/);
  const crewId = new URL(founder.url()).pathname.split("/").pop()!;
  await expect(founder.getByRole("heading", { name: "When are you playing?" })).toBeVisible();
  const { crew } = await (await founder.request.get(`/api/crews/${crewId}`)).json();
  expect(crew.token).toMatch(/^[\w-]{44}$/);

  // The founder sets the date (tomorrow, 10 pm), and the next step sends it out.
  await founder.getByRole("button", { name: /^Tomorrow/ }).click();
  await founder.getByRole("button", { name: "22:00" }).click();
  await founder.getByRole("button", { name: /^Set Tomorrow, 10 pm/ }).click();
  await expect(founder.getByRole("heading", { name: "Now get your people in" })).toBeVisible();
  await expect(founder.locator(".gc-bubble")).toContainText(`/invite/${crew.token}`);
  await expect(founder.locator(".gc-bubble")).toContainText("Who's got a gaming PC?");
  await founder.getByRole("button", { name: "Copy the crew link" }).click();
  await expect(founder.getByRole("heading", { name: "Who brings the gaming PC?" })).toBeVisible();

  // The friend opens the link, signed in already, sees the date, and joins and says yes with one tap.
  const friendContext = await browser.newContext();
  await signIn(friendContext, baseURL!, E2E_CREW_PC_OWNER);
  const friend = await friendContext.newPage();
  const friendErrors = failOnPageError(friend, "friend");
  await friend.goto(`/invite/${crew.token}`);
  await expect(friend.getByText(/^Session on /)).toBeVisible();
  await expect(friend).toHaveURL(/\/invite$/);
  // One button joins and says yes; the founder sees it without a reload.
  await friend.getByRole("button", { name: "I'm in", exact: true }).click();
  await expect(friend).toHaveURL(new RegExp(`/crews/${crewId}$`));
  await expect(friend.getByRole("heading", { name: "Who brings the gaming PC?" })).toBeVisible();
  await expect(founder.getByText("2 in", { exact: true })).toBeVisible();

  // Weeks later the friend's PC is on: it plays for no crew until they bring it.
  await offerCrewPc(request, true);
  await expect(friend.getByRole("heading", { name: "Who brings the gaming PC?" })).toBeVisible();

  // They bring it, and the crew is ready to play on it, on both pages.
  await friend.getByRole("button", { name: "Yes: put the app on my PC" }).click();
  const free = { name: "The gaming PC is free. Who goes first?" };
  await expect(friend.getByRole("heading", free)).toBeVisible();
  await expect(founder.getByRole("heading", free)).toBeVisible();
  await expect(founder.getByText("Jos PC is in. You're ready to play!")).toBeVisible();

  expect(founderErrors).toEqual([]);
  expect(friendErrors).toEqual([]);
  await founderContext.close();
  await friendContext.close();
});
