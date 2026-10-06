// Rental mode's view-model over a fake preload bridge: a preview that comes
// back after the owner has moved on is dropped, never shown over their choice.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NvidiaError } from "../nvidia.cjs";
import type { RentalPlan } from "../rental.cjs";
import type { HostBridge } from "./bridge";
import { useRental } from "./useRental";

const plan = (kind: RentalPlan["kind"], title: string): RentalPlan =>
  ({ kind, dryRun: true, steps: [{ id: title, title, commands: [], ops: [] }] }) as unknown as RentalPlan;

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

  it("installs NVIDIA's driver with what the owner accepted, shows its progress, then reads the PC again", async () => {
    let progress: (p: { done: number; total: number }) => void = () => {};
    let finish!: (r: { ok: true } | { ok: false; error: NvidiaError }) => void;
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    host.onNvidiaProgress = vi.fn((listener) => ((progress = listener), () => {}));
    host.installNvidia = vi.fn(
      () => new Promise<{ ok: true } | { ok: false; error: NvidiaError }>((done) => (finish = done)),
    );
    host.cancelNvidia = vi.fn(async () => {});
    const { result } = renderHook(() => useRental());
    await act(async () => {});
    act(() => result.current.installNvidia({ licence: true, terms: true }));
    expect(host.installNvidia).toHaveBeenCalledWith({ licence: true, terms: true });
    act(() => progress({ done: 10, total: 40 }));
    expect(result.current.nvidia.install).toEqual({ state: "running", done: 10, total: 40, stopping: false });
    act(() => result.current.cancelNvidia());
    expect(result.current.nvidia.install).toMatchObject({ state: "running", stopping: true });
    expect(host.cancelNvidia).toHaveBeenCalledOnce();
    const reads = (host.readRental as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => finish({ ok: false, error: "offline" }));
    expect(result.current.nvidia.install).toEqual({ state: "failed", error: "offline" });
    expect((host.readRental as ReturnType<typeof vi.fn>).mock.calls.length).toBe(reads + 1);
  });

  it("loads NVIDIA's licence, and says why when it cannot", async () => {
    const host = (window as { swiffHost?: Partial<HostBridge> }).swiffHost!;
    host.nvidiaLicence = vi.fn(async () => ({ ok: true as const, text: "NVIDIA Driver License Agreement" }));
    const { result } = renderHook(() => useRental());
    await act(async () => result.current.readNvidiaLicence());
    expect(result.current.nvidia.licence).toEqual({
      state: "ready",
      text: "NVIDIA Driver License Agreement",
    });
    host.nvidiaLicence = vi.fn(async () => ({ ok: false as const, error: "changed" as const }));
    await act(async () => result.current.readNvidiaLicence());
    expect(result.current.nvidia.licence).toEqual({ state: "failed", error: "changed" });
  });
});
