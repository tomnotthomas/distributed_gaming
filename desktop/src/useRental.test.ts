// Rental mode's view-model over a fake preload bridge: a preview that comes
// back after the owner has moved on is dropped, never shown over their choice.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent, RunOutcome } from "../rental-exec.cjs";
import type { RentalPlan } from "../rental.cjs";
import type { HostBridge } from "./bridge";
import { useRental } from "./useRental";

const plan = (kind: RentalPlan["kind"], title: string): RentalPlan =>
  ({ kind, steps: [{ id: title, title, confirm: null, commands: [], ops: [] }] }) as unknown as RentalPlan;

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

  it("follows a run step by step, passes the owner's yes on, and keeps the plan on screen once it ends", async () => {
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    let tell: (event: RunEvent) => void = () => {};
    let finish: (outcome: RunOutcome) => void = () => {};
    host.onRentalEvent = vi.fn((listener) => ((tell = listener), () => {}));
    host.runRental = vi.fn(() => new Promise<RunOutcome>((done) => (finish = done)));
    host.confirmRental = vi.fn(async () => true);
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    act(() => result.current.plan("install"));
    await answer(0, plan("install", "Shrink C:"));
    act(() => result.current.start());
    expect(result.current.run.status).toBe("starting");
    act(() => tell({ type: "step", id: "Shrink C:", state: "confirm" }));
    expect(result.current.run).toMatchObject({ status: "running", waiting: "Shrink C:" });
    // Busy: the owner cannot swap the plan under a run.
    act(() => result.current.plan("uninstall"));
    expect(pending).toHaveLength(1);
    act(() => result.current.confirm(true));
    expect(host.confirmRental).toHaveBeenCalledWith("Shrink C:", true);
    act(() => tell({ type: "step", id: "Shrink C:", state: "running" }));
    act(() => tell({ type: "progress", id: "Shrink C:", what: "Writing", done: 1, total: 2 }));
    expect(result.current.run.progress).toEqual({ id: "Shrink C:", what: "Writing", done: 1, total: 2 });
    act(() => tell({ type: "step", id: "Shrink C:", state: "failed", error: "no room" }));
    await act(async () =>
      finish({
        status: "failed",
        done: [],
        failed: { step: "Shrink C:", op: "shrink", error: "no room" },
        results: [],
      }),
    );
    expect(result.current.run).toMatchObject({
      status: "failed",
      failed: { step: "Shrink C:", error: "no room" },
    });
    expect(result.current.preview?.steps[0]?.title).toBe("Shrink C:");
    expect(host.readRental).toHaveBeenCalledTimes(2);
  });
});
