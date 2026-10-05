import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEased } from "./instruments";

describe("useEased", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never moves away from its target when a frame is stamped before the effect read the clock", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const runFrame = (t: number) => act(() => frames.splice(0).forEach((cb) => cb(t)));

    const { result, rerender } = renderHook(({ target }) => useEased(target), {
      initialProps: { target: 0 },
    });
    rerender({ target: 100 });

    runFrame(990);
    expect(result.current).toBeGreaterThanOrEqual(0);
    runFrame(1_016);
    expect(result.current).toBeGreaterThan(0);
    expect(result.current).toBeLessThan(100);
  });
});
