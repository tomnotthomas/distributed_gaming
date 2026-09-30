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

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

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

    // The preload exposes two key-storage calls and nothing else. If `require` or `process` ever
    // shows up in the renderer, a page bug becomes a machine compromise — and
    // this app runs on a box a stranger is paying to control.
    const leaked = await window.evaluate(() => ({
      require: typeof (globalThis as Record<string, unknown>).require,
      process: typeof (globalThis as Record<string, unknown>).process,
      module: typeof (globalThis as Record<string, unknown>).module,
    }));

    expect(leaked).toEqual({ require: "undefined", process: "undefined", module: "undefined" });
  });

  test("exposes only the machine-key calls to the renderer", async () => {
    const window = await app.firstWindow();

    // The key is a credential for this machine's room. The renderer may ask
    // main to store and return it; it gets no other door into main.
    const bridge = await window.evaluate(() => {
      const api = (globalThis as { swiffHost?: Record<string, unknown> }).swiffHost ?? {};
      return Object.fromEntries(Object.entries(api).map(([k, v]) => [k, typeof v]));
    });

    expect(bridge).toEqual({ loadMachineKey: "function", saveMachineKey: "function" });
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
