// @vitest-environment node
// Sharing the owner's Windows desktop is a development path only: rental mode,
// with Swiff OS, is the only way to host. Main registers no screen-capture
// handler in the packaged app, and the production bundle has no capture call.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { windowsShareAllowed } from "../share-gate.cjs";
import { WINDOWS_SHARE } from "./devShare";

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe("sharing this Windows desktop", () => {
  it("is allowed only to an unpackaged development run that asks for it", () => {
    expect(windowsShareAllowed({ isPackaged: false, env: { SWIFF_DEV_WINDOWS_SHARE: "1" } })).toBe(true);
    expect(windowsShareAllowed({ isPackaged: true, env: { SWIFF_DEV_WINDOWS_SHARE: "1" } })).toBe(false);
    expect(windowsShareAllowed({ isPackaged: false, env: {} })).toBe(false);
    expect(windowsShareAllowed({ isPackaged: false, env: { SWIFF_DEV_WINDOWS_SHARE: "true" } })).toBe(false);
  });

  it("is off in the renderer unless a development build sets its flag", () => {
    expect(WINDOWS_SHARE).toBe(false);
  });

  it("has main register the screen-capture handler only behind the gate", () => {
    const main = readFileSync(path.join(DESKTOP, "main.cjs"), "utf8");
    const calls = main.split("setDisplayMediaRequestHandler(").length - 1;
    expect(calls).toBe(1);
    expect(main).toMatch(
      /if \(windowsShareAllowed\(\{ isPackaged: app\.isPackaged, env: process\.env \}\)\)\s+session\.defaultSession\.setDisplayMediaRequestHandler\(/,
    );
  });

  it("is not in the production build hosts download", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "swiff-desktop-build-"));
    // As `npm run pack` builds it: vitest's NODE_ENV=test would keep the build's DEV on.
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await build({
        root: DESKTOP,
        configFile: path.join(DESKTOP, "vite.config.ts"),
        mode: "production",
        logLevel: "silent",
        build: { outDir, emptyOutDir: true },
      });
      const files = readdirSync(outDir, { recursive: true, encoding: "utf8" }).filter((f) =>
        /\.(js|html)$/.test(f),
      );
      const bundle = files.map((f) => readFileSync(path.join(outDir, f), "utf8")).join("\n");
      // The app itself is there: the build did not come out empty.
      expect(bundle).toContain("Rental mode");
      expect(bundle).not.toContain("getDisplayMedia");
    } finally {
      process.env.NODE_ENV = nodeEnv;
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 180_000);
});
