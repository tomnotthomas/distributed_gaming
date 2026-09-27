// The wall is what "/" serves now, so this pins the two things a first-time
// visitor must see: the grid, and Valve's own sign-in button rather than a
// lookalike we drew ourselves.

import { expect, test } from "@playwright/test";

test.describe("live wall", () => {
  test("serves the wall at the root route", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByTestId("wall")).toBeVisible();
    // Seven tiles fill the grid: one hero, two wide, four small.
    await expect(page.locator(".tile")).toHaveCount(7);
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
    await page.locator("button.tile").first().click();

    // A machine is picked for you, so Launch is live on arrival.
    await expect(page.getByRole("button", { name: /Launch/ })).toBeEnabled();
    await expect(page.getByText(/hold to launch/)).toBeVisible();
  });

  test("opens the machine selector on demand", async ({ page }) => {
    await page.goto("/");
    await page.locator("button.tile").first().click();

    // The selector folds itself when the top two machines are not close, so
    // reaching the cards can take a click.
    const change = page.getByRole("button", { name: "Change machine" });
    if (await change.isVisible()) await change.click();

    await expect(page.locator(".machine").first()).toBeVisible();
    await expect(page.locator(".machine").first()).toContainText("ms");
  });
});
