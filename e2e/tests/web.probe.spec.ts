// Latency probes, end to end: a signed-in renter's game page measures the real
// path to the machine at the top of its list, and the browser /host page, the
// PC, answers. Real server, real production bundle, two real peer connections
// over loopback.
//
// The host is offered as if it sat 40 ms from the server, so the estimate
// through the server reads 40 ms or more; measured straight over loopback it is
// a few. The probe must neither take the seat nor reach the renter the host
// page waits for.

import { expect, test, type APIRequestContext, type Browser, type BrowserContext } from "@playwright/test";
import { E2E_MACHINE_KEY, E2E_ROOM, signIn } from "./credentials";

/** The heartbeat that keeps the offered machine on offer. */
let beating: ReturnType<typeof setInterval> | undefined;

/** Offer the e2e machine through the Host API as its PC would, or take it back. */
async function offerHost(request: APIRequestContext, available: boolean) {
  clearInterval(beating);
  beating = undefined;
  const auth = { authorization: `Bearer ${E2E_MACHINE_KEY}` };
  const res = await request.put(`/api/machines/${E2E_ROOM}/availability`, {
    headers: auth,
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
      // The curated free-to-play two, so the wall leads with one without asking Steam.
      games: [730, 2073850],
      controls: ["kb", "mouse", "pad"],
      net: { rttMs: 40, jitterMs: 1, upMbps: 100 },
    },
  });
  expect(res.status()).toBe(200);
  if (available) {
    beating = setInterval(() => {
      void request.post(`/api/machines/${E2E_ROOM}/heartbeat`, { headers: auth }).catch(() => {});
    }, 5_000);
  }
}

test.describe.configure({ mode: "serial" });

test.describe("latency probes", () => {
  const contexts: BrowserContext[] = [];

  async function openContext(browser: Browser) {
    const context = await browser.newContext();
    contexts.push(context);
    return context;
  }

  test.afterEach(async ({ request }) => {
    await offerHost(request, false);
    await Promise.all(contexts.splice(0).map((c) => c.close().catch(() => {})));
    // The server frees a room on socket close; let those land before the next test.
    await new Promise((r) => setTimeout(r, 400));
  });

  test("measures the best machine straight from the game page, answered by the /host page", async ({
    browser,
    baseURL,
    request,
  }) => {
    // The PC: the browser host page sharing a canvas, registered in the e2e room.
    const host = await (await openContext(browser)).newPage();
    await host.addInitScript(() => {
      const canvas = document.createElement("canvas");
      canvas.getContext("2d")!.fillRect(0, 0, 10, 10);
      const stream = (canvas as HTMLCanvasElement & { captureStream(): MediaStream }).captureStream();
      for (const track of stream.getVideoTracks()) track.applyConstraints = async () => {};
      navigator.mediaDevices.getDisplayMedia = async () => stream;
    });
    await host.goto("/host");
    await host.getByLabel("Machine key").fill(E2E_MACHINE_KEY);
    await host.getByRole("button", { name: "Start sharing" }).click();
    await expect(host.getByText("Waiting for a renter…")).toBeVisible();
    await offerHost(request, true);

    // The renter, signed in, opens the game the host can run.
    const context = await openContext(browser);
    await signIn(context, baseURL!);
    const renter = await context.newPage();
    const probes: unknown[] = [];
    renter.on("websocket", (ws) =>
      ws.on("framesent", ({ payload }) => {
        const msg = JSON.parse(String(payload)) as { type: string };
        if (msg.type === "probe") probes.push(msg);
      }),
    );
    await renter.goto("/");
    const hero = renter.getByTestId("hero");
    await expect(hero.locator(".hero-strip-line")).toContainText("E2E rig");
    expect(probes, "the wall never probes").toHaveLength(0);
    await hero.locator("button.resume").click();

    // Measured straight over loopback: a few ms, not the 40 the estimate adds up to.
    const ms = renter.locator(".ledger-row").first().locator(".ledger-ms");
    await expect(ms).toHaveAttribute("title", "Measured straight to this PC", { timeout: 15_000 });
    expect(Number((await ms.textContent())!.replace(/\D+$/, ""))).toBeLessThan(40);
    await expect(renter.locator(".ledger-head")).toContainText("1 machine");
    expect(probes).toHaveLength(1);

    // A probe is not a renter: the seat is still free.
    await expect(host.getByText("Waiting for a renter…")).toBeVisible();
  });
});
