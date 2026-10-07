// The window asks the Lanterel server for its error-reports project and hands it to main.

import { describe, expect, it, vi } from "vitest";
import { syncErrorProject } from "./errorProject";

const answer = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );

describe("syncErrorProject", () => {
  it("asks the server's /api/error-tracking and hands main its answer, a project or null", async () => {
    const set = vi.fn();
    const ask = vi.fn((_url: string) => answer(200, { key: "phc_x", host: "https://eu.i.posthog.com" }));
    expect(await syncErrorProject("https://lanterel.example", { ask, set })).toBe(true);
    expect(ask).toHaveBeenCalledWith("https://lanterel.example/api/error-tracking");
    expect(set.mock.calls).toEqual([
      ["https://lanterel.example"],
      ["https://lanterel.example", { key: "phc_x", host: "https://eu.i.posthog.com" }],
    ]);

    await syncErrorProject("https://lanterel.example", { ask: () => answer(200, null), set });
    expect(set).toHaveBeenLastCalledWith("https://lanterel.example", null);
  });

  it("tells main which server it asks, but hands no project when that server cannot be reached, fails, or answers something else", async () => {
    const set = vi.fn();
    await syncErrorProject("https://x", { ask: () => Promise.reject(new Error("offline")), set });
    await syncErrorProject("https://x", { ask: () => answer(404, { error: "no such route" }), set });
    await syncErrorProject("https://x", { ask: () => answer(200, "phc_x"), set });
    expect(set.mock.calls).toEqual([["https://x"], ["https://x"], ["https://x"]]);
  });

  it("asks nothing outside Electron, where main cannot take a project", async () => {
    const ask = vi.fn();
    expect(await syncErrorProject("https://x", { ask, set: undefined })).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });
});
