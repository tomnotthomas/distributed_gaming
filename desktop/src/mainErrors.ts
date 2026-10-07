/// <reference types="vite/client" />

// Lanterel Host's error reports to PostHog (packages/error-tracking), for its
// main process and its windows. This file runs in main, not in a window: `npm
// run build` builds it on its own into dist/main-errors.cjs
// (vite.main.config.ts), and main.cjs loads it from there.
//
// The project it reports to is the Lanterel server's: the window asks it at
// GET /api/error-tracking once the owner has set the server (errorProject.ts)
// and hands it to main ("errors:project"), which keeps it for the next start
// and writes it onto Lanterel OS's ESP at install (rental.cjs). The project is
// kept with the server that named it: when the owner sets another server, main
// forgets it at once, before that server answers, and an answer still on its
// way from the server before is dropped. So reports never go to the project
// of a server the PC no longer uses, however the asking ends. A build with
// VITE_POSTHOG_KEY and VITE_POSTHOG_HOST set uses those instead, for a dev
// build pointed at its own project. A PC with DO_NOT_TRACK set sends nothing,
// keeps nothing and gives Lanterel OS nothing.
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
  doNotTrack,
  errorTrackingConfig,
  projectOf,
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
  ipcMain: {
    on(
      channel: "errors:report" | "errors:project",
      listener: (event: unknown, value: unknown) => void,
    ): unknown;
  };
  proc: TrackedProcess;
  env: Readonly<Record<string, string | undefined>>;
  /** Whether an IPC call came from one of the app's own windows. */
  fromWindow: (event: unknown) => boolean;
  secrets?: readonly string[];
  /** The build's override; tests pass their own. */
  config?: ErrorTrackingConfig | null;
  /** Where the server and its project are kept between starts (a file in the app's data). */
  store?: { read(): unknown; write(kept: Kept): void };
  send?: Send;
};

/** The server the window last named (an http(s) origin), and the project it named, if any yet. */
export type Kept = { origin: string; project: ErrorTrackingConfig | null };

/** `value` as an http(s) origin, or null. */
function originOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** What the store holds, if it is a server and a project (or none) as main keeps them. */
function keptOf(value: unknown): Kept | null {
  if (value === null || typeof value !== "object") return null;
  const { origin, project } = value as Record<string, unknown>;
  const at = originOf(origin);
  if (at === null) return null;
  return { origin: at, project: project === null ? null : projectOf(project) };
}

/** What startErrorTracking started: the tracker, and the project it reports to now. */
export type ErrorTracking = { tracker: Tracker; project: () => ErrorTrackingConfig | null };

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

/** Start reporting Lanterel Host's errors: the tracker, for main's own, and the project it reports to. */
export function startErrorTracking(hooks: ErrorHooks): ErrorTracking {
  const { app, ipcMain, proc, env, fromWindow, store } = hooks;
  const off = doNotTrack(env);
  const built = hooks.config === undefined ? builtInConfig(env) : hooks.config;
  let kept: Kept | null = off ? null : keptOf(readSafely(store));
  const project = () => (off ? null : (built ?? kept?.project ?? null));
  const tracker = createTracker({
    config: project,
    service: "lanterel-host",
    release: app.getVersion(),
    secrets: hooks.secrets ?? [],
    ...(hooks.send && { send: hooks.send }),
  });
  if (off) return { tracker, project };

  // The window's word: { origin } as it starts asking a server, then { origin, project }
  // with that server's answer, a project or null when it has none.
  const keep = (next: Kept) => {
    if (kept && next.origin === kept.origin && sameProject(next.project, kept.project)) return;
    kept = next;
    try {
      store?.write(next);
    } catch {
      // Kept for this run only; the window asks again next start.
    }
  };
  ipcMain.on("errors:project", (event, value) => {
    if (!fromWindow(event) || value === null || typeof value !== "object") return;
    const { origin, project: answer } = value as Record<string, unknown>;
    const at = originOf(origin);
    if (at === null) return;
    // Another server: what the one before named is forgotten now, whatever comes next.
    if (answer === undefined) {
      if (kept?.origin !== at) keep({ origin: at, project: null });
      return;
    }
    // An answer from a server the window has since left is too late to count.
    if (kept?.origin !== at) return;
    const next = answer === null ? null : projectOf(answer);
    if (next === null && answer !== null) return;
    keep({ origin: at, project: next });
  });
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
  return { tracker, project };
}

function sameProject(a: ErrorTrackingConfig | null, b: ErrorTrackingConfig | null): boolean {
  return a?.key === b?.key && a?.host === b?.host;
}

function readSafely(store: ErrorHooks["store"]): unknown {
  try {
    return store?.read() ?? null;
  } catch {
    return null;
  }
}
