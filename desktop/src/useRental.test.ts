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
    await answer(0, plan("install", "Shrink C:"));
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
    // Each of the step's writes counts half as it is written and half as it is read back.
    act(() => tell({ type: "progress", id: "write", what: "Writing esp", done: 50, total: 100 }));
    expect(result.current.run.progress).toEqual({ id: "write", done: 25, total: 910 });
    act(() => tell({ type: "progress", id: "write", what: "Checking esp", done: 100, total: 100 }));
    act(() => tell({ type: "progress", id: "write", what: "Writing root", done: 400, total: 800 }));
    expect(result.current.run.progress).toEqual({ id: "write", done: 300, total: 910 });
    expect(result.current.run.meter?.done).toBe(300);
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
  it("counts each write half as written and half as read back, in the plan's order", () => {
    expect(stepBytes([100, 800, 10], { what: "Writing a", done: 100, total: 100 })).toEqual({
      done: 50,
      total: 910,
    });
    expect(stepBytes([100, 800, 10], { what: "Checking b", done: 0, total: 800 })).toEqual({
      done: 500,
      total: 910,
    });
    expect(stepBytes([100, 800, 10], { what: "Checking c", done: 10, total: 10 })).toEqual({
      done: 910,
      total: 910,
    });
  });

  it("measures nothing it cannot place", () => {
    expect(stepBytes([100], { what: "Checking files", done: 1, total: 7 })).toBeNull();
    expect(stepBytes([], { what: "Writing a", done: 1, total: 1 })).toBeNull();
  });
});
