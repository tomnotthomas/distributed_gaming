// What nothing caught in a Lanterel Host window, to main, which reports it to
// PostHog when the build has a project key (mainErrors.ts). Only the error's
// name, message and stack go; main scrubs them before they leave the PC.

import { bridge, trayBridge } from "./bridge";
import type { WindowError } from "./mainErrors";

type Report = (report: WindowError) => void;

/** `thrown`, as a window's report. */
export function windowReport(thrown: unknown, mechanism: string): WindowError {
  if (thrown instanceof Error) {
    return { name: thrown.name, message: thrown.message, stack: thrown.stack ?? "", mechanism };
  }
  return {
    name: "Error",
    message: typeof thrown === "string" ? thrown : String(thrown),
    stack: "",
    mechanism,
  };
}

/**
 * Send this window's uncaught errors and unhandled rejections to main. Does
 * nothing outside Electron (vite in a browser, a test), where there is no main.
 */
export function reportWindowErrors(
  target: Pick<Window, "addEventListener"> = window,
  report: Report | undefined = (bridge() ?? trayBridge())?.reportError,
): void {
  if (!report) return;
  target.addEventListener("error", (event) => {
    report(windowReport(event.error ?? event.message, "onerror"));
  });
  target.addEventListener("unhandledrejection", (event) => {
    report(windowReport(event.reason, "onunhandledrejection"));
  });
}
