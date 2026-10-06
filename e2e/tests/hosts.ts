// The browser host page and the e2e machine, as the specs drive them: the
// /host page sharing a canvas in place of a screen, and the machine offered
// through the Host API as its PC would offer it.

import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_MACHINE_KEY, E2E_ROOM } from "./credentials";

/**
 * Open the browser host page and start sharing into the e2e room, or into
 * `room` with its `key`. The page always names the e2e room (HOST_ID), so for
 * another room its signaling socket, both ways, and its Host API calls say
 * that room's name in its place.
 */
export async function startHost(page: Page, key = E2E_MACHINE_KEY, room = E2E_ROOM) {
  if (room !== E2E_ROOM) {
    await page.addInitScript(
      ({ from, to }) => {
        const swap = (text: string, a: string, b: string) =>
          text.split(`"hostId":"${a}"`).join(`"hostId":"${b}"`);
        const fetch = window.fetch;
        window.fetch = (input, init) =>
          fetch(
            typeof input === "string"
              ? input.replace(`/api/machines/${from}/`, `/api/machines/${to}/`)
              : input,
            init,
          );
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          return send.call(this, typeof data === "string" ? swap(data, from, to) : data);
        };
        const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")!.get!;
        Object.defineProperty(MessageEvent.prototype, "data", {
          get() {
            const value = data.call(this);
            return this.target instanceof WebSocket && typeof value === "string"
              ? swap(value, to, from)
              : value;
          },
        });
      },
      { from: E2E_ROOM, to: room },
    );
  }
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
 * Offer the e2e machine (or `room`, with its `key`) through the Host API as
 * its PC would, beating every 5 s as the host app does, or take it back. It has every game a signed-in
 * renter's wall could lead with installed: the curated free-to-play two, and
 * Steam's most played, whose free ones fill the wall once the server has read
 * them.
 */
export async function offerHost(
  request: APIRequestContext,
  available: boolean,
  room = E2E_ROOM,
  key = E2E_MACHINE_KEY,
) {
  clearInterval(beating);
  beating = undefined;
  const popular = available ? await request.get("/api/games/popular") : null;
  const chart = popular?.ok() ? ((await popular.json()).games as { appid: number }[]) : [];
  const res = await request.put(`/api/machines/${room}/availability`, {
    headers: { authorization: `Bearer ${key}` },
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
      .post(`/api/machines/${room}/heartbeat`, {
        headers: { authorization: `Bearer ${key}` },
      })
      .catch(() => {});
  }, 5_000);
}
