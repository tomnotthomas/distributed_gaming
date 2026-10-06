// The marketing site (server/src/marketing.ts) on a host of its own, one page
// per flow: the waitlist on the player landing, a crew invite into the
// Founding Host application, a seat and a gift into the waitlist with their
// code, a crew Night, the share page, the Lanterel OS page and the legal pages.
// The forms post to the real sign-up endpoint (server/src/signups.ts).

import { expect, test, type Page, type Request } from "@playwright/test";

/** The site's origin: the e2e server's port on the host SITE_ORIGIN names (playwright.config.ts). */
const site = (baseURL: string | undefined) => baseURL!.replace("127.0.0.1", "lanterel.localhost");

/** Fail on any console error, and on any request that leaves the site. */
function watch(page: Page, origin: string): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("request", (request) => {
    if (!request.url().startsWith(origin) && !request.url().startsWith("data:"))
      problems.push(`left the site: ${request.url()}`);
  });
  return problems;
}

/** Submit the first form on the page with `email`; the request it sent. */
async function submitFirstForm(page: Page, email: string): Promise<Request> {
  const form = page.locator("form.wl").first();
  await form.locator("input[type=email]").fill(email);
  const [sent] = await Promise.all([
    page.waitForRequest((request) => request.url().endsWith("/api/signups") && request.method() === "POST"),
    form.locator("button[type=submit]").click(),
  ]);
  const answered = await sent.response();
  expect(answered?.status()).toBe(202);
  await expect(form.locator(".wl-done")).toBeVisible();
  await expect(form.locator(".wl-done")).toContainText(email);
  return sent;
}

test.describe("marketing site", () => {
  test("player landing: joins the waitlist", async ({ page, baseURL }) => {
    const origin = site(baseURL);
    const problems = watch(page, origin);
    await page.goto(`${origin}/`);
    await expect(page).toHaveTitle(/\| Lanterel$/);
    await expect(page.locator("a.wordmark").first()).toHaveText("LANTEREL");

    const sent = await submitFirstForm(page, "player@example.com");
    expect(sent.postDataJSON()).toMatchObject({
      email: "player@example.com",
      kind: "player",
      lang: "de",
      invite: null,
    });
    expect(problems).toEqual([]);
  });

  test("crew invite: names nobody, then applies as a host with the invite", async ({ page, baseURL }) => {
    const origin = site(baseURL);
    const problems = watch(page, origin);
    await page.goto(`${origin}/en/crew/AB12cd`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("A friend wants to borrow your rig.");
    await expect(page.locator("body")).not.toContainText("Max");

    await page.getByRole("link", { name: "Sure, check my PC" }).first().click();
    await expect(page).toHaveURL(`${origin}/en/host/?i=crew:AB12cd#bewerben`);
    const sent = await submitFirstForm(page, "host@example.com");
    expect(sent.postDataJSON()).toMatchObject({ kind: "host", lang: "en", invite: "crew:AB12cd" });
    expect(problems).toEqual([]);
  });

  test("seat at a rig: takes the seat into the waitlist with its code", async ({ page, baseURL }) => {
    const origin = site(baseURL);
    const problems = watch(page, origin);
    await page.goto(`${origin}/seat/S3at_1`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Jemand hält dir einen Platz an einem Rig frei.",
    );

    await page.getByRole("link", { name: "Platz annehmen" }).last().click();
    await expect(page).toHaveURL(`${origin}/?i=seat:S3at_1#beta`);
    const sent = await submitFirstForm(page, "seat@example.com");
    expect(sent.postDataJSON()).toMatchObject({ kind: "player", invite: "seat:S3at_1" });
    expect(problems).toEqual([]);
  });

  test("gift seat: redeems into the waitlist with its code", async ({ page, baseURL }) => {
    const origin = site(baseURL);
    await page.goto(`${origin}/en/gift/G1ft`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("A friend just got you a seat.");
    await page.locator('a[href*="?i=gift:G1ft"]').first().click();
    await expect(page).toHaveURL(`${origin}/en/?i=gift:G1ft#beta`);
  });

  test("crew Night, share page, Lanterel OS and the legal pages load clean", async ({ page, baseURL }) => {
    const origin = site(baseURL);
    const problems = watch(page, origin);
    for (const path of [
      "/night/N1ght",
      "/en/share/",
      "/lanterel-os/",
      "/en/lanterel-os/",
      "/impressum/",
      "/en/privacy/",
    ]) {
      const answer = await page.goto(`${origin}${path}`);
      expect(answer?.status(), path).toBe(200);
      await expect(page, path).toHaveTitle(/Lanterel/);
    }
    // The bare share page links to the crew page, not to a code nobody has.
    await page.goto(`${origin}/share/`);
    await expect(page.locator("#lk")).toHaveText(`${origin}/crew/`);
    expect(problems).toEqual([]);
  });

  test("leaves the app's own host alone", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("meta[name=form-endpoint]")).toHaveCount(0);
  });
});
