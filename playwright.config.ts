import { defineConfig, devices } from "@playwright/test";
import { E2E_ENV } from "./e2e/tests/credentials";

// End-to-end tests run against the real thing: the real signaling server
// serving the real production build, driving real RTCPeerConnections.
//
// This config lives at the repo root rather than in e2e/ so that `webServer.cwd`
// is the workspace root by default — Playwright loads the config as CommonJS
// (the root package is not type: module), which rules out import.meta tricks.
//
// Port 8099 rather than the default 8080, so a dev server someone left running
// is never mistaken for the one under test.
const PORT = Number(process.env.E2E_PORT ?? 8099);

export default defineConfig({
  testDir: "./e2e/tests",
  outputDir: "./e2e/.results",
  // Each spec owns a whole browser and a peer connection; running them in
  // parallel on a 2-core runner makes ICE timing, not the code, decide.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: "e2e/.report" }], ["list"]]
    : [["list"]],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "web",
      testMatch: /web\..*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            // Grant capture permission without a prompt, and hand back a
            // synthetic device instead of whatever is on the runner's screen.
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            "--auto-select-desktop-capture-source=Entire screen",
            "--autoplay-policy=no-user-gesture-required",
            // Chrome hides local IPs behind mDNS .local candidates. Two
            // isolated contexts in one headless browser cannot resolve each
            // other's names, so ICE would fail for a reason that has nothing
            // to do with this app.
            "--disable-features=WebRtcHideLocalIpsWithMdns",
          ],
        },
      },
    },
    {
      // Electron launches its own binary; it takes no browser from Playwright.
      name: "desktop",
      testMatch: /desktop\..*\.spec\.ts/,
    },
  ],

  // `npm run dev` builds the web app and then serves it, which is exactly the
  // path the README documents — so e2e fails if that path breaks.
  webServer: {
    command: "npm run dev",
    url: `http://127.0.0.1:${PORT}`,
    // The marketing site on a host of its own (*.localhost is loopback to the
    // browser), so every other spec keeps the app at 127.0.0.1.
    env: {
      PORT: String(PORT),
      ...E2E_ENV,
      MARKETING_PAGES: "on",
      SITE_ORIGIN: `http://lanterel.localhost:${PORT}`,
    },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
