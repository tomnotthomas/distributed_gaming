// @vitest-environment node
// The console installer (rental-cli.cjs) answers in JSON lines that end up in
// logs: a plan's one-time key code, which enrols or removes a key at the PC's
// blue screen, is never in them, only in the file its owner asked for.

import { describe, expect, it } from "vitest";
import { shown, unkeyed } from "../rental-cli.cjs";
import { keyRemovalPlan, mokPlan, switchPlan } from "../rental.cjs";

describe("what the console installer shows", () => {
  it("never puts the key code in a plan's answer, and writes it only to the code file", () => {
    const written: [string, string, unknown][] = [];
    const files = {
      writeFileSync: (file: string, data: string, opts: unknown) => void written.push([file, data, opts]),
    };
    for (const plan of [mokPlan("48217730"), keyRemovalPlan("48217730")]) {
      written.length = 0;
      const answer = shown(plan, "C:\\swiff\\code.txt", files as never);
      expect(JSON.stringify(answer)).not.toContain("48217730");
      expect(answer.mok).toEqual({ codeFile: "C:\\swiff\\code.txt" });
      expect(written).toEqual([["C:\\swiff\\code.txt", "48217730", { mode: 0o600 }]]);
    }
    // No code file asked for: the code is nowhere.
    written.length = 0;
    expect(JSON.stringify(shown(mokPlan("48217730"), null, files as never))).not.toContain("48217730");
    expect(written).toEqual([]);
    expect(shown(switchPlan("once"), "C:\\x", files as never)).not.toHaveProperty("mok");
  });

  it("hides the key code in a dry run's operations", () => {
    const ops = mokPlan("48217730").steps.flatMap((s) => s.ops);
    const out = JSON.stringify(unkeyed(ops));
    expect(out).not.toContain("48217730");
    expect(out).toContain('"op":"mok-import"');
    expect(unkeyed([{ op: "restart" }])).toEqual([{ op: "restart" }]);
  });
});
