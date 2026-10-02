// The wall is what "/" serves now, so this pins what a first-time visitor must
// see: hero 3b (the art with its drafted title, the strip under it) filling the
// first screen with the band just below the fold, one Sign in with Steam, and
// no way to play until they have signed in.

import { expect, test } from "@playwright/test";
import { signIn } from "./credentials";

/** Common screens, desktop and phone. */
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
];

test.describe("live wall", () => {
  test("serves the wall at the root route", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByTestId("wall")).toBeVisible();
    // One game leads the hero; one ruled row of four fills the band under it.
    await expect(page.locator(".band-tile")).toHaveCount(4);
  });

  for (const viewport of VIEWPORTS) {
    test(`fills the first screen with the hero and its strip at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");

      // The strip ends at the bottom of the viewport; the band starts just below the fold.
      const strip = (await page.locator(".hero-strip").boundingBox())!;
      expect(Math.abs(strip.y + strip.height - viewport.height)).toBeLessThanOrEqual(1);
      const band = (await page.locator(".band").boundingBox())!;
      expect(band.y).toBeGreaterThanOrEqual(viewport.height - 1);
    });

    for (const signedIn of [false, true]) {
      test(`lays the hero out without collisions at ${viewport.width}x${viewport.height}, ${
        signedIn ? "signed in" : "signed out"
      }`, async ({ page, context, baseURL }) => {
        if (signedIn) await signIn(context, baseURL!);
        await page.setViewportSize(viewport);
        await page.goto("/");
        await page.evaluate(() => document.fonts.ready);

        const art = (await page.locator(".hero-3b-art").boundingBox())!;
        const strip = (await page.locator(".hero-strip").boundingBox())!;
        const title = (await page.locator(".hero-3b-title").boundingBox())!;
        const action = (await page
          .locator(".hero-strip")
          .getByRole(signedIn ? "button" : "link")
          .first()
          .boundingBox())!;

        // The drafted title stays on the art, clear of the header and the strip.
        expect(title.x).toBeGreaterThanOrEqual(art.x);
        expect(title.x + title.width).toBeLessThanOrEqual(art.x + art.width);
        expect(title.y + title.height).toBeLessThanOrEqual(art.y + art.height);
        const bar = (await page.locator(".bar").boundingBox())!;
        expect(title.y).toBeGreaterThanOrEqual(bar.y + bar.height);
        // Resume or Sign in with Steam sits inside the strip, below the art.
        expect(strip.y).toBeGreaterThanOrEqual(art.y + art.height - 1);
        expect(action.y).toBeGreaterThanOrEqual(strip.y);
        expect(action.y + action.height).toBeLessThanOrEqual(strip.y + strip.height);
        // Nothing runs off the side of the page.
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
      });
    }
  }

  test.describe("under reduced motion", () => {
    test.use({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });

    // Reduced motion gives every element a short transition; the title is
    // fitted by measuring, so it must not read a half-changed size and shrink.
    test("still sets the drafted title large", async ({ page }) => {
      await page.goto("/");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);

      const size = await page
        .locator(".hero-3b-title")
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(size).toBeGreaterThanOrEqual(64);
    });
  });

  test("offers a signed-out visitor exactly one way in: Sign in with Steam", async ({ page }) => {
    await page.goto("/");

    const signIn = page.getByRole("link", { name: /sign in/i });
    await expect(signIn).toHaveCount(1);
    await expect(signIn).toHaveText("Sign in with Steam");
    await expect(signIn).toHaveAttribute("href", "/auth/steam/login");
    await expect(page.getByRole("button", { name: /play free/i })).toHaveCount(0);
  });

  test("starts Steam OpenID from the sign-in route", async ({ request }) => {
    const res = await request.get("/auth/steam/login?to=/", { maxRedirects: 0 });

    expect(res.status()).toBe(302);
    const location = new URL(res.headers()["location"]!);
    expect(location.origin + location.pathname).toBe("https://steamcommunity.com/openid/login");
    expect(location.searchParams.get("openid.mode")).toBe("checkid_setup");
  });

  test("plays no trailer behind the hero or the game page", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("hero").locator(".backdrop-still").first()).toBeVisible();
    await expect(page.getByTestId("hero").locator("video")).toHaveCount(0);

    await page.locator("button.band-tile").first().click();
    await expect(page.locator(".menu-photo .backdrop-still")).toBeVisible();
    await expect(page.locator(".menu video")).toHaveCount(0);
  });

  test("asks a signed-out visitor to sign in where they would launch", async ({ page }) => {
    await page.goto("/");
    await page.locator("button.band-tile").first().click();

    // The machines can still be compared; launching cannot start.
    await expect(page.locator(".ledger-row").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /hold to launch/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Sign in with Steam" })).toHaveAttribute(
      "href",
      "/auth/steam/login",
    );
  });

  test("opens a game with a machine already chosen for a signed-in renter", async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL!);
    await page.goto("/");
    await page.locator("button.band-tile").first().click();

    // A machine is picked for you, so the hold-to-launch reticle is live on arrival.
    await expect(page.getByRole("button", { name: /^Hold to launch on / })).toBeEnabled();
    await expect(page.locator(".ledger-row.on")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("link", { name: /sign in/i })).toHaveCount(0);
  });

  test("shows a renter signed in from the session even when Steam gave no name", async ({
    page,
    context,
    baseURL,
  }) => {
    // The e2e server has no STEAM_API_KEY, so the profile behind the session is empty.
    await signIn(context, baseURL!);
    await page.goto("/");
    await page.getByRole("navigation").getByRole("button", { name: "Profile" }).click();

    await expect(page.getByText("Signed in with Steam")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(page.getByText("Not signed in")).toHaveCount(0);
  });

  test("lists the ranked machines beside the game", async ({ page }) => {
    await page.goto("/");
    await page.locator("button.band-tile").first().click();

    await expect(page.locator(".ledger-row").first()).toBeVisible();
    await expect(page.locator(".ledger-row").first()).toContainText("ms");
  });
});
