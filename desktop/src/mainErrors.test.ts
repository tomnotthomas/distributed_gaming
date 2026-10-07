// @vitest-environment node
// Lanterel Host's error reports from main: the window's reports over IPC, the
// processes that died, and what nothing caught, all scrubbed before they go.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { builtInConfig, startErrorTracking, windowError } from "./mainErrors";

const CONFIG = { key: "phc_test", host: "https://eu.i.posthog.com" };
const APP_WINDOW = { sender: "app" };

/** Main's hooks, faked: the reports land in `bodies`, parsed. */
function main(config: typeof CONFIG | null = CONFIG) {
  const app = Object.assign(new EventEmitter(), { getVersion: () => "0.1.0" });
  const ipcMain = new EventEmitter();
  const proc = Object.assign(new EventEmitter(), { exit: () => undefined as never });
  const bodies: Record<string, any>[] = [];
  const tracker = startErrorTracking({
    app,
    ipcMain,
    proc,
    env: {},
    fromWindow: (event) => event === APP_WINDOW,
    secrets: ["C:\\Users\\Tom Smith", "Tom Smith"],
    config,
    send: async (_url, body) => void bodies.push(JSON.parse(body)),
  });
  const sent = async () => {
    await tracker.flush();
    return bodies.map((b) => ({ ...b.properties, exception: b.properties.$exception_list.at(-1) }));
  };
  return { app, ipcMain, proc, sent };
}

describe("startErrorTracking", () => {
  it("reports a window's uncaught error as the window's, scrubbed of the owner's name", async () => {
    const { ipcMain, sent } = main();
    ipcMain.emit("errors:report", APP_WINDOW, {
      name: "TypeError",
      message: "x is undefined, in C:\\Users\\Tom Smith\\Documents",
      stack:
        "TypeError: x is undefined\n    at render (file:///C:/Users/Tom Smith/AppData/Local/Programs/Lanterel Host/resources/app.asar/dist/assets/index-BNLUw91s.js:1:2)",
      mechanism: "onerror",
    });
    const [report] = await sent();
    expect(report).toMatchObject({ service: "lanterel-host", release: "0.1.0" });
    expect(report?.exception).toMatchObject({
      type: "TypeError",
      value: "x is undefined, in <redacted>\\Documents",
      mechanism: { handled: false, type: "onerror" },
      stacktrace: { frames: [{ platform: "web:javascript", function: "render", lineno: 1, colno: 2 }] },
    });
    expect(JSON.stringify(report)).not.toContain("Tom");
  });

  it("ignores reports from anything but the app's own windows, and ones that are not reports", async () => {
    const { ipcMain, sent } = main();
    ipcMain.emit("errors:report", { sender: "elsewhere" }, { message: "from a stranger" });
    ipcMain.emit("errors:report", APP_WINDOW, "not a report");
    ipcMain.emit("errors:report", APP_WINDOW, { name: "Error" });
    expect(await sent()).toEqual([]);
  });

  it("reports a renderer or helper process that died, but not one that exited cleanly", async () => {
    const { app, sent } = main();
    app.emit("render-process-gone", {}, {}, { reason: "crashed", exitCode: -1073741819 });
    app.emit("child-process-gone", {}, { type: "GPU", reason: "oom", exitCode: 1 });
    app.emit("child-process-gone", {}, { type: "Utility", reason: "clean-exit", exitCode: 0 });
    const reports = await sent();
    expect(reports.map((r) => [r.exception.value, r.reason, r.process])).toEqual([
      ["A window's renderer ended: crashed, exit code -1073741819", "crashed", undefined],
      ["The GPU process ended: oom, exit code 1", "oom", "GPU"],
    ]);
  });

  it("watches main for what nothing caught, without taking it over from Electron", async () => {
    const { proc, sent } = main();
    expect(proc.listenerCount("uncaughtException")).toBe(0);
    proc.emit("uncaughtExceptionMonitor", new Error("main broke"));
    expect((await sent())[0]?.exception).toMatchObject({
      value: "main broke",
      mechanism: { handled: false },
    });
  });

  it("hooks into nothing when the build has no project key", () => {
    const { app, ipcMain, proc } = main(null);
    expect([app.eventNames(), ipcMain.eventNames(), proc.eventNames()]).toEqual([[], [], []]);
  });
});

describe("windowError", () => {
  it("keeps a report's strings, cut to length, and gives what it lacks a default", () => {
    const sent = windowError({ message: "m".repeat(5_000), stack: 42, mechanism: "" });
    expect(sent?.error.message).toHaveLength(2_000);
    expect(sent?.error.name).toBe("Error");
    expect(sent?.error.stack).toBe("");
    expect(sent?.mechanism).toBe("onerror");
  });
});

describe("builtInConfig", () => {
  it("is off in a build without a project key, and on a PC with DO_NOT_TRACK", () => {
    expect(builtInConfig({})).toBeNull();
    expect(builtInConfig({ DO_NOT_TRACK: "1" })).toBeNull();
  });
});
