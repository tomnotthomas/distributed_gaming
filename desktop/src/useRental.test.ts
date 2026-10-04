// Rental mode's view-model over a fake preload bridge: a preview that comes
// back after the owner has moved on is dropped, never shown over their choice.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    act(() => result.current.plan("install"));
    await answer(0, plan("install", "Shrink C:"));
    expect(result.current.preview?.steps[0]?.title).toBe("Shrink C:");
  });

  it("drops a plan that comes back after the owner chose another place for Swiff OS", async () => {
    const { result } = renderHook(() => useRental());
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

  it("shows only the latest plan when an earlier one answers last", async () => {
    const { result } = renderHook(() => useRental());
    act(() => result.current.plan("start"));
    act(() => result.current.plan("stop"));
    await answer(1, plan("stop", "Windows first"));
    await answer(0, plan("start", "Swiff OS first"));
    expect(result.current.preview?.kind).toBe("stop");
  });
});
