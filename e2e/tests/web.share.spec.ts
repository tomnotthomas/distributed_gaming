// Share your PC is the website half of hosting, reached from the renter app's
// top bar and at its own address: the estimate, How we got this number, and the
// one download. Everything after the download happens in the desktop app.

import { expect, test } from "@playwright/test";

const figure = (page: import("@playwright/test").Page) => page.locator(".share-figure b");

test.describe("share your PC", () => {
  test("opens from the top bar at its own address", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("navigation").getByRole("button", { name: "Share your PC" }).click();

    await expect(page).toHaveURL(/\/share$/);
    await expect(page.getByRole("heading", { name: "Your PC could earn" })).toBeVisible();
    await expect(figure(page)).toHaveText("€62");

    // Back returns to the wall; Forward brings the estimate back.
    await page.goBack();
    await expect(page.getByTestId("wall")).toBeVisible();
    await page.goForward();
    await expect(page.getByTestId("share")).toBeVisible();
  });

  test("serves the estimate at /share and leaves it for the wall", async ({ page }) => {
    await page.goto("/share");
    await expect(page.getByTestId("share")).toBeVisible();

    await page.getByRole("navigation").getByRole("button", { name: "Home" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("wall")).toBeVisible();
  });

  test("re-estimates by tier and explains the number on a sheet", async ({ page }) => {
    await page.goto("/share");
    await page.getByRole("radio", { name: /Enthusiast/ }).click();
    await expect(figure(page)).toHaveText("€81");

    await page.getByRole("button", { name: "How we got this number" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toContainText("for an Enthusiast rig");
    await expect(page.getByRole("button", { name: "Close" })).toBeFocused();

    await sheet.getByLabel("Hours away per day").fill("8");
    await expect(sheet).toContainText("95 h streamed");
    await expect(figure(page)).toHaveText("€108");

    // Escape puts the sheet away and stays on the estimate.
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/share$/);
    await expect(page.getByRole("button", { name: "How we got this number" })).toBeFocused();
  });

  test("offers one download for Windows", async ({ page }) => {
    await page.goto("/share");
    const download = page.getByRole("link", { name: /Download for Windows/ });
    await expect(download).toHaveAttribute("href", /^https:\/\//);
  });
});
