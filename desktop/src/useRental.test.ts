// Rental mode's view-model over a fake preload bridge: a preview that comes
// back after the owner has moved on is dropped, never shown over their choice;
// a run follows main's events from the one OK to Restart now.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent, RunOutcome } from "../rental-exec.cjs";
import type { RentalPlan } from "../rental.cjs";
import type { HostBridge } from "./bridge";
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
      title: "Copy Swiff OS onto them",
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

  it("drops a plan that comes back after the owner chose another place for Swiff OS", async () => {
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
    await answer(0, plan("start", "Swiff OS first"));
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

  it("asks for Remove Swiff OS with or without its key, and goes on with the part that stopped", async () => {
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

  it("goes live by starting Swiff OS once, then restarts by itself", async () => {
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    host.runRental = vi.fn(async (): Promise<RunOutcome> => ({
      status: "done",
      done: ["once"],
      results: [],
    }));
    host.restartRental = vi.fn(async () => true);
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    act(() => result.current.goLive());
    expect(pending[0]!.ask.kind).toBe("once");
    await answer(0, plan("once", "once"));
    await act(async () => {});
    expect(host.runRental).toHaveBeenCalledOnce();
    expect(host.restartRental).toHaveBeenCalledOnce();
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
