// Real Play, end to end: a signed-in renter holds Launch on the real host the
// wall offers, and the game plays inside Swiff.
//
// The browser /host page stands in for the gaming PC, as it does for the PC
// service and its streamer until they exist: it shares a canvas, hears
// session-claimed, starts the host session and serves it with its session key,
// and answers launch-game with game-started. Everything on the renter's side
// is the code that ships: the booking, the claim with no click, Ignition on the
// connection's events, the stream in Swiff, the HUD and End.

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { signIn } from "./credentials";
import { failOnPageError, fakeScreenCapture, offerHost, startHost } from "./hosts";

// One room, one server, one renter at a time: see web.streaming.spec.ts.
test.describe.configure({ mode: "serial" });

test.describe("real Play", () => {
  const contexts: BrowserContext[] = [];

  async function openPage(browser: Browser): Promise<Page> {
    const context = await browser.newContext();
    contexts.push(context);
    return context.newPage();
  }

  test.afterEach(async ({ request }) => {
    await Promise.all(contexts.splice(0).map((c) => c.close().catch(() => {})));
    await offerHost(request, false);
    // Let the server handle the closes before the next test registers the room.
    await new Promise((r) => setTimeout(r, 400));
  });

  /**
   * The machine on offer, beating as its PC service would, and a signed-in
   * renter on its game. The PC is not sharing yet, so a launch waits on it.
   */
  async function readyToLaunch(browser: Browser, baseURL: string, request: Parameters<typeof offerHost>[0]) {
    await offerHost(request, true);
    const renter = await openPage(browser);
    await signIn(renter.context(), baseURL);
    await renter.goto("/");
    const hero = renter.getByTestId("hero");
    await expect(hero.locator(".hero-strip-line")).toContainText("E2E rig");
    await hero.locator("button.resume").click();
    const launch = renter.getByRole("button", { name: "Hold to launch on E2E rig" });
    await expect(launch).toBeEnabled();
    return { renter, launch };
  }

  /** The PC wakes: the /host page shares into the e2e room with the machine key. */
  async function wake(browser: Browser) {
    const host = await openPage(browser);
    await fakeScreenCapture(host);
    await startHost(host);
    return host;
  }

  /** Hold Launch past its 600 ms: a click launches nothing. */
  async function hold(page: Page, button: ReturnType<Page["getByRole"]>) {
    await button.hover();
    await page.mouse.down();
    await page.waitForTimeout(900);
    await page.mouse.up();
  }

  /** The booking the renter's page is playing, read with its own sign-in. */
  const played = (renter: Page) =>
    renter.evaluate(async () => {
      const play = JSON.parse(localStorage.getItem("swiff.play") ?? "null") as { bookingId: string } | null;
      if (!play) return null;
      const res = await fetch(`/api/bookings/${play.bookingId}`);
      return { bookingId: play.bookingId, ...((await res.json()) as { status: string }) };
    });

  test("books the picked host, plays it in Swiff once the game runs, and ends with End", async ({
    browser,
    baseURL,
    request,
  }) => {
    const { renter, launch } = await readyToLaunch(browser, baseURL!, request);
    const renterErrors = failOnPageError(renter, "renter");

    await launch.click();
    await expect(renter.getByTestId("ignition")).toHaveCount(0);

    // Reserved and claimed with no click, then waiting on the PC to offer its stream.
    await hold(renter, launch);
    await expect(renter.getByTestId("ignition")).toBeVisible();
    await expect(renter.getByRole("listitem").filter({ hasText: "Waking E2E rig" })).toHaveAttribute(
      "data-state",
      "now",
    );
    await expect.poll(async () => (await played(renter))?.status, { timeout: 15_000 }).toBe("claimed");
    // Kept for resume without the join ticket, a bearer credential.
    expect(await renter.evaluate(() => localStorage.getItem("swiff.play"))).not.toMatch(/ticket/);

    // The PC wakes, hears the claim and starts the session.
    const host = await wake(browser);
    const hostErrors = failOnPageError(host, "host");
    await expect(host.getByText(/Claimed by a renter for \d+ minutes/)).toBeVisible();

    // The first frame starts the session, the PC says the game runs, and the
    // stream is what the renter sees.
    await expect(renter.getByTestId("ignition")).toHaveCount(0, { timeout: 45_000 });
    const video = renter.getByTestId("session-video");
    await expect(video).toBeVisible();
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), {
        timeout: 15_000,
        message: "the stream never showed a frame in Swiff",
      })
      .toBeGreaterThan(0);
    await expect(host.getByText("A renter is connected.")).toBeVisible();
    await expect(renter.getByTestId("hud-stats")).toContainText(/\d+ fps/, { timeout: 15_000 });
    const booking = await played(renter);
    expect(booking?.status).toBe("playing");

    // The HUD gets out of the way, and comes back for End.
    await expect(renter.getByTestId("session")).toHaveAttribute("data-hud", "hidden", { timeout: 10_000 });
    await renter.mouse.move(400, 300);
    await renter.mouse.move(420, 320);
    await renter.getByRole("button", { name: "End session" }).click();
    await expect(renter.getByTestId("session")).toHaveCount(0);

    // Ended on the server as the renter's own, and the PC is handed back.
    // End is not awaited before the session view goes, so the booking gets there a moment later.
    await expect
      .poll(() =>
        renter.evaluate(
          async (id) => ((await (await fetch(`/api/bookings/${id}`)).json()) as { status: string }).status,
          booking!.bookingId,
        ),
      )
      .toBe("ended");
    await expect(host.getByText(/Claimed by a renter/)).toHaveCount(0, { timeout: 15_000 });

    expect(hostErrors).toEqual([]);
    expect(renterErrors).toEqual([]);
  });

  test("cancels a launch from Ignition, ending its booking", async ({ browser, baseURL, request }) => {
    const { renter, launch } = await readyToLaunch(browser, baseURL!, request);

    // No PC is sharing, so Ignition waits on it to wake.
    await hold(renter, launch);
    await expect(renter.getByTestId("ignition")).toBeVisible();
    await expect.poll(async () => (await played(renter))?.status, { timeout: 15_000 }).toBe("claimed");
    const bookingId = (await played(renter))!.bookingId;

    await renter.getByRole("button", { name: "Cancel" }).click();
    await expect(renter.getByTestId("ignition")).toHaveCount(0);
    await expect(renter.getByTestId("session")).toHaveCount(0);
    await expect
      .poll(() =>
        renter.evaluate(
          async (id) => ((await (await fetch(`/api/bookings/${id}`)).json()) as { status: string }).status,
          bookingId,
        ),
      )
      .toBe("ended");
  });
});
