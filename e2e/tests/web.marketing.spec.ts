// The marketing site (server/src/marketing.ts) on a host of its own, and how
// it hands people into the app: "Crew gründen" through Steam sign-in on the
// app's origin to the crew pages, a crew link the site is given straight to
// the app's own invite page, and the app's crew link previewing who asks.
// Then a gift, the Zockrunde page, the Lanterel OS page and the legal pages.
// Steam itself is never called: the sign-in request is caught before it leaves.

import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./credentials";

/** The site's origin: the e2e server's port on the host SITE_ORIGIN names (playwright.config.ts). */
const site = (baseURL: string | undefined) => baseURL!.replace("127.0.0.1", "lanterel.localhost");

/** The app's origin: PUBLIC_ORIGIN, which the e2e server leaves at its development default. */
const app = (baseURL: string | undefined) => baseURL!.replace("127.0.0.1", "localhost");

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

test.describe("marketing site", () => {
  test("player landing: no email field, Crew gründen signs in with Steam on the app, to the crew pages", async ({
    page,
    context,
    request,
    baseURL,
  }) => {
    const origin = site(baseURL);
    // The app's sign-in is caught before it goes on to Steam.
    const signingIn = new Promise<URL>((resolve) => {
      void context.route(`${app(baseURL)}/auth/steam/login**`, async (route) => {
        resolve(new URL(route.request().url()));
        await route.fulfill({ status: 200, contentType: "text/html", body: "<title>Steam</title>" });
      });
    });
    await page.goto(`${origin}/`);
    await expect(page).toHaveTitle(/\| Lanterel$/);
    await expect(page.locator("a.wordmark").first()).toHaveText("LANTEREL");
    await expect(page.locator("input[type=email]")).toHaveCount(0);

    await page.locator(".hero").getByRole("link", { name: "Crew gründen" }).click();
    const login = await signingIn;
    expect(login.origin).toBe(app(baseURL));
    expect(login.searchParams.get("to")).toBe("/crews?found=1");

    // The server sends that on to Steam, coming back to the crew pages (not followed).
    const steam = await request.get(`${app(baseURL)}${login.pathname}${login.search}`, { maxRedirects: 0 });
    expect(steam.status()).toBe(302);
    const openid = new URL(steam.headers()["location"]!);
    expect(openid.origin + openid.pathname).toBe("https://steamcommunity.com/openid/login");
    const returnTo = new URL(openid.searchParams.get("openid.return_to")!);
    expect(returnTo.origin + returnTo.pathname).toBe(`${app(baseURL)}/auth/steam/return`);
    expect(returnTo.searchParams.get("to")).toBe("/crews?found=1");
  });

  test("back from sign-in: a player with no crew gets one at once", async ({ page, context, baseURL }) => {
    await signIn(context, app(baseURL), "76561198000000031");
    await page.goto(`${app(baseURL)}/crews?found=1`);
    await expect(page).toHaveURL(/\/crews\/[\w-]+$/);
    await expect(page.getByText("Almost ready.")).toBeVisible();
  });

  test("a crew link the site is given opens the app's own invite page, which previews who asks", async ({
    page,
    browser,
    request,
    baseURL,
  }) => {
    // The founder's crew link, from the app.
    const founder = await browser.newContext();
    await signIn(founder, app(baseURL), "76561198000000032");
    const made = await founder.request.post(`${app(baseURL)}/api/crews`, { data: {} });
    expect(made.ok()).toBe(true);
    const token: string = (await made.json()).crew.token;
    await founder.close();

    await page.goto(`${site(baseURL)}/en/crew/${token}`);
    // The app's invite page keeps the token in the tab and out of the address bar.
    await expect(page).toHaveURL(`${app(baseURL)}/invite`);
    await expect(page.getByRole("link", { name: "Join with Steam" }).first()).toBeVisible();

    const preview = await request.get(`${app(baseURL)}/invite/${token}`, {
      headers: { "accept-language": "en" },
    });
    expect(preview.headers()["x-robots-tag"]).toBe("noindex");
    const html = await preview.text();
    expect(html).toContain('<meta property="og:title" content="Join the crew" />');
    expect(html).toContain(`<meta property="og:image" content="${app(baseURL)}/og/og-crew-en.jpg" />`);
    expect(html).not.toContain(token);
    const card = await request.get(`${app(baseURL)}/og/og-crew-en.jpg`);
    expect(card.headers()["content-type"]).toBe("image/jpeg");
  });

  test("a gift, the Zockrunde page, the host pages, Lanterel OS and the legal pages load clean", async ({
    page,
    baseURL,
  }) => {
    const origin = site(baseURL);
    const problems = watch(page, origin);
    for (const path of [
      "/en/gift/G1ft",
      "/night/N1ght",
      "/host/",
      "/en/host/",
      "/lanterel-os/",
      "/en/lanterel-os/",
      "/impressum/",
      "/en/privacy/",
    ]) {
      const answer = await page.goto(`${origin}${path}`);
      expect(answer?.status(), path).toBe(200);
      await expect(page, path).toHaveTitle(/Lanterel/);
      await expect(page.locator("body"), path).not.toContainText(/Abend|tonight|crew night/i);
    }
    expect(problems).toEqual([]);
  });

  test("leaves the app's own host alone", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("a.wordmark")).toHaveCount(0);
  });
});
