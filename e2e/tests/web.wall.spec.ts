// The wall is what "/" serves now, so this pins the two things a first-time
// visitor must see: the band of games, and Valve's own sign-in button rather
// than a lookalike we drew ourselves.

import { expect, test } from "@playwright/test";

test.describe("live wall", () => {
  test("serves the wall at the root route", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByTestId("wall")).toBeVisible();
    // One game leads the hero; one ruled row of four fills the band under it.
    await expect(page.locator(".band-tile")).toHaveCount(4);
  });

  test("offers Steam's published sign-in button before any library is connected", async ({ page }) => {
    await page.goto("/");

    const button = page.getByRole("link").filter({ has: page.getByAltText("Sign in through Steam") });
    await expect(button).toHaveAttribute("href", "/auth/steam/login");

    const img = page.getByAltText("Sign in through Steam");
    await expect(img).toHaveAttribute(
      "src",
      "https://community.steamstatic.com/public/images/signinthroughsteam/sits_01.png",
    );
  });

  test("starts Steam OpenID from the sign-in route", async ({ request }) => {
    const res = await request.get("/auth/steam/login?to=/", { maxRedirects: 0 });

    expect(res.status()).toBe(302);
    const location = new URL(res.headers()["location"]!);
    expect(location.origin + location.pathname).toBe("https://steamcommunity.com/openid/login");
    expect(location.searchParams.get("openid.mode")).toBe("checkid_setup");
  });

  test("opens a game with a machine already chosen", async ({ page }) => {
    await page.goto("/");
    await page.locator("button.band-tile").first().click();

    // A machine is picked for you, so the hold-to-launch reticle is live on arrival.
    await expect(page.getByRole("button", { name: /^Hold to launch on / })).toBeEnabled();
    await expect(page.locator(".ledger-row.on")).toHaveAttribute("aria-pressed", "true");
  });

  test("lists the ranked machines beside the game", async ({ page }) => {
    await page.goto("/");
    await page.locator("button.band-tile").first().click();

    await expect(page.locator(".ledger-row").first()).toBeVisible();
    await expect(page.locator(".ledger-row").first()).toContainText("ms");
  });
});
