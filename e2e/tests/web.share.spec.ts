// Share your PC is the website half of hosting, reached from the renter app's
// top bar and at its own address: the estimate, How we got this number, the
// one download, and what a host can check for themselves (its SHA-256).
// Everything after the download happens in the desktop app.

import { expect, test } from "@playwright/test";
import { signIn } from "./credentials";
import RELEASE from "../../web/src/swiff/release.json";

/** What the release step published for the page the web server serves (null until a download exists). */
const HOST = (RELEASE as { host: { url: string | null; sha256: string } | null }).host;

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
    await expect(sheet).toContainText("for an Enthusiast PC");
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

  test("offers the Windows download once one is published, as coming soon until then", async ({ page }) => {
    await page.goto("/share");
    const link = page.getByTestId("share").getByRole("link", { name: /Download for Windows/ });
    if (HOST?.url) {
      await expect(link).toHaveAttribute("href", HOST.url);
      return;
    }
    const download = page.getByRole("button", { name: /Download for Windows/ });
    await expect(download).toBeDisabled();
    await expect(download).toHaveAccessibleDescription("Coming soon");
    await expect(link).toHaveCount(0);

    await download.click({ force: true });
    await expect(page).toHaveURL(/\/share$/);
  });

  test("says what a host can check for themselves, and where the download's SHA-256 goes", async ({
    page,
  }) => {
    await page.goto("/share");
    await page.getByRole("link", { name: "Check the download" }).click();
    await expect(page).toHaveURL(/\/share#trust$/);
    const trust = page.locator("#trust");
    await expect(trust).toBeInViewport();
    await expect(trust).toContainText("Swiff never reads, sends or keeps it");
    await expect(trust).toContainText("One click starts its removal");
    await expect(trust).toContainText(HOST ? HOST.sha256 : "SHA-256 is published here with it");
    await expect(page.getByTestId("share")).toBeVisible();
  });

  test("keeps a running launch in place on Back", async ({ page, context, baseURL }) => {
    // Only a signed-in renter can launch, and only on a machine: the demo's.
    await signIn(context, baseURL!);
    await page.goto("/share?demo=1");
    await page.getByRole("navigation").getByRole("button", { name: "Home" }).click();
    await page.locator("button.band-tile").first().click();

    const reticle = page.getByRole("button", { name: /^Hold to launch on / });
    await reticle.focus();
    await page.keyboard.down(" ");
    await expect(page.locator(".sw-page")).toHaveAttribute("inert", "");
    await page.keyboard.up(" ");

    await page.goBack();
    await expect(page).toHaveURL(/\/\?demo=1$/);
    await expect(page.locator(".sw")).toHaveAttribute("data-screen", "game");

    await page.getByRole("button", { name: "End session" }).click({ timeout: 15_000 });
    await expect(page.locator(".sw")).toHaveAttribute("data-screen", "game");
    await expect(page.getByTestId("share")).toHaveCount(0);
  });
});
