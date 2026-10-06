// Crews end to end, on the real server: a player founds a crew in one tap,
// a friend without a PC opens its link and joins, the friend brings a gaming
// PC later, and the crew is ready to play, which the founder's page shows by
// itself, with the first-PC celebration.

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
  await signIn(founderContext, baseURL!, FOUNDER);
  const founder = await founderContext.newPage();
  const founderErrors = failOnPageError(founder, "founder");

  // One tap: the crew exists at once, with its link, and asks nobody about a PC.
  await founder.goto("/crews/new");
  await expect(founder).toHaveURL(/\/crews\/[\w-]{22}$/);
  const crewId = new URL(founder.url()).pathname.split("/").pop()!;
  await expect(founder.getByText("Almost ready.", { exact: true })).toBeVisible();
  await expect(founder.getByRole("heading", { name: "Get your people into the crew" })).toBeVisible();
  await expect(founder.getByRole("button", { name: "Share on WhatsApp" }).first()).toBeVisible();
  const { crew } = await (await founder.request.get(`/api/crews/${crewId}`)).json();
  expect(crew.token).toMatch(/^[\w-]{44}$/);
  await expect(founder.locator(".lb-link code")).toContainText(`/invite/${crew.token}`);

  // The friend opens the link, signed in already, and joins with one tap.
  const friendContext = await browser.newContext();
  await signIn(friendContext, baseURL!, E2E_CREW_PC_OWNER);
  const friend = await friendContext.newPage();
  const friendErrors = failOnPageError(friend, "friend");
  await friend.goto(`/invite/${crew.token}`);
  await expect(friend.getByText("Almost ready. A gaming PC is still missing.")).toBeVisible();
  await expect(friend).toHaveURL(/\/invite$/);
  await friend.getByRole("button", { name: "Join", exact: true }).first().click();
  await expect(friend).toHaveURL(new RegExp(`/crews/${crewId}$`));

  // Joined, the friend is shown what the crew would see on a PC, and puts it off.
  const card = friend.getByTestId("pc-card");
  await expect(card.getByText("The crew doesn't see")).toBeVisible();
  await card.getByRole("button", { name: "Later" }).click();
  await expect(card).toBeHidden();
  const chip = friend.getByRole("button", { name: "Check my PC later" });
  await expect(chip).toBeVisible();

  // The founder's page shows the friend without a reload.
  await expect(founder.getByText("2 in").first()).toBeVisible();

  // Weeks later the friend's PC is on: it plays for no crew until they bring it.
  await offerCrewPc(request, true);
  await expect(friend.getByText("Almost ready.", { exact: true })).toBeVisible();

  // They bring it from the chip, and the crew is ready, on both pages.
  await chip.click();
  await friend.getByRole("button", { name: "Check my PC (takes a minute)" }).click();
  await expect(friend.getByText("Ready to play!", { exact: true })).toBeVisible();
  await expect(friend.getByText("Your PC plays for")).toBeVisible();
  await expect(founder.getByText("Ready to play!", { exact: true })).toBeVisible();
  await expect(founder.getByRole("heading", { name: "You're ready to play!" })).toBeVisible();
  await expect(founder.getByText("Jos PC is in. You're ready to play!")).toBeVisible();

  expect(founderErrors).toEqual([]);
  expect(friendErrors).toEqual([]);
  await founderContext.close();
  await friendContext.close();
});
