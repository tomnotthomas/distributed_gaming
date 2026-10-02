// @vitest-environment node
// The tray icon is drawn in code; if drawing it throws, there is no tray, and
// closing the window while live would end sharing instead of hiding it.

import { describe, expect, it } from "vitest";
import { TRAY_ICON_SIZE, trayIconPixels } from "../tray-icon.cjs";

describe("trayIconPixels", () => {
  it("draws a ring with a dot: opaque black in the middle, clear in the corner", () => {
    const pixels = trayIconPixels();
    expect(pixels.length).toBe(TRAY_ICON_SIZE * TRAY_ICON_SIZE * 4);
    const at = (x: number, y: number) => [
      ...pixels.subarray((y * TRAY_ICON_SIZE + x) * 4, (y * TRAY_ICON_SIZE + x) * 4 + 4),
    ];
    expect(at(16, 16)).toEqual([0, 0, 0, 255]);
    expect(at(0, 0)).toEqual([0, 0, 0, 0]);
  });
});
