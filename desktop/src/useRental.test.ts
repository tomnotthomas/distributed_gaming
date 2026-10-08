// Rental mode's view-model over a fake preload bridge: a preview that comes
// back after the owner has moved on is dropped, never shown over their choice;
// a run follows main's events from the one OK to Restart now.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent, RunOutcome } from "../rental-exec.cjs";
import type { RentalPlan, RentalRead } from "../rental.cjs";
import type { HostBridge } from "./bridge";
import type { EkResult } from "./ek";
import { stepBytes, useRental } from "./useRental";

const plan = (kind: RentalPlan["kind"], title: string): RentalPlan =>
  ({ kind, steps: [{ id: title, title, confirm: null, commands: [], ops: [] }] }) as unknown as RentalPlan;

/** An install with a check and a write of three parts, as rental.cjs plans one. */
const writing = {
  kind: "install",
  steps: [
    { id: "check", title: "Check", confirm: null, commands: [], ops: [{ op: "check" }] },
    {
      id: "write",
      title: "Copy Lanterel OS onto them",
      confirm: null,
      commands: [],
      ops: [100, 800, 10].map((bytes) => ({ op: "write", disk: 0, offset: 0, bytes, source: "x" })),
    },
    { id: "mok-restart", title: "Restart", confirm: "Restarts.", commands: [], ops: [{ op: "restart" }] },
  ],
  mok: { code: "48217730" },
} as unknown as RentalPlan;

/** Plans answered by hand, in whatever order a test resolves them. */
let pending: { ask: { kind: RentalPlan["kind"]; target?: string | null }; answer: (p: RentalPlan) => void }[];

beforeEach(() => {
  pending = [];
  (window as { swiffHost?: Partial<HostBridge> }).swiffHost = {
    readRental: vi.fn(async () => null),
    planRental: vi.fn((ask) => new Promise<RentalPlan | null>((answer) => pending.push({ ask, answer }))),
  };
});

afterEach(() => {
  delete (window as { swiffHost?: unknown }).swiffHost;
});

async function answer(i: number, p: RentalPlan) {
  await act(async () => pending[i]!.answer(p));
}

describe("useRental", () => {
  it("shows the plan the owner asked for", async () => {
    const { result } = renderHook(() => useRental());
    await act(async () => {}); // the first read has landed: the screen offers plans only then
    act(() => result.current.plan("install"));
    // Until main answers (it reads the PC again first), the screen knows a plan is coming.
    expect(result.current.planning).toBe(true);
    await answer(0, plan("install", "Shrink C:"));
    expect(result.current.planning).toBe(false);
    expect(result.current.preview?.steps[0]?.title).toBe("Shrink C:");
  });

  it("drops a plan that comes back after the owner chose another place for Lanterel OS", async () => {
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    act(() => result.current.plan("install"));
    act(() => result.current.choose("disk:1"));
    await answer(0, plan("install", "Shrink C:"));
    expect(result.current.target).toBe("disk:1");
    expect(result.current.preview).toBeNull();
  });

  it("drops a plan that comes back after the preview was closed or the PC checked again", async () => {
    const { result } = renderHook(() => useRental());
    act(() => result.current.plan("install"));
    act(() => result.current.close());
    await answer(0, plan("install", "closed"));
    expect(result.current.preview).toBeNull();
    act(() => result.current.plan("install"));
    act(() => result.current.check());
    await answer(1, plan("install", "checked"));
    expect(result.current.preview).toBeNull();
  });

  it("drops a plan asked for while the PC was being read again, once that read lands", async () => {
    let land: (read: null) => void = () => {};
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    host.readRental = vi.fn(() => new Promise<null>((done) => (land = done)));
    act(() => result.current.check());
    act(() => result.current.plan("install"));
    await act(async () => land(null));
    await answer(0, plan("install", "before the read"));
    expect(result.current.preview).toBeNull();
  });

  it("stops getting a plan ready when a read of the PC throws it away, so the stage keeps its action", async () => {
    let land: (read: null) => void = () => {};
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    host.readRental = vi.fn(() => new Promise<null>((done) => (land = done)));
    act(() => result.current.check());
    act(() => result.current.plan("uninstall"));
    expect(result.current.planning).toBe(true);
    await act(async () => land(null));
    expect(result.current.planning).toBe(false);
    await answer(0, plan("uninstall", "late"));
    expect(result.current.planning).toBe(false);
    expect(result.current.preview).toBeNull();
  });

  it("puts away the preview on screen when the owner asks for another plan", async () => {
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    act(() => result.current.plan("uninstall"));
    await answer(0, plan("uninstall", "Remove rental mode"));
    expect(result.current.preview).not.toBeNull();
    act(() => result.current.plan("unkey"));
    // Main dropped the old plan for this ask: its button must not come back while this one is got ready.
    expect(result.current.preview).toBeNull();
    expect(result.current.planning).toBe(true);
  });

  it("stops getting a plan ready when Go live plans afresh over it", async () => {
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    act(() => result.current.plan("uninstall"));
    act(() => result.current.goLive());
    expect(result.current.planning).toBe(false);
    await answer(0, plan("uninstall", "late"));
    expect(result.current.planning).toBe(false);
  });

  it("shows only the latest plan when an earlier one answers last", async () => {
    const { result } = renderHook(() => useRental());
    await act(async () => {}); // the first read has landed: the screen offers plans only then
    act(() => result.current.plan("start"));
    act(() => result.current.plan("stop"));
    await answer(1, plan("stop", "Windows first"));
    await answer(0, plan("start", "Lanterel OS first"));
    expect(result.current.preview?.kind).toBe("stop");
  });

  it("follows a run step by step from the owner's one OK, and keeps the plan on screen once it fails", async () => {
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    let tell: (event: RunEvent) => void = () => {};
    let finish: (outcome: RunOutcome) => void = () => {};
    host.onRentalEvent = vi.fn((listener) => ((tell = listener), () => {}));
    host.runRental = vi.fn(() => new Promise<RunOutcome>((done) => (finish = done)));
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    act(() => result.current.plan("install"));
    await answer(0, writing);
    act(() => result.current.start());
    expect(result.current.run.status).toBe("starting");
    act(() => tell({ type: "step", id: "check", state: "running" }));
    expect(result.current.run).toMatchObject({ status: "running", steps: { check: "running" } });
    expect(result.current.run.stepStartedAt).toEqual(expect.any(Number));
    // Busy: the owner cannot swap the plan under a run.
    act(() => result.current.plan("uninstall"));
    expect(pending).toHaveLength(1);
    act(() => tell({ type: "step", id: "check", state: "done" }));
    act(() => tell({ type: "step", id: "write", state: "running" }));
    // Each of the step's writes counts a third as it is copied, a third as written and a third as read back.
    const ESP = "swiffos_0.1.0.esp.raw";
    const ROOT = "swiffos_0.1.0.root-x86-64.raw";
    act(() => tell({ type: "progress", id: "write", what: `Copying ${ESP}`, done: 100, total: 100 }));
    expect(result.current.run.progress).toEqual({
      id: "write",
      done: 100 / 3,
      total: 910,
      pass: { doing: "copying", name: "Boot", done: 100, total: 100 },
    });
    act(() => tell({ type: "progress", id: "write", what: `Writing ${ESP}`, done: 50, total: 100 }));
    expect(result.current.run.progress?.done).toBe(50);
    act(() => tell({ type: "progress", id: "write", what: `Checking ${ESP}`, done: 100, total: 100 }));
    act(() => tell({ type: "progress", id: "write", what: `Writing ${ROOT}`, done: 400, total: 800 }));
    // The step's own count only moves forward; the pass says what it measures, in its own file's bytes.
    expect(result.current.run.progress).toEqual({
      id: "write",
      done: 500,
      total: 910,
      pass: { doing: "writing", name: "Root", done: 400, total: 800 },
    });
    expect(result.current.run.meter?.done).toBe(500);
    act(() => tell({ type: "step", id: "write", state: "failed", error: "no room" }));
    expect(result.current.run.endedAt).toEqual(expect.any(Number));
    await act(async () =>
      finish({
        status: "failed",
        done: ["check"],
        failed: { step: "write", op: "write", error: "no room" },
        results: [],
      }),
    );
    expect(result.current.run).toMatchObject({
      status: "failed",
      failed: { step: "write", error: "no room" },
    });
    expect(result.current.preview).toBe(writing);
    expect(host.readRental).toHaveBeenCalledTimes(2);
  });

  it("keeps a plan that ran up to its restart on screen, and restarts on Restart now", async () => {
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    host.runRental = vi.fn(async (): Promise<RunOutcome> => ({
      status: "done",
      done: ["check"],
      results: [],
    }));
    host.restartRental = vi.fn(async () => true);
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    act(() => result.current.plan("install"));
    await answer(0, writing);
    await act(async () => result.current.start());
    await act(async () => {});
    expect(result.current.run.status).toBe("done");
    expect(result.current.preview).toBe(writing);
    await act(async () => result.current.restart());
    expect(host.restartRental).toHaveBeenCalledOnce();
    expect(result.current.run.status).toBe("restarting");
  });

  describe("Go live and the TPM's EK", () => {
    const A = { certificate: "QUFB", intermediates: ["SU5U"] };
    const B = { certificate: "QkJC", intermediates: [] };
    const ONCE = {
      kind: "once",
      steps: [
        { id: "ek", title: "Read", confirm: null, commands: [], ops: [{ op: "ek" }] },
        {
          id: "once",
          title: "BootNext",
          confirm: null,
          commands: [],
          ops: [{ op: "boot-next", entry: "swiff" }],
        },
        { id: "restart", title: "Restart", confirm: "Restarts.", commands: [], ops: [{ op: "restart" }] },
      ],
    } as unknown as RentalPlan;

    /**
     * Go live on a PC whose last check read `checked`, where each of the plan's own reads finds the
     * next of `reads` (the last one again after that). Like the worker, the read records what it found
     * and stops the run before BootNext when that is none or not the certificate the plan was asked with.
     * Reads of the PC after a run wait on `held`.
     */
    async function goLive(
      checked: typeof A | null,
      reads: typeof A | null | (typeof A | null)[],
      registerEk: (ek: typeof A) => Promise<EkResult> = async () => ({ ok: true, registered: "now" }),
      held: Promise<void> = Promise.resolve(),
    ) {
      const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
      const order: string[] = [];
      const tpm = Array.isArray(reads) ? [...reads] : [reads];
      let record = checked;
      let asked: string | null | undefined;
      host.readRental = vi.fn(async () => {
        if (order.includes("run")) await held;
        return {
          facts: {
            checked: record ? { ek: true, ...record } : { ek: false, certificate: null, intermediates: [] },
          },
        } as unknown as RentalRead;
      });
      host.planRental = vi.fn(async (ask) => ((asked = ask.registered), ONCE));
      host.runRental = vi.fn(async (): Promise<RunOutcome> => {
        order.push("run");
        const now = tpm.length > 1 ? tpm.shift()! : tpm[0]!;
        record = now;
        const stop = (error: string): RunOutcome => ({
          status: "failed",
          done: [],
          failed: { step: "ek", op: "ek", error },
          results: [],
        });
        if (!now) return stop("The TPM has no endorsement key certificate Windows can read.");
        if (now.certificate !== asked)
          return stop("This PC's TPM certificate isn't registered with Lanterel yet.");
        return {
          status: "done",
          done: ["ek", "once"],
          results: [
            { step: "ek", op: "ek", ek: now },
            { step: "once", op: "boot-next", entry: 1 },
          ],
        };
      });
      host.restartRental = vi.fn(async () => (order.push("restart"), true));
      const register = vi.fn(
        async (ek: typeof A) => (order.push(`register ${ek.certificate}`), registerEk(ek)),
      );
      const { result } = renderHook(() => useRental({ registerEk: register }));
      await act(async () => {});
      await act(async () => result.current.goLive());
      await act(async () => {});
      return { result, order, register, host };
    }

    it("registers the EK the check read before anything is set to start Lanterel OS, and only once", async () => {
      const { order, register, host } = await goLive(A, A);
      expect(order).toEqual(["register QUFB", "run", "restart"]);
      expect(register).toHaveBeenCalledWith(A);
      // The plan's read holds the run to the EK registered.
      expect(host.planRental).toHaveBeenCalledWith({ kind: "once", registered: "QUFB" });
    });

    it("registers a new TPM's EK before BootNext: the plan's read stops, then Go live goes again", async () => {
      const changed = await goLive(A, B);
      expect(changed.order).toEqual(["register QUFB", "run", "register QkJC", "run", "restart"]);
      expect(changed.register).toHaveBeenLastCalledWith(B);
      expect(changed.host.planRental).toHaveBeenLastCalledWith({ kind: "once", registered: "QkJC" });
      // A record from before the certificate was kept: the plan's read is the one registered.
      const unknown = await goLive(null, A);
      expect(unknown.order).toEqual(["run", "register QUFB", "run", "restart"]);
      expect(unknown.host.planRental).toHaveBeenNthCalledWith(1, { kind: "once", registered: null });
    });

    it("keeps Go live running, with no restart offered, while the plan's read registers", async () => {
      let answer: (r: EkResult) => void = () => {};
      const pending = goLive(null, A, () => new Promise<EkResult>((resolve) => (answer = resolve)));
      const { result, order } = await pending;
      expect(order).toEqual(["run", "register QUFB"]);
      expect(result.current.run.status).toBe("running");
      await act(async () => answer({ ok: false, error: "unavailable" }));
      // Refused: nothing ran past the read, so the PC still starts Windows.
      expect(order).toEqual(["run", "register QUFB"]);
      expect(result.current.run).toMatchObject({
        status: "failed",
        failed: { step: "ek", error: "unavailable" },
      });
    });

    it("keeps Go live running, with no failure shown, while it reads what the plan's read recorded", async () => {
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      const { result, order } = await goLive(null, null, undefined, held);
      expect(order).toEqual(["run"]);
      expect(result.current.run).toMatchObject({ status: "running", failed: null, endedAt: null });
      await act(async () => release());
      // None read: the run's own failure is back, with its guidance.
      expect(order).toEqual(["run"]);
      expect(result.current.run).toMatchObject({
        status: "failed",
        failed: { step: "ek", error: expect.stringMatching(/no endorsement key certificate/) },
      });
      expect(result.current.run.endedAt).not.toBeNull();
    });

    it("goes again only once: a TPM that reads another certificate again stops there", async () => {
      const { order, result } = await goLive(A, [B, A]);
      expect(order).toEqual(["register QUFB", "run", "register QkJC", "run"]);
      expect(result.current.run).toMatchObject({ status: "failed", failed: { step: "ek" } });
    });

    it("stops before the restart, saying why, when there is no certificate or the server refused it", async () => {
      const none = await goLive(null, null);
      expect(none.order).toEqual(["run"]);
      expect(none.result.current.run).toMatchObject({
        status: "failed",
        failed: { step: "ek", error: expect.stringMatching(/no endorsement key certificate/) },
      });

      const refused = await goLive(A, A, async () => ({ ok: false, error: "bad-key" }));
      // Nothing ran: BootNext is not set for a PC the server would not let host.
      expect(refused.order).toEqual(["register QUFB"]);
      expect(refused.result.current.run).toMatchObject({
        status: "failed",
        failed: { step: "ek", error: "bad-key" },
      });
      expect(refused.result.current.preview).toBe(ONCE);
      // Try again goes through the EK again, not straight to the plan.
      await act(async () => refused.result.current.retry());
      await act(async () => {});
      expect(refused.order).toEqual(["register QUFB", "register QUFB"]);
    });
  });

  it("says so when Windows did not restart", async () => {
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    host.restartRental = vi.fn(async () => false);
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    await act(async () => result.current.restart());
    expect(result.current.run).toMatchObject({ status: "failed", failed: { step: "restart" } });
  });

  it("drops a finished removal once the PC is read again", async () => {
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    host.runRental = vi.fn(async (): Promise<RunOutcome> => ({
      status: "done",
      done: ["forget"],
      results: [],
    }));
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    act(() => result.current.plan("uninstall"));
    await answer(0, plan("uninstall", "forget"));
    await act(async () => result.current.start());
    await act(async () => {});
    expect(result.current.preview).toBeNull();
  });

  it("asks Windows again with the same plan after a declined prompt, and plans afresh after a failed step", async () => {
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    host.runRental = vi.fn(async (): Promise<RunOutcome> => ({
      status: "failed",
      done: [],
      failed: { step: "elevate", op: "elevate", error: "no" },
      results: [],
    }));
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    act(() => result.current.plan("install"));
    await answer(0, writing);
    await act(async () => result.current.start());
    await act(async () => result.current.retry());
    expect(host.runRental).toHaveBeenCalledTimes(2);
    expect(pending).toHaveLength(1);
    host.runRental = vi.fn(async (): Promise<RunOutcome> => ({
      status: "failed",
      done: [],
      failed: { step: "write", op: "write", error: "io" },
      results: [],
    }));
    // Allowed this time, and a step fails: trying again plans afresh, from where the PC is now.
    await act(async () => result.current.retry());
    expect(result.current.run.failed?.step).toBe("write");
    await act(async () => result.current.retry());
    expect(pending).toHaveLength(2);
    expect(pending[1]!.ask.kind).toBe("install");
    await answer(1, writing);
    expect(host.runRental).toHaveBeenCalledTimes(2);
  });

  it("plans afresh, not asks again, after a run main rejected or no longer has a plan for", async () => {
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    for (const [n, runRental] of [
      () => Promise.reject(new Error("The installer stopped.")),
      async () => null,
    ].entries()) {
      host.runRental = vi.fn(runRental) as HostBridge["runRental"];
      const { result, unmount } = renderHook(() => useRental());
      await act(async () => {});
      act(() => result.current.plan("install"));
      await answer(2 * n, writing);
      await act(async () => result.current.start());
      expect(result.current.run).toMatchObject({ status: "failed", failed: { step: "run" } });
      await act(async () => result.current.retry());
      expect(host.runRental).toHaveBeenCalledTimes(1);
      expect(pending).toHaveLength(2 * n + 2);
      expect(pending[2 * n + 1]!.ask.kind).toBe("install");
      unmount();
    }
  });

  it("sends the failed step, its error and this PC's checks, and remembers when", async () => {
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    host.runRental = vi.fn(async (): Promise<RunOutcome> => ({
      status: "failed",
      done: [],
      failed: { step: "write", op: "write", error: "io" },
      results: [],
    }));
    host.reportRental = vi.fn(async () => 1234);
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    act(() => result.current.plan("install"));
    await answer(0, writing);
    await act(async () => result.current.start());
    await act(async () => result.current.report());
    expect(host.reportRental).toHaveBeenCalledWith({ step: "write", error: "io", checks: [] });
    expect(result.current.run.reportedAt).toBe(1234);
  });

  it("passes the owner's word on the blue screen on, then reads the PC again", async () => {
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    host.answerRentalKey = vi.fn(async () => true);
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    await act(async () => result.current.answer(false));
    expect(host.answerRentalKey).toHaveBeenCalledWith(false);
    expect(host.readRental).toHaveBeenCalledTimes(2);
  });

  it("passes the BitLocker recovery key's confirmation on with no key in it, then reads the PC again", async () => {
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    host.saveRecoveryKey = vi.fn(async () => true);
    host.openBitLocker = vi.fn(async () => false);
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    await act(async () => result.current.saveRecovery());
    expect(host.saveRecoveryKey).toHaveBeenCalledWith();
    expect(host.readRental).toHaveBeenCalledTimes(2);
    expect(result.current.bitlockerPage).toBeNull();
    await act(async () => result.current.openBitLocker());
    expect(result.current.bitlockerPage).toBe("failed");
  });

  it("asks for Remove Lanterel OS with or without its key, and goes on with the part that stopped", async () => {
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    host.seenRemoval = vi.fn(async () => true);
    host.runRental = vi.fn(async (): Promise<RunOutcome> => ({
      status: "failed",
      done: [],
      failed: { step: "partitions", op: "gpt-remove", error: "io" },
      results: [],
    }));
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    act(() => result.current.plan("remove", { key: false }));
    expect(pending[0]!.ask).toEqual({ kind: "remove", target: null, key: false });
    await answer(0, { ...plan("remove", "partitions"), phase: "disk" });
    await act(async () => result.current.start());
    act(() => result.current.retry());
    expect(pending[1]!.ask).toEqual({ kind: "remove", target: null, key: false });
    act(() => result.current.plan("remove"));
    expect(pending[2]!.ask).toEqual({ kind: "remove", target: null });
    await act(async () => result.current.seenRemoval());
    expect(host.seenRemoval).toHaveBeenCalledOnce();
  });

  it("goes on with Remove Lanterel OS by itself once its key's restart is behind it, and only once", async () => {
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    host.readRental = vi.fn(async () => ({ removal: { state: "finish" } }) as never);
    host.runRental = vi.fn(async (): Promise<RunOutcome> => ({
      status: "failed",
      done: [],
      failed: { step: "elevate", op: "elevate", error: "declined" },
      results: [],
    }));
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    expect(pending).toHaveLength(1);
    expect(pending[0]!.ask).toEqual({ kind: "remove", target: null, key: false });
    await answer(0, { ...plan("remove", "partitions"), phase: "disk" });
    expect(host.runRental).toHaveBeenCalledOnce();
    expect(result.current.run.status).toBe("failed");
    // Declined at Windows' prompt: the failed screen's Try again asks again, nothing asks by itself.
    await act(async () => {});
    expect(pending).toHaveLength(1);
    expect(host.runRental).toHaveBeenCalledOnce();
    // The blue screen didn't take the code: the key's removal is what gets planned, not the disk's.
    act(() => result.current.plan("remove", { key: true }));
    await act(async () => {});
    expect(pending.map((p) => p.ask)).toEqual([
      { kind: "remove", target: null, key: false },
      { kind: "remove", target: null, key: true },
    ]);
    await answer(1, { ...plan("remove", "mok-remove"), phase: "key" });
    expect(result.current.preview).toMatchObject({ phase: "key" });
    // Back, or Check again: the screen offers the rest, nothing runs it by itself again.
    act(() => result.current.close());
    act(() => result.current.check());
    await act(async () => {});
    expect(pending).toHaveLength(2);
    expect(host.runRental).toHaveBeenCalledOnce();
    expect(result.current.removalTried).toBe(true);
    // Try again: the disk's part, planned and run at once.
    act(() => result.current.finishRemoval());
    expect(pending[2]!.ask).toEqual({ kind: "remove", target: null, key: false });
    await answer(2, { ...plan("remove", "partitions"), phase: "disk" });
    expect(host.runRental).toHaveBeenCalledTimes(2);
  });

  it("waits with Remove Lanterel OS's disk part until the BitLocker recovery key is saved, then goes on once", async () => {
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    let saved = false;
    host.readRental = vi.fn(
      async () => ({ removal: { state: "finish" }, recovery: { drives: ["C", "D"], saved } }) as never,
    );
    host.saveRecoveryKey = vi.fn(async () => (saved = true));
    host.runRental = vi.fn(async (): Promise<RunOutcome> => ({
      status: "done",
      done: ["partitions"],
      results: [],
    }));
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    expect(pending).toHaveLength(0);
    expect(result.current.removalTried).toBe(false);
    await act(async () => result.current.saveRecovery());
    expect(pending.map((p) => p.ask)).toEqual([{ kind: "remove", target: null, key: false }]);
    await answer(0, { ...plan("remove", "partitions"), phase: "disk" });
    expect(host.runRental).toHaveBeenCalledOnce();
  });

  it("goes live by starting Lanterel OS once, then restarts by itself", async () => {
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    host.runRental = vi.fn(async (): Promise<RunOutcome> => ({
      status: "done",
      done: ["ek", "once"],
      results: [{ step: "ek", op: "ek", ek: { certificate: "QUFB", intermediates: [] } }],
    }));
    host.restartRental = vi.fn(async () => true);
    const { result } = renderHook(() =>
      useRental({ registerEk: async () => ({ ok: true, registered: "already" }) }),
    );
    await act(async () => {});
    act(() => result.current.goLive());
    expect(pending[0]!.ask.kind).toBe("once");
    const once = plan("once", "once");
    once.steps.push({
      id: "restart",
      title: "Restart",
      confirm: "Restarts.",
      commands: [],
      ops: [{ op: "restart" }],
    });
    await answer(0, once);
    await act(async () => {});
    expect(host.runRental).toHaveBeenCalledOnce();
    expect(host.restartRental).toHaveBeenCalledOnce();
  });

  it("takes up a download main already runs when it opens, and follows it to its end", async () => {
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    let progress: Parameters<HostBridge["onImageProgress"]>[0] | null = null;
    host.onImageProgress = vi.fn((listener) => {
      progress = listener;
      return () => {};
    });
    type Outcome = Awaited<ReturnType<HostBridge["downloadImage"]>>;
    let finish!: (outcome: Outcome) => void;
    host.downloadImage = vi.fn(() => new Promise<Outcome>((resolve) => (finish = resolve)));
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    expect(result.current.download).toEqual({ status: "idle" });
    act(() => progress!({ phase: "download", done: 300, total: 1000 }));
    expect(result.current.download).toMatchObject({
      status: "running",
      phase: "download",
      done: 300,
      total: 1000,
    });
    act(() => progress!({ phase: "download", done: 600, total: 1000 }));
    expect(result.current.download).toMatchObject({ status: "running", done: 600 });
    // It waits on the one download main runs, and starts no other.
    act(() => result.current.downloadImage());
    expect(host.downloadImage).toHaveBeenCalledOnce();
    const reads = vi.mocked(host.readRental!).mock.calls.length;
    await act(async () => finish({ ok: false, error: "No room.", retry: true }));
    expect(result.current.download).toEqual({ status: "failed", error: "No room.", retry: true });
    expect(host.readRental).toHaveBeenCalledTimes(reads + 1);
  });

  it("remembers which live run the owner has seen summed up", async () => {
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    host.readRental = vi.fn(
      async () => ({ lastLive: { from: 1, to: 77, sessions: 1, early: 0, earned: null } }) as never,
    );
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    act(() => result.current.seenLive());
    expect(result.current.liveSeen).toBe(77);
    expect(localStorage.getItem("swiff.rental.liveSeen")).toBe("77");
    localStorage.clear();
  });
});

describe("stepBytes", () => {
  it("counts each write a third as copied, a third as written and a third as read back, in the plan's order", () => {
    const at = (what: string, done: number, total: number) => stepBytes([90, 810, 9], { what, done, total });
    expect(at("Copying swiffos_0.1.0.esp.raw", 90, 90)).toEqual({
      done: 30,
      total: 909,
      pass: { doing: "copying", name: "Boot", done: 90, total: 90 },
    });
    expect(at("Writing swiffos_0.1.0.esp.raw", 90, 90)?.done).toBe(60);
    expect(at("Checking swiffos_0.1.0.root-x86-64.raw", 0, 810)).toEqual({
      done: 630,
      total: 909,
      pass: { doing: "checking", name: "Root", done: 0, total: 810 },
    });
    expect(at("Checking swiffos_0.1.0.root-x86-64-verity.raw", 9, 9)).toEqual({
      done: 909,
      total: 909,
      pass: { doing: "checking", name: "Verity", done: 9, total: 9 },
    });
  });

  it("only moves forward through one write's copy, write and read-back", () => {
    const events = ["Copying", "Writing", "Checking"].flatMap((pass) =>
      [0, 400, 810].map((done) => ({ what: `${pass} b`, done, total: 810 })),
    );
    const seen = events.map((e) => stepBytes([90, 810, 9], e)!.done);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[0]).toBe(90);
    expect(seen.at(-1)).toBe(900);
  });

  it("measures nothing it cannot place", () => {
    expect(stepBytes([100], { what: "Checking files", done: 1, total: 7 })).toBeNull();
    expect(stepBytes([], { what: "Writing a", done: 1, total: 1 })).toBeNull();
    expect(stepBytes([100], { what: "Reading a", done: 1, total: 100 })).toBeNull();
  });
});
