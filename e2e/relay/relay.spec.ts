// A renter and a gaming PC with no direct path between them: two networks
// that only reach the signaling server and a TURN relay (run.sh builds them).
// Without the relay the stream cannot come up; with it, it comes up through
// the relay on the credentials the server minted for that seat, with ICE left
// free to pick any path: nothing forces the relay but the network.
//
// Each side is a real browser in its own network, the PC on the /host page
// sharing a canvas, the renter on /rtc. Run with e2e/relay/run.sh, not on its
// own: outside its network both browsers reach each other directly.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { E2E_ENV, joinLink } from "../tests/credentials";
import { failOnPageError, fakeScreenCapture, startHost } from "../tests/hosts";

const PORT = 8199;
/** The signaling server, as this side reaches it. */
const SERVER = `http://10.20.1.1:${PORT}`;
/** And as each browser does: run.sh forwards its localhost to the server. */
const ORIGIN = `http://localhost:${PORT}`;

const { RENTER_PID, HOST_PID, SWIFF_RELAY_TURN_SECRET, SWIFF_RELAY_TURN_URLS, SWIFF_RELAY_TURN_LOG } =
  process.env;

test.skip(!RENTER_PID || !HOST_PID, "runs inside the networks e2e/relay/run.sh builds");

test.describe.configure({ mode: "serial" });

/** Chromium's binary: the full browser if installed, else the headless shell beside it. */
function realChrome(): string {
  if (process.env.SWIFF_RELAY_CHROME) return process.env.SWIFF_RELAY_CHROME;
  const full = chromium.executablePath();
  if (existsSync(full)) return full;
  const root = dirname(dirname(dirname(full)));
  const shell = readdirSync(root)
    .filter((name) => name.startsWith("chromium_headless_shell-"))
    .sort()
    .at(-1);
  if (!shell) throw new Error("no Chromium: run npx playwright install chromium-headless-shell");
  return join(root, shell, "chrome-headless-shell-linux64", "chrome-headless-shell");
}

/** A browser whose every process lives in the network of `pid`. */
function browserIn(pid: string, name: string): Promise<Browser> {
  const wrapper = test.info().outputPath(`${name}-chrome`);
  writeFileSync(wrapper, `#!/bin/sh\nexec nsenter -t ${pid} -n -- '${realChrome()}' "$@"\n`, { mode: 0o755 });
  return chromium.launch({
    executablePath: wrapper,
    args: [
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      // Real addresses in the candidates, as playwright.config.ts has it.
      "--disable-features=WebRtcHideLocalIpsWithMdns",
    ],
  });
}

/** The signaling server, with the relay or without. */
async function startServer(relay: boolean): Promise<ChildProcess> {
  const server = spawn(process.execPath, ["server/dist/index.js"], {
    env: {
      ...process.env,
      ...E2E_ENV,
      PORT: String(PORT),
      DATABASE_URL: "",
      ...(relay ? { TURN_URLS: SWIFF_RELAY_TURN_URLS, TURN_SECRET: SWIFF_RELAY_TURN_SECRET } : {}),
    },
    stdio: "ignore",
  });
  // Without DATABASE_URL it first boots an in-memory Postgres: slow on a loaded machine.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`the server exited with code ${server.exitCode}`);
    try {
      if ((await fetch(`${SERVER}/api/ping`)).ok) return server;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  server.kill();
  throw new Error("the signaling server did not start");
}

let server: ChildProcess | undefined;
const browsers: Browser[] = [];

test.afterEach(async () => {
  await Promise.all(browsers.splice(0).map((b) => b.close().catch(() => {})));
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server!.once("exit", r));
    server.kill();
    await exited;
  }
});

/** The PC sharing and the renter connecting, each in its own network, with or without the relay. */
async function connect(relay: boolean): Promise<{ host: Page; renter: Page; errors: () => string[] }> {
  server = await startServer(relay);
  const hostBrowser = await browserIn(HOST_PID!, "host");
  const renterBrowser = await browserIn(RENTER_PID!, "renter");
  browsers.push(hostBrowser, renterBrowser);
  const host = await (await hostBrowser.newContext({ baseURL: ORIGIN })).newPage();
  const renter = await (await renterBrowser.newContext({ baseURL: ORIGIN })).newPage();
  // Read when asked: the pages' errors land in these arrays as they happen.
  const hostErrors = failOnPageError(host, "host");
  const renterErrors = failOnPageError(renter, "renter");
  const errors = () => [...hostErrors, ...renterErrors];

  await fakeScreenCapture(host);
  await startHost(host);
  await expect(host.getByText("Waiting for a renter…")).toBeVisible();
  await renter.goto(joinLink());
  await renter.getByRole("button", { name: "Connect" }).click();
  // Signaling reaches both sides either way: only the media path is missing.
  await expect(host.getByText("A renter is connected.")).toBeVisible();
  return { host, renter, errors };
}

test("without a relay, the renter and the PC cannot connect", async () => {
  const { renter, host } = await connect(false);
  await expect(renter.locator(".status")).toContainText("failed", { timeout: 60_000 });
  await expect(host.locator(".status")).not.toContainText(/\bconnected/);
});

test("with the relay, the stream comes up through it on the seat's own credentials", async () => {
  const { renter, host, errors } = await connect(true);

  await expect(renter.locator(".status")).toContainText(/\bconnected/, { timeout: 60_000 });
  await expect(host.locator(".status")).toContainText(/\bconnected/, { timeout: 30_000 });
  await expect
    .poll(() => renter.getByTestId("stage-video").evaluate((v: HTMLVideoElement) => v.videoWidth), {
      timeout: 30_000,
      message: "renter never received a decoded frame",
    })
    .toBeGreaterThan(0);

  // The pair ICE picked runs through the relay on one end or both: either the
  // renter's own candidate is a relayed one, or the PC's is.
  const sides = () => Promise.all([renter, host].map((page) => page.locator(".status").textContent()));
  await expect.poll(async () => (await sides()).join(" | "), { timeout: 20_000 }).toMatch(/relay/);

  // And the relay let them in on what the server minted for the seat: a
  // credential per side, bound to it, never a shared one. run.sh keeps only
  // the side of each allocation made on such a credential, not the username.
  const allocated = readFileSync(SWIFF_RELAY_TURN_LOG!, "utf8").split("\n");
  for (const side of ["renter", "host"]) expect(allocated).toContain(`allocated ${side}`);
  expect(errors()).toEqual([]);
});
