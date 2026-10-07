// A window's uncaught errors and unhandled rejections, sent to main as plain strings.

import { describe, expect, it, vi } from "vitest";
import { reportWindowErrors, windowReport } from "./errorReports";

describe("reportWindowErrors", () => {
  it("sends what nothing caught in the window to main", () => {
    const report = vi.fn();
    const target = new EventTarget();
    reportWindowErrors(target, report);
    const error = new TypeError("gpu is undefined");
    target.dispatchEvent(new ErrorEvent("error", { error, message: error.message }));
    const rejection = new Event("unhandledrejection");
    Object.assign(rejection, { reason: "no answer" });
    target.dispatchEvent(rejection);
    expect(report.mock.calls).toEqual([
      [{ name: "TypeError", message: "gpu is undefined", stack: error.stack, mechanism: "onerror" }],
      [{ name: "Error", message: "no answer", stack: "", mechanism: "onunhandledrejection" }],
    ]);
  });

  it("listens to nothing outside Electron, where no bridge can take a report", () => {
    const target = { addEventListener: vi.fn() };
    reportWindowErrors(target, undefined);
    expect(target.addEventListener).not.toHaveBeenCalled();
  });
});

describe("windowReport", () => {
  it("says what any thrown value is", () => {
    expect(windowReport(42, "onerror")).toEqual({
      name: "Error",
      message: "42",
      stack: "",
      mechanism: "onerror",
    });
  });
});
