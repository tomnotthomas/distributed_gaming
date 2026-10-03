// The wall is what "/" serves now, so this pins what a first-time visitor must
// see: hero 3b (the art with its drafted title, the strip under it) filling the
// first screen with the band just below the fold, one Sign in with Steam, and
// no way to play until they have signed in.
//
// "/" runs on the real hosts: signed out it shows no availability at all, and
// signed in it shows the machines the server offers. What needs machines to
// look at runs on the demo's five invented ones, at /?demo=1.

import { expect, test, type APIRequestContext } from "@playwright/test";
import { E2E_MACHINE_KEY, E2E_ROOM, signIn } from "./credentials";

/** The demo: five invented machines at a pinned 20:00. */
const DEMO = "/?demo=1";

/** The heartbeat that keeps the offered machine on offer, while one runs. */
let beating: ReturnType<typeof setInterval> | undefined;

/**
 * Offer the e2e machine through the Host API as its PC would, beating every
 * 5 s as the host app does, or take it back. It has every game a signed-in
 * renter's wall could lead with installed: the curated free-to-play two, and
 * Steam's most played, whose free ones fill the wall once the server has read
 * them.
 */
async function offerHost(request: APIRequestContext, available: boolean) {
  clearInterval(beating);
  beating = undefined;
  const popular = available ? await request.get("/api/games/popular") : null;
  const chart = popular?.ok() ? ((await popular.json()).games as { appid: number }[]) : [];
  const res = await request.put(`/api/machines/${E2E_ROOM}/availability`, {
    headers: { authorization: `Bearer ${E2E_MACHINE_KEY}` },
    data: {
      available,
      name: "E2E rig",
      hardware: {
        gpu: "NVIDIA GeForce RTX 4070",
        vramMb: 12_288,
        ramMb: 32_768,
        cpu: "AMD Ryzen 7 7800X3D",
        cores: 8,
        encoders: ["h264", "hevc", "av1"],
        display: { width: 2560, height: 1440, refreshHz: 144 },
      },
      games: [...new Set([730, 2073850, ...chart.map((g) => g.appid)])],
      controls: ["kb", "mouse", "pad"],
      // Next to the server: the renter's own round trip, which a busy runner
      // inflates, is then all that counts against the 80 ms limit (gate E6).
      net: { rttMs: 1, jitterMs: 1, upMbps: 100 },
    },
  });
  expect(res.status()).toBe(200);
  if (!available) return;
  // Silent for 15 s, a machine is no longer offered.
  beating = setInterval(() => {
    void request
      .post(`/api/machines/${E2E_ROOM}/heartbeat`, {
        headers: { authorization: `Bearer ${E2E_MACHINE_KEY}` },
      })
      .catch(() => {});
  }, 5_000);
}

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
        // Signed in, the hero needs a machine to offer.
        await page.goto(signedIn ? DEMO : "/");
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
    await page.goto(DEMO);
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
    await page.goto(DEMO);
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
    await page.goto(DEMO);
    await page.locator("button.band-tile").first().click();

    await expect(page.locator(".ledger-row").first()).toBeVisible();
    await expect(page.locator(".ledger-row").first()).toContainText("ms");
  });

  test("keeps the demo on its own address as the renter moves around", async ({ page }) => {
    await page.goto(DEMO);
    await page.getByRole("navigation").getByRole("button", { name: "Share your PC" }).click();
    await expect(page).toHaveURL(/\/share\?demo=1$/);
    await page.getByRole("navigation").getByRole("button", { name: "Home" }).click();
    await expect(page).toHaveURL(/\/\?demo=1$/);
    await expect(page.locator(".bar-live")).toContainText("free near you");
  });
});

test.describe("live wall on the real hosts", () => {
  test.afterEach(async ({ request }) => offerHost(request, false));

  test("shows a signed-out visitor no availability, even with a host on offer", async ({ page, request }) => {
    await offerHost(request, true);
    await page.goto("/");

    await expect(page.locator(".band-tile").first()).toBeVisible();
    await expect(page.getByText(/free near you|free for this game|E2E rig|Back at/)).toHaveCount(0);
    await expect(page.locator(".bar-live")).toHaveText("");

    await page.locator("button.band-tile").first().click();
    await expect(page.locator(".ledger-row")).toHaveCount(0);
    await expect(page.getByText(/Sign in to see which machines can play it/)).toBeVisible();
  });

  test("tells a signed-in renter nothing is ready when no host is on offer", async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL!);
    await page.goto("/");

    await expect(page.getByText("Nothing is ready right now")).toBeVisible();
    await expect(page.getByText(/No shared machine is free right now/)).toBeVisible();
    await expect(page.getByText(/Moss|Glasshouse|Tide|Ember/)).toHaveCount(0);
  });

  test("offers a signed-in renter the real host, and launches on it", async ({
    page,
    context,
    baseURL,
    request,
  }) => {
    await offerHost(request, true);
    await signIn(context, baseURL!);
    await page.goto("/");

    // The game the host can run leads the wall, on that host, free all night.
    const hero = page.getByTestId("hero");
    await expect(hero.locator(".hero-strip-line")).toContainText("E2E rig");
    await expect(hero.locator(".hero-strip-line")).toContainText("free all night");
    await expect(page.locator(".bar-live")).toContainText(/ready now/);

    await hero.locator("button.resume").click();
    const row = page.locator(".ledger-row").first();
    await expect(row).toContainText("E2E rig");
    await expect(row).toContainText("NVIDIA GeForce RTX 4070");
    await expect(page.getByRole("button", { name: "Hold to launch on E2E rig" })).toBeEnabled();
    await expect(page.locator(".bar-live")).toHaveText("1 free for this game");
  });

  test("puts a signed-in renter's wall right when the host is taken back", async ({
    page,
    context,
    baseURL,
    request,
  }) => {
    await offerHost(request, true);
    await signIn(context, baseURL!);
    await page.goto("/");
    await expect(page.getByTestId("hero").locator(".hero-strip-line")).toContainText("E2E rig");

    // The availability event arrives on the stream, and the wall reads again.
    await offerHost(request, false);
    await expect(page.getByText("Nothing is ready right now")).toBeVisible();
  });
});
