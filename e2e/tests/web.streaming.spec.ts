// The whole product, end to end: a host starts sharing, a renter connects, and
// video actually arrives.
//
// Real signaling server, real production bundle, two real RTCPeerConnections
// negotiating over loopback. The single thing faked is the pixel source — a
// canvas stands in for the monitor, because a CI runner has no desktop worth
// capturing and `getDisplayMedia` would otherwise sit waiting for a human.
// Everything downstream of that track is the code that ships.

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { E2E_MACHINE_KEY, joinLink } from "./credentials";

/** Open the browser host page and start sharing into the e2e room. */
async function startHost(page: Page, key = E2E_MACHINE_KEY) {
  await page.goto("/host");
  await page.getByLabel("Machine key").fill(key);
  await page.getByRole("button", { name: "Start sharing" }).click();
}

/**
 * Replace `getDisplayMedia` with an animated canvas.
 *
 * Installed before any page script runs, so `Host` sees it as the real API.
 * The canvas is repainted on a timer because a still image encodes to almost
 * nothing and the renter's `videoWidth` can stay 0 — motion is what makes the
 * assertion below mean "frames are arriving".
 */
async function fakeScreenCapture(page: Page) {
  await page.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d")!;

    let frame = 0;
    setInterval(() => {
      frame += 1;
      ctx.fillStyle = `hsl(${(frame * 9) % 360} 70% 45%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#fff";
      ctx.font = "96px sans-serif";
      ctx.fillText(String(frame), 60, 400);
    }, 60);

    const stream = (
      canvas as HTMLCanvasElement & {
        captureStream(fps?: number): MediaStream;
      }
    ).captureStream(30);

    // Host applies width/frameRate constraints after the fact; a canvas track
    // rejects those, and the rejection would be reported as a capture failure.
    for (const track of stream.getVideoTracks()) {
      track.applyConstraints = async () => {};
    }

    navigator.mediaDevices.getDisplayMedia = async () => stream;
  });
}

/** Fail loudly on a page error rather than letting it surface as a timeout. */
function failOnPageError(page: Page, label: string) {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`${label}: ${err.message}`));
  return errors;
}

// The /host page always registers one room, HOST_ID, and every test in this
// file shares the one server process. So a test that leaves a socket open hands
// the next test a half-occupied room. Contexts are tracked and torn down between
// tests, and the teardown waits for the server to actually process the closes.
test.describe.configure({ mode: "serial" });

test.describe("host to renter streaming", () => {
  const contexts: BrowserContext[] = [];

  /** A peer in its own browser context, closed automatically after the test. */
  async function openPeer(browser: Browser): Promise<Page> {
    const context = await browser.newContext();
    contexts.push(context);
    return context.newPage();
  }

  test.afterEach(async () => {
    await Promise.all(contexts.splice(0).map((c) => c.close().catch(() => {})));
    // The server frees a room on socket close; let those land before the next
    // test registers into the same room id.
    await new Promise((r) => setTimeout(r, 400));
  });

  test("carries the host's screen to the renter's video element", async ({ browser }) => {
    const host = await openPeer(browser);
    const renter = await openPeer(browser);

    const hostErrors = failOnPageError(host, "host");
    const renterErrors = failOnPageError(renter, "renter");

    await fakeScreenCapture(host);

    await startHost(host);
    await expect(host.getByRole("heading", { name: "Gaming PC" })).toBeVisible();

    // The host registers and then waits; nobody has joined yet.
    await expect(host.getByText("Waiting for a renter…")).toBeVisible();

    await renter.goto(joinLink());
    await expect(renter.getByRole("heading", { name: "Swiff" })).toBeVisible();
    await renter.getByRole("button", { name: "Connect" }).click();

    // Each side learns about the other through the signaling server.
    await expect(host.getByText("A renter is connected.")).toBeVisible();

    // ICE completed and DTLS came up on both ends.
    await expect(renter.locator(".status")).toContainText("connected", { timeout: 30_000 });
    await expect(host.locator(".status")).toContainText("connected", { timeout: 30_000 });

    // One Stage per page, so the test id is unambiguous. Asserted rather than
    // assumed: a silent second video would make the polls below meaningless.
    await expect(renter.getByTestId("stage-video")).toHaveCount(1);

    // And frames are genuinely decoding, not just a negotiated-but-silent track.
    await expect
      .poll(() => renter.getByTestId("stage-video").evaluate((v: HTMLVideoElement) => v.videoWidth), {
        timeout: 30_000,
        message: "renter never received a decoded frame",
      })
      .toBeGreaterThan(0);

    // Polled, not read once: currentTime is still exactly 0 at the instant the
    // first frame decodes, and only advances as playback actually runs.
    await expect
      .poll(() => renter.getByTestId("stage-video").evaluate((v: HTMLVideoElement) => v.currentTime), {
        timeout: 15_000,
        message: "video decoded a frame but never started playing",
      })
      .toBeGreaterThan(0);

    // And the status line resolved which ICE path actually won, rather than
    // sitting on "unknown" — that is what makes a real srflx/relay run
    // readable later. Both peers are one machine here, so expect a local pair.
    await expect(renter.locator(".status")).not.toContainText("unknown", { timeout: 20_000 });
    await expect(renter.locator(".status")).toContainText(/host|srflx|relay|prflx/);

    expect(hostErrors).toEqual([]);
    expect(renterErrors).toEqual([]);
  });

  test("tells the renter the gaming PC is offline when nothing is sharing", async ({ page }) => {
    await page.goto(joinLink());
    await page.getByRole("button", { name: "Connect" }).click();

    await expect(page.getByText(/gaming PC is offline/)).toBeVisible();
  });

  test("tells the renter when the host disappears mid-session", async ({ browser }) => {
    const host = await openPeer(browser);
    const renter = await openPeer(browser);

    await fakeScreenCapture(host);
    await startHost(host);
    // Wait for the host to hold the room before the renter joins. Connecting
    // into a room the host has not registered yet is a real race worth its own
    // test; it is not what this one is about.
    await expect(host.getByText("Waiting for a renter…")).toBeVisible();

    await renter.goto(joinLink());
    await renter.getByRole("button", { name: "Connect" }).click();
    await expect(renter.locator(".status")).toContainText("connected", { timeout: 30_000 });

    // The gaming PC goes away without saying goodbye.
    await host.close();

    await expect(renter.getByText(/gaming PC disconnected/)).toBeVisible({ timeout: 20_000 });
  });

  test("a renter without a join link cannot connect", async ({ page }) => {
    await page.goto("/rtc");

    await expect(page.getByText("You need a join link to connect.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect" })).toHaveCount(0);
  });

  test("a renter with an expired link is told so", async ({ page }) => {
    await page.goto(joinLink(-60));
    await page.getByRole("button", { name: "Connect" }).click();

    await expect(page.getByText(/invalid or has expired/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();
  });

  test("the host is refused with the wrong machine key", async ({ page }) => {
    await fakeScreenCapture(page);
    await startHost(page, "not-the-key");

    await expect(page.getByText("The server refused this machine key.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start sharing" })).toBeVisible();
  });

  test("the host shows nothing is captured until sharing starts", async ({ page }) => {
    await fakeScreenCapture(page);
    await page.goto("/host");

    await expect(page.locator(".status")).toContainText("not capturing");
    await expect(page.getByRole("button", { name: "Start sharing" })).toBeVisible();
  });
});
