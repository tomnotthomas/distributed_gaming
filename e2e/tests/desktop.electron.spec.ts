// End-to-end tests for the Swiff Host desktop app.
//
// The app exists for exactly one reason: Chrome makes a human click "Share this
// screen", and a rented gaming PC has nobody sitting at it. Electron's
// setDisplayMediaRequestHandler answers that prompt in code. So the test that
// matters here is not "a window opened" — it is "getDisplayMedia resolved to a
// live track with nobody touching the machine". If that ever regresses, Swiff
// silently needs a human again and the whole product stops working.
//
// The desktop app lands on a separate branch. Until it does, this file skips
// rather than failing, so CI on main stays honest instead of permanently red.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { E2E_GRACE_MS, E2E_MACHINE_KEY, E2E_ROOM, renterCookie } from "./credentials";

const REPO_ROOT = resolve(__dirname, "..", "..");
// SWIFF_DESKTOP_DIR lets this run against a desktop app built somewhere else —
// a release artifact, or the feature branch it is still being written on.
const DESKTOP_DIR = process.env.SWIFF_DESKTOP_DIR
  ? resolve(process.env.SWIFF_DESKTOP_DIR)
  : resolve(REPO_ROOT, "desktop");
const DESKTOP_MAIN = resolve(DESKTOP_DIR, "main.cjs");
const DESKTOP_BUNDLE = resolve(DESKTOP_DIR, "dist", "index.html");

test.describe("Swiff Host desktop app", () => {
  test.skip(
    !existsSync(DESKTOP_MAIN),
    "desktop/ is not on this branch yet — the Electron host app lands separately",
  );

  // Electron is a real app launch: slower than a page load, and on CI it comes
  // up under a virtual display.
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  let app: ElectronApplication;

  test.beforeAll(async () => {
    expect(
      existsSync(DESKTOP_BUNDLE),
      `desktop renderer is not built — run \`npm run build -w @swiff/desktop\` (looked for ${DESKTOP_BUNDLE})`,
    ).toBe(true);

    app = await electron.launch({
      args: [DESKTOP_DIR],
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: "test" },
    });
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("opens exactly one window and renders the host UI", async () => {
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    expect(app.windows()).toHaveLength(1);
    // Whatever the page is titled, it must actually have rendered React into
    // the root — a blank window is the classic broken-file:// symptom.
    await expect(window.locator("#root")).not.toBeEmpty();
  });

  test("captures the screen with nobody there to approve it", async () => {
    const window = await app.firstWindow();

    // No click, no picker, no human. This is the product.
    const capture = await window.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const [track] = stream.getVideoTracks();
        const result = {
          ok: true as const,
          trackCount: stream.getVideoTracks().length,
          readyState: track?.readyState,
          settings: track?.getSettings() ?? {},
        };
        stream.getTracks().forEach((t) => t.stop());
        return result;
      } catch (cause) {
        return { ok: false as const, error: String(cause) };
      }
    });

    expect(capture.ok, `getDisplayMedia rejected: ${"error" in capture ? capture.error : ""}`).toBe(true);
    if (!capture.ok) return;

    expect(capture.trackCount).toBe(1);
    expect(capture.readyState).toBe("live");
    // A real screen, not a 0x0 placeholder.
    expect(capture.settings.width ?? 0).toBeGreaterThan(0);
    expect(capture.settings.height ?? 0).toBeGreaterThan(0);
  });

  test("hands back a screen source rather than a window or tab", async () => {
    // The handler asks desktopCapturer for `types: ["screen"]`. Reading it back
    // from the main process keeps that contract pinned even if the renderer
    // stops caring which source it got.
    // Annotated by hand: electron's types are a dependency of desktop/, which
    // main does not have, so this file must typecheck without them.
    const sources: { id: string; name: string }[] = await app.evaluate(async ({ desktopCapturer }) => {
      const found = await desktopCapturer.getSources({ types: ["screen"] });
      return found.map((source: { id: string; name: string }) => ({
        id: source.id,
        name: source.name,
      }));
    });

    expect(sources.length, "no screen sources — the host has nothing to share").toBeGreaterThan(0);
    expect(sources[0].id).toMatch(/^screen:/);
  });

  test("does not leak node into the renderer", async () => {
    const window = await app.firstWindow();

    // The preload exposes a few narrow calls and nothing else. If `require` or `process` ever
    // shows up in the renderer, a page bug becomes a machine compromise — and
    // this app runs on a box a stranger is paying to control.
    const leaked = await window.evaluate(() => ({
      require: typeof (globalThis as Record<string, unknown>).require,
      process: typeof (globalThis as Record<string, unknown>).process,
      module: typeof (globalThis as Record<string, unknown>).module,
    }));

    expect(leaked).toEqual({ require: "undefined", process: "undefined", module: "undefined" });
  });

  test("exposes only its narrow calls to the renderer", async () => {
    const window = await app.firstWindow();

    // The key is a credential for this machine's room: the renderer may ask
    // main to store and return it. Besides that it may read what the PC is,
    // hear its installed games change, and how long since its keyboard was
    // used, send the tray glance its snapshot and hear the glance's actions,
    // and run a renter's session: start this app's own streamer with a
    // session key, tell it what next, and stop it. No other door into main.
    const bridge = await window.evaluate(() => {
      const api = (globalThis as { swiffHost?: Record<string, unknown> }).swiffHost ?? {};
      return Object.fromEntries(Object.entries(api).map(([k, v]) => [k, typeof v]));
    });

    expect(bridge).toEqual({
      loadMachineKey: "function",
      saveMachineKey: "function",
      readPc: "function",
      onGamesChanged: "function",
      secondsSinceInput: "function",
      setGlance: "function",
      onTrayAction: "function",
      sessionLogon: "function",
      sessionLaunch: "function",
      sessionSend: "function",
      sessionEnd: "function",
      onSessionEvent: "function",
    });
  });

  test("gives the tray glance only its two calls, and no screen", async () => {
    // A window on the tray glance's preload, as main opens it from the tray
    // icon (an OS tray cannot be clicked from here).
    const opened = app.waitForEvent("window");
    const id = await app.evaluate(
      ({ BrowserWindow }, files) => {
        const glance = new BrowserWindow({ show: false, webPreferences: { preload: files.preload } });
        void glance.loadFile(files.index, { query: { view: "tray" } });
        return glance.id;
      },
      { preload: resolve(DESKTOP_DIR, "tray-preload.cjs"), index: DESKTOP_BUNDLE },
    );
    const glance = await opened;
    await glance.waitForLoadState("domcontentloaded");

    const exposed = await glance.evaluate(() => {
      const g = globalThis as { swiffTray?: Record<string, unknown>; swiffHost?: unknown };
      return {
        tray: Object.fromEntries(Object.entries(g.swiffTray ?? {}).map(([k, v]) => [k, typeof v])),
        host: typeof g.swiffHost,
      };
    });
    expect(exposed).toEqual({ tray: { onGlance: "function", trayAction: "function" }, host: "undefined" });

    // Only the app window may share the screen.
    const capture = await glance.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        stream.getTracks().forEach((t) => t.stop());
        return "captured";
      } catch {
        return "refused";
      }
    });
    expect(capture).toBe("refused");

    await app.evaluate(({ BrowserWindow }, windowId) => BrowserWindow.fromId(windowId)?.destroy(), id);
    await expect.poll(() => app.windows().length).toBe(1);
  });

  test("reads this PC's parts", async () => {
    const window = await app.firstWindow();
    await window
      .getByRole("navigation")
      .getByRole("button", { name: /This PC/ })
      .click();

    const main = window.getByRole("main");
    await expect(main.getByRole("heading", { name: "Reading this PC" })).toBeVisible();
    // Memory and the processor are read on every OS; the card needs a GPU process.
    await expect(main.locator(".krow", { hasText: "Memory" })).toHaveText(/Memory\s*\d+ GB/);
    await expect(main.locator(".krow", { hasText: "CPU" })).not.toContainText("Not found");
    await expect(main.locator(".dc b")).toHaveText(/^[1-4] of 4$/);
    // This PC's own screens carry no demo data and no rate the platform does not set.
    await expect(window.getByText("Demo data")).toHaveCount(0);
    await expect(main).not.toContainText("€");
  });

  test("goes live from the connection settings, then pauses and resumes", async ({ baseURL }, testInfo) => {
    const window = await app.firstWindow();
    // Going live holds the room with the machine key; nothing is captured until
    // a player's session starts its streamer (the next describe).
    await window.getByRole("button", { name: "Settings" }).click();
    await expect(window.getByRole("heading", { name: "Connection" })).toBeVisible();

    await window.getByLabel("Signaling server").fill(baseURL!);
    await window.getByLabel("Machine id").fill(E2E_ROOM);
    await window.getByLabel("Machine key").fill(E2E_MACHINE_KEY);
    await window.getByRole("button", { name: "Save and start sharing" }).click();

    // The real server confirms the room: the app is live and waiting.
    await expect(window.getByRole("heading", { name: "Waiting for a player" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(window.getByText(`${E2E_ROOM} is connected to Swiff.`, { exact: false })).toBeVisible();
    await testInfo.attach("live, waiting", { body: await window.screenshot(), contentType: "image/png" });

    await window.getByRole("button", { name: "Pause sharing" }).click();
    await expect(window.getByRole("heading", { name: "Paused" })).toBeVisible();
    await expect(window.getByText(/^Sharing paused at \d\d:\d\d$/)).toBeVisible();

    await window.getByRole("button", { name: "Resume sharing" }).click();
    await expect(window.getByRole("heading", { name: "Waiting for a player" })).toBeVisible({
      timeout: 30_000,
    });
    await window.getByRole("button", { name: "Pause sharing" }).click();
  });

  test("stays up with no uncaught errors in the renderer", async () => {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("pageerror", (err) => errors.push(err.message));

    await window.waitForTimeout(1500);

    expect(errors).toEqual([]);
    expect(app.windows()).toHaveLength(1);
  });
});

// The design's screens the platform cannot fill yet, on the app's labelled demo
// data (--demo). The held press to go live is real; the data behind it is not.
test.describe("Swiff Host desktop app, demo data", () => {
  test.skip(!existsSync(DESKTOP_MAIN), "desktop/ is not on this branch");
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  let app: ElectronApplication;

  test.beforeAll(async () => {
    app = await electron.launch({
      args: [DESKTOP_DIR, "--demo"],
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: "test" },
    });
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("goes live on a held press, and not on a short one", async () => {
    const window = await app.firstWindow();
    await window.locator(".demo-pick select").selectOption("golive");
    const reticle = window.getByRole("button", { name: "Hold to go live" });
    const box = (await reticle.boundingBox())!;
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    // Let go early: it drains, and nothing starts.
    await window.mouse.down();
    await window.waitForTimeout(400);
    await window.mouse.up();
    await expect(reticle).toHaveAttribute("data-phase", "idle");
    await window.waitForTimeout(600);
    await expect(window.getByRole("heading", { name: "Ready to share" })).toBeVisible();

    // Hold it all the way.
    await window.mouse.down();
    await expect(window.getByRole("heading", { name: "Waiting for a player" })).toBeVisible({
      timeout: 5_000,
    });
    await window.mouse.up();
  });

  test("shows every screen of the design, labelled as demo data", async ({}, testInfo) => {
    const window = await app.firstWindow();
    const picker = window.locator(".demo-pick select");
    const screens = await picker
      .locator("option")
      .evaluateAll((options) =>
        options.map((o) => ({ id: (o as HTMLOptionElement).value, name: o.textContent ?? "" })),
      );
    expect(screens).toHaveLength(13);

    for (const { id, name } of screens) {
      await picker.selectOption(id);
      await expect(window.getByText("Demo data")).toBeVisible();
      // Let the art and fonts land before the picture is taken.
      await window.waitForTimeout(700);
      await testInfo.attach(name, { body: await window.screenshot(), contentType: "image/png" });
    }
  });
});

/** A PC that can play Counter-Strike 2: the host report of docs/system-design/host.md. */
const REPORT = {
  hardware: {
    gpu: "NVIDIA GeForce RTX 4070",
    vramMb: 12_288,
    ramMb: 32_768,
    cpu: "AMD Ryzen 7 7800X3D",
    cores: 8,
    encoders: ["h264"],
    display: { width: 1920, height: 1080, refreshHz: 60 },
  },
  games: [730],
};

// A player's whole session, with the streamer started here rather than in a
// renter's Windows account (no session service is installed): the same
// handoff the service runs, minus the logon. The streamer streams a test
// pattern, and the game "launch" is written to a file instead of Steam.
test.describe("Swiff Host desktop app, a player's session", () => {
  test.skip(!existsSync(DESKTOP_MAIN), "desktop/ is not on this branch");
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  let app: ElectronApplication;
  let launches: string;

  test.beforeAll(async () => {
    // A Steam library with Counter-Strike 2 installed, where the app looks for
    // one: under HOME off Windows, under Program Files (x86) on it.
    const root = mkdtempSync(join(tmpdir(), "swiff-e2e-"));
    const steam = process.platform === "win32" ? join(root, "Steam") : join(root, ".steam", "steam");
    mkdirSync(join(steam, "steamapps"), { recursive: true });
    writeFileSync(join(steam, "steamapps", "libraryfolders.vdf"), '"libraryfolders"\n{\n}\n');
    writeFileSync(
      join(steam, "steamapps", "appmanifest_730.acf"),
      '"AppState"\n{\n\t"appid"\t\t"730"\n\t"name"\t\t"Counter-Strike 2"\n\t"StateFlags"\t\t"4"\n}\n',
    );
    launches = join(root, "launches.txt");
    app = await electron.launch({
      args: [DESKTOP_DIR],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "test",
        HOME: root,
        "ProgramFiles(x86)": root,
        SWIFF_STREAMER_TEST_PATTERN: "1",
        SWIFF_GAME_LAUNCH_LOG: launches,
      },
    });
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("serves a claim: key, streamer, first frame, game, grace, and the PC back", async ({ baseURL }) => {
    const window = await app.firstWindow();
    const api = async (method: string, path: string, body?: unknown, auth?: string) => {
      const res = await fetch(`${baseURL}${path}`, {
        method,
        headers: {
          cookie: renterCookie(),
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };

    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByLabel("Signaling server").fill(baseURL!);
    await window.getByLabel("Machine id").fill(E2E_ROOM);
    await window.getByLabel("Machine key").fill(E2E_MACHINE_KEY);
    await window.getByRole("button", { name: "Save and start sharing" }).click();
    await expect(window.getByRole("heading", { name: "Waiting for a player" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(window.getByText(`${E2E_ROOM} is connected to Swiff.`, { exact: false })).toBeVisible();

    // The app offered the PC as it reads it; a runner's hardware cannot all be
    // read, so the full report goes in as well, for the matcher to pick it.
    expect(
      (
        await api(
          "PUT",
          `/api/machines/${E2E_ROOM}/availability`,
          { available: true, ...REPORT },
          E2E_MACHINE_KEY,
        )
      ).status,
    ).toBe(200);

    // A renter books Counter-Strike 2 and claims this PC.
    const booking = await api("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    expect(booking.status).toBe(200);
    await expect
      .poll(async () => (await api("GET", `/api/bookings/${booking.body.bookingId}`)).body.status)
      .toBe("matched");
    const claim = await api("POST", `/api/bookings/${booking.body.bookingId}/claim`);
    expect(claim.status).toBe(200);
    const { sessionId, ticket } = claim.body as { sessionId: string; ticket: string };

    // Pushed to the app, which starts the host session and the streamer with its key.
    await expect(window.getByText("Waiting for the player to join")).toBeVisible({ timeout: 30_000 });

    // The renter joins with their ticket.
    const opened = app.waitForEvent("window");
    await app.evaluate(({ BrowserWindow }, url) => {
      void new BrowserWindow({ show: false }).loadURL(url);
    }, `${baseURL}/rtc#ticket=${ticket}`);
    const renter: Page = await opened;
    await renter.getByRole("button", { name: "Connect" }).click();
    await expect(renter.locator(".status")).toContainText("connected", { timeout: 30_000 });

    // The first frame starts the session and launches the game.
    await expect(window.getByText("Counter-Strike 2 started: a player is streaming")).toBeVisible({
      timeout: 30_000,
    });
    expect(readFileSync(launches, "utf8")).toBe("steam://rungameid/730\n");
    expect((await api("GET", `/api/bookings/${booking.body.bookingId}`)).body.status).toBe("playing");

    // The renter drops: the player has the grace to come back, and does not.
    await app.evaluate(
      ({ BrowserWindow }, id) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().includes(id))
          ?.destroy(),
      "/rtc",
    );
    await expect(window.getByText(/The player dropped and has \d:\d\d to come back/)).toBeVisible({
      timeout: 15_000,
    });

    // The server ends the session when the grace runs out; the PC is the owner's again.
    await expect(window.getByRole("heading", { name: "Waiting for a player" })).toBeVisible({
      timeout: E2E_GRACE_MS + 30_000,
    });
    expect((await api("GET", `/api/bookings/${booking.body.bookingId}`)).body.status).toBe("ended");
    // Its keys are dead: the session cannot be started again.
    expect(
      (await api("POST", `/api/machines/${E2E_ROOM}/session`, { sessionId }, E2E_MACHINE_KEY)).status,
    ).toBe(409);

    await window.getByRole("button", { name: "Pause sharing" }).click();
  });
});
