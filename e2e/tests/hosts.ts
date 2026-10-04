// The browser host page and the e2e machine, as the specs drive them: the
// /host page sharing a canvas in place of a screen, and the machine offered
// through the Host API as its PC would offer it.

import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_MACHINE_KEY, E2E_ROOM } from "./credentials";

/** Open the browser host page and start sharing into the e2e room. */
export async function startHost(page: Page, key = E2E_MACHINE_KEY) {
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
export async function fakeScreenCapture(page: Page) {
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
export function failOnPageError(page: Page, label: string) {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`${label}: ${err.message}`));
  return errors;
}

/** The heartbeat that keeps the offered machine on offer, while one runs. */
let beating: ReturnType<typeof setInterval> | undefined;

/**
 * Offer the e2e machine through the Host API as its PC would, beating every
 * 5 s as the host app does, or take it back. It has every game a signed-in
 * renter's wall could lead with installed: the curated free-to-play two, and
 * Steam's most played, whose free ones fill the wall once the server has read
 * them.
 */
export async function offerHost(request: APIRequestContext, available: boolean) {
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
