// The wall is what "/" serves now, so this pins what a first-time visitor must
// see: a hero that fills the first screen with the band peeking under it, one
// Sign in with Steam, and no way to play until they have signed in.

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
    test(`shows only a peek of the band under the hero at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");

      const band = await page.locator(".band").boundingBox();
      // The band starts above the fold, by no more than a peek.
      const peek = viewport.height - band!.y;
      expect(peek).toBeGreaterThanOrEqual(40);
      expect(peek).toBeLessThanOrEqual(120);
    });
  }

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
    await expect(page.locator(".hero .backdrop-still").first()).toBeVisible();
    await expect(page.locator(".hero video")).toHaveCount(0);

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
