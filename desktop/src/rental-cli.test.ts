// @vitest-environment node
// The console installer (rental-cli.cjs) answers in JSON lines that end up in
// logs. A plan's one-time key code, which enrols or removes a key at the PC's
// blue screen, is never in them, nor in any file: whoever runs the console
// chooses the code and gives it with --code.

import { describe, expect, it } from "vitest";
import { codeOf, provisioned, provisioningOf, shown, unkeyed } from "../rental-cli.cjs";
import { keyRemovalPlan, mokPlan, switchPlan } from "../rental.cjs";

describe("the console installer's key code", () => {
  it("never puts the key code in a plan's answer", () => {
    for (const plan of [mokPlan("48217730"), keyRemovalPlan("48217730")]) {
      const answer = shown(plan);
      expect(JSON.stringify(answer)).not.toContain("48217730");
      expect(answer).not.toHaveProperty("mok");
    }
    expect(shown(switchPlan("once")).steps.map((s) => s.id)).toEqual(["provision", "once", "restart"]);
  });

  it("hides the key code in a dry run's operations", () => {
    const out = JSON.stringify(unkeyed(mokPlan("48217730").steps.flatMap((s) => s.ops)));
    expect(out).not.toContain("48217730");
    expect(out).toContain('"op":"mok-import"');
    expect(unkeyed([{ op: "restart" }])).toEqual([{ op: "restart" }]);
  });

  it("takes the code from whoever runs it, and refuses a plan that needs one without it", () => {
    expect(codeOf({ code: "48217730" })).toBe("48217730");
    expect(codeOf({})).toBeUndefined();
    expect(() => codeOf({ code: "1234" })).toThrow(/8 digits/);
    expect(() => codeOf({ code: true })).toThrow(/8 digits/);
    expect(() => codeOf({}, mokPlan("48217730"))).toThrow(/--code/);
    expect(codeOf({ code: "48217730" }, mokPlan("48217730"))).toBe("48217730");
    // A dry run changes nothing: it may go without.
    expect(codeOf({ "dry-run": true }, mokPlan("48217730"))).toBeUndefined();
    expect(codeOf({}, switchPlan("once"))).toBeUndefined();
  });
});

describe("the console installer's provisioning", () => {
  const key = { readFileSync: () => "the-machine-key-of-gaming-pc-1\n" };
  const opts = { server: "wss://lanterel.example", "machine-id": "gaming-pc-1", "machine-key-file": "key" };

  it("hands Lanterel OS the server, the machine id and the key from its file, never from the command line", () => {
    expect(provisioningOf(opts, key)).toEqual({
      serverUrl: "wss://lanterel.example",
      machineId: "gaming-pc-1",
      machineKey: "the-machine-key-of-gaming-pc-1",
    });
    expect(() => provisioningOf({ ...opts, "machine-key-file": undefined }, key)).toThrow(
      /--machine-key-file/,
    );
    expect(() => provisioningOf({ ...opts, server: "ws://lanterel.example" }, key)).toThrow(/wss:\/\//);
  });

  it("refuses a plan with a provision step before any step runs, when its flags are missing", () => {
    const steps = switchPlan("once").steps;
    expect(() => provisioned({}, steps, key)).toThrow(/--machine-key-file/);
    expect(() => provisioned({ ...opts, server: "ws://lanterel.example" }, steps, key)).toThrow(/wss:\/\//);
    const missing = {
      readFileSync: () => {
        throw new Error("ENOENT: no such file");
      },
    };
    expect(() => provisioned(opts, steps, missing)).toThrow(/ENOENT/);
    const without = steps.filter((s) => s.id !== "provision");
    expect(() => provisioned({}, without, key)).not.toThrow();
    expect(() => provisioned({ "dry-run": true }, steps, key)).not.toThrow();
  });

  it("hands a provision op its record and leaves the other ops alone", async () => {
    const applied: unknown[] = [];
    const apply = provisioned(
      opts,
      switchPlan("once").steps,
      key,
    )(async (op) => {
      applied.push(op);
    });
    await apply({ op: "provision" });
    await apply({ op: "restart" });
    expect(applied).toEqual([
      {
        op: "provision",
        record: {
          serverUrl: "wss://lanterel.example",
          machineId: "gaming-pc-1",
          machineKey: "the-machine-key-of-gaming-pc-1",
        },
      },
      { op: "restart" },
    ]);
  });

  it("never shows the machine key in a dry run's operations", () => {
    const ops = unkeyed([{ op: "provision", record: provisioningOf(opts, key) }]);
    expect(JSON.stringify(ops)).not.toContain("the-machine-key");
    expect(ops).toEqual([{ op: "provision" }]);
  });
});
