/// <reference types="vite/client" />

// Lanterel Host's error reports to PostHog (packages/error-tracking), for its
// main process and its windows. This file runs in main, not in a window: `npm
// run build` builds it on its own into dist/main-errors.cjs
// (vite.main.config.ts), with the project key and host baked in from
// VITE_POSTHOG_KEY and VITE_POSTHOG_HOST, and main.cjs loads it from there. A
// build without them, or a PC with DO_NOT_TRACK set, sends nothing.
//
//   main          what nothing caught (Electron still decides what that does), and
//                 a window's renderer or a helper process that died
//   the windows   what nothing caught in them, sent by errorReports.ts over
//                 "errors:report" (preload.cjs, tray-preload.cjs)
//
// Every report is scrubbed (packages/error-tracking/src/scrub.ts), and main
// names what it knows must never go: the owner's home folder and user name.

import {
  createTracker,
  errorTrackingConfig,
  trackProcess,
  type ErrorTrackingConfig,
  type Send,
  type TrackedProcess,
  type Tracker,
} from "@swiff/error-tracking";

/** What a window sends about an error of its own; see errorReports.ts. */
export type WindowError = { name: string; message: string; stack: string; mechanism: string };

/** How a process ended, as Electron's render-process-gone and child-process-gone say it. */
type Gone = { reason: string; exitCode: number; type?: string; name?: string };

/** The parts of Electron the reports hook into. */
export type ErrorHooks = {
  app: {
    getVersion(): string;
    on(
      event: "render-process-gone",
      listener: (event: unknown, contents: unknown, details: Gone) => void,
    ): unknown;
    on(event: "child-process-gone", listener: (event: unknown, details: Gone) => void): unknown;
  };
  ipcMain: { on(channel: "errors:report", listener: (event: unknown, report: unknown) => void): unknown };
  proc: TrackedProcess;
  env: Readonly<Record<string, string | undefined>>;
  /** Whether an IPC call came from one of the app's own windows. */
  fromWindow: (event: unknown) => boolean;
  secrets?: readonly string[];
  /** The build's; tests pass their own. */
  config?: ErrorTrackingConfig | null;
  send?: Send;
};

/** A window's report is a few short strings; longer ones are cut. */
const LIMITS = { name: 100, message: 2_000, stack: 16_000, mechanism: 40 } as const;

/** The build's project key and host, or null when it has none or the PC says DO_NOT_TRACK. */
export function builtInConfig(env: ErrorHooks["env"]): ErrorTrackingConfig | null {
  return errorTrackingConfig(
    {
      key: import.meta.env.VITE_POSTHOG_KEY,
      host: import.meta.env.VITE_POSTHOG_HOST,
      DO_NOT_TRACK: env.DO_NOT_TRACK,
    },
    { key: "key", host: "host" },
  );
}

/** A window's report, if it is one, as an Error to send. */
export function windowError(report: unknown): { error: Error; mechanism: string } | null {
  if (report === null || typeof report !== "object") return null;
  const field = (key: keyof WindowError) => {
    const value = (report as Record<string, unknown>)[key];
    return typeof value === "string" ? value.slice(0, LIMITS[key]) : "";
  };
  if (!field("message") && !field("stack")) return null;
  const error = new Error(field("message"));
  error.name = field("name") || "Error";
  error.stack = field("stack");
  return { error, mechanism: field("mechanism") || "onerror" };
}

/** Start reporting Lanterel Host's errors; the tracker, for main's own handled errors. */
export function startErrorTracking(hooks: ErrorHooks): Tracker {
  const { app, ipcMain, proc, env, fromWindow } = hooks;
  const tracker = createTracker({
    config: hooks.config === undefined ? builtInConfig(env) : hooks.config,
    service: "lanterel-host",
    release: app.getVersion(),
    secrets: hooks.secrets ?? [],
    ...(hooks.send && { send: hooks.send }),
  });
  if (!tracker.enabled) return tracker;

  trackProcess(tracker, proc, { crash: false });
  ipcMain.on("errors:report", (event, report) => {
    const sent = fromWindow(event) ? windowError(report) : null;
    if (sent)
      tracker.capture(sent.error, { handled: false, mechanism: sent.mechanism, platform: "web:javascript" });
  });
  const gone = (what: string, details: Gone) => {
    if (details.reason === "clean-exit") return;
    tracker.capture(new Error(`${what} ended: ${details.reason}, exit code ${details.exitCode}`), {
      handled: false,
      mechanism: "process-gone",
      properties: {
        reason: details.reason,
        exit_code: details.exitCode,
        ...(details.type && { process: details.type }),
      },
    });
  };
  app.on("render-process-gone", (_event, _contents, details) => gone("A window's renderer", details));
  app.on("child-process-gone", (_event, details) => gone(`The ${details.type ?? "helper"} process`, details));
  return tracker;
}
