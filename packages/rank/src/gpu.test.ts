import { describe, expect, it } from "vitest";
import { gpuScore, normalizeGpu } from "./gpu.ts";
import table from "./gpu-scores.json" with { type: "json" };

describe("gpuScore", () => {
  it("anchors on the RTX 3060 and the plan's worked example", () => {
    expect(gpuScore("RTX 3060")).toBe(100);
    expect(gpuScore("RTX 4070 Ti")).toBe(310);
    expect(gpuScore("RX 7900 XTX")).toBe(390);
    expect(gpuScore("RTX 4090")).toBe(510);
  });

  it("reads a GPU name the way a driver reports it", () => {
    expect(gpuScore("NVIDIA GeForce RTX 4090")).toBe(510);
    expect(gpuScore("AMD Radeon RX 7900 XTX")).toBe(390);
    expect(gpuScore("  rtx   4070 ti ")).toBe(310);
  });

  it("scores a Ryzen's own Radeon by the model the host app names it, above the lowest game minimum", () => {
    expect(gpuScore("AMD Radeon 680M")).toBe(35);
    expect(gpuScore("AMD Radeon 680M")).toBeGreaterThanOrEqual(gpuScore("GTX 1050"));
    // Windows' own name for it says only who made it.
    expect(gpuScore("AMD Radeon(TM) Graphics")).toBe(0);
  });

  it("keeps variants apart rather than matching a prefix", () => {
    expect(gpuScore("RTX 4070 Ti Super")).toBe(330);
    expect(gpuScore("RTX 4070")).toBe(230);
  });

  it("scores an unknown or laptop GPU 0 rather than guessing", () => {
    expect(gpuScore("Voodoo 3")).toBe(0);
    expect(gpuScore("NVIDIA GeForce RTX 4090 Laptop GPU")).toBe(0);
  });

  it("has one row per normalized name", () => {
    const names = Object.keys(table).map(normalizeGpu);
    expect(new Set(names).size).toBe(names.length);
  });
});
