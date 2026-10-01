// The host report contract: what passes, what is dropped and what is refused.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_GAMES, parseHostReport, ReportError } from "../profile.js";
import { REPORT } from "./report.js";

/** The full report with one field of one section replaced. */
const withField = (section: "hardware" | "net", field: string, value: unknown) => ({
  ...REPORT,
  [section]: { ...REPORT[section], [field]: value },
});

describe("parseHostReport", () => {
  it("accepts the full report as host.md describes it", () => {
    assert.deepEqual(parseHostReport(REPORT), REPORT);
  });

  it("leaves out every section the body does not carry, and ignores other fields", () => {
    assert.deepEqual(parseHostReport({ available: true, price: 120 }), {});
    assert.deepEqual(parseHostReport({ games: [730] }), { games: [730] });
  });

  it("drops repeats and trims names", () => {
    const report = parseHostReport({
      name: "  Nova-01 ",
      games: [730, 570, 730],
      controls: ["kb", "kb", "pad"],
      hardware: { ...REPORT.hardware, encoders: ["hevc", "hevc"] },
    });
    assert.equal(report.name, "Nova-01");
    assert.deepEqual(report.games, [730, 570]);
    assert.deepEqual(report.controls, ["kb", "pad"]);
    assert.deepEqual(report.hardware?.encoders, ["hevc"]);
  });

  it("rounds VRAM and RAM to the nearest whole GB", () => {
    const report = parseHostReport({
      hardware: { ...REPORT.hardware, vramMb: 8028, ramMb: 16311 },
    });
    assert.equal(report.hardware?.vramMb, 8192);
    assert.equal(report.hardware?.ramMb, 16384);
  });

  it("accepts an empty games list: nothing installed", () => {
    assert.deepEqual(parseHostReport({ games: [] }), { games: [] });
  });

  const bad: [string, unknown][] = [
    ["empty name", { name: "  " }],
    ["long name", { name: "x".repeat(65) }],
    ["hardware not an object", { hardware: [] }],
    ["missing gpu", { hardware: { ...REPORT.hardware, gpu: undefined } }],
    ["fractional VRAM", withField("hardware", "vramMb", 8.5)],
    ["negative RAM", withField("hardware", "ramMb", -1)],
    ["no cores", withField("hardware", "cores", 0)],
    ["unknown encoder", withField("hardware", "encoders", ["vp9"])],
    ["missing display", withField("hardware", "display", undefined)],
    ["zero refresh rate", withField("hardware", "display", { width: 1920, height: 1080, refreshHz: 0 })],
    ["games not a list", { games: 730 }],
    ["appid zero", { games: [0] }],
    ["appid as text", { games: ["730"] }],
    ["too many games", { games: Array.from({ length: MAX_GAMES + 1 }, (_, i) => i + 1) }],
    ["unknown control", { controls: ["wheel"] }],
    ["net missing a field", { net: { rttMs: 10, jitterMs: 1 } }],
    ["negative rtt", withField("net", "rttMs", -5)],
    ["infinite upload", withField("net", "upMbps", Infinity)],
  ];
  for (const [what, body] of bad) {
    it(`refuses ${what}`, () => {
      assert.throws(() => parseHostReport(body as Record<string, unknown>), ReportError);
    });
  }

  it("names the field in its error, never the value sent", () => {
    assert.throws(
      () => parseHostReport({ name: "secret-looking-value-".repeat(4) }),
      (error: Error) => error.message.startsWith("name ") && !error.message.includes("secret"),
    );
  });
});
