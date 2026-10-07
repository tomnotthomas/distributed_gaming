// Error reports to PostHog's error tracking, from the Lanterel apps that are
// not a web page: Lanterel Host (Electron) and the Lanterel OS services. No
// SDK: each report is one `$exception` event posted to the capture API.
//
// A report says what went wrong and where in the code, and nothing about who:
// its distinct id is made up for the run and never stored, it creates no person
// profile and asks PostHog for no location, and every string in it goes
// through scrub.ts first. Nothing is sent without a project key and host (see
// errorTrackingConfig), or when the machine says DO_NOT_TRACK.

import { scrub, scrubText } from "./scrub.ts";

/** Where reports go: a project's public key and its ingestion host. */
export type ErrorTrackingConfig = { key: string; host: string };

/** Reports sent per run at most; past that a loop of failures only costs the network. */
export const MAX_REPORTS = 50;
/** A report not sent by then is given up. */
export const SEND_TIMEOUT_MS = 5_000;
/** How long a crashing process waits for its report before it exits all the same. */
export const FLUSH_TIMEOUT_MS = 3_000;
const MAX_MESSAGE = 2_000;
const MAX_FRAMES = 50;
/** An error's causes followed, after the error itself. */
const MAX_CAUSES = 4;

type Env = Readonly<Record<string, string | undefined>>;

/** A project's public key, as PostHog makes them: phc_ and letters and digits. */
const PROJECT_KEY = /^phc_\w{1,100}$/;

/** `host` as an https origin on PostHog's own domain, or null for anything else. */
function posthogHost(host: string): string | null {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return null;
  }
  const onPosthog = url.hostname === "posthog.com" || url.hostname.endsWith(".posthog.com");
  const bare =
    !url.username && !url.password && !url.port && url.pathname === "/" && !url.search && !url.hash;
  return url.protocol === "https:" && onPosthog && bare ? url.origin : null;
}

/** Whether the machine asks for no tracking: DO_NOT_TRACK set to anything but 0 or empty. */
export function doNotTrack(env: Env): boolean {
  const value = env.DO_NOT_TRACK?.trim();
  return Boolean(value && value !== "0");
}

/**
 * Where reports go, from the environment, or null when they are off: no key,
 * no host, or DO_NOT_TRACK set to anything but 0 or empty. The OS services read
 * LANTEREL_POSTHOG_KEY and LANTEREL_POSTHOG_HOST; Lanterel Host asks its
 * server for them, or a dev build has VITE_POSTHOG_KEY and VITE_POSTHOG_HOST
 * built in (desktop/src/mainErrors.ts). Lanterel OS reads them
 * from a file Windows can write, so they are taken only as a project key and an
 * https host on posthog.com: anything else means reports are off.
 */
export function errorTrackingConfig(
  env: Env,
  names: { key: string; host: string } = { key: "LANTEREL_POSTHOG_KEY", host: "LANTEREL_POSTHOG_HOST" },
): ErrorTrackingConfig | null {
  if (doNotTrack(env)) return null;
  return projectOf({ key: env[names.key], host: env[names.host] });
}

/**
 * `value` as a project, or null unless it is a PostHog project key and an
 * https origin on posthog.com: no path, port or user, the host's case and
 * trailing slash normalised. The one rule for a project, wherever it comes
 * from: desktop/rental.cjs and server/src/error-tracking.ts keep copies, tested
 * to agree on project-cases.json.
 */
export function projectOf(value: unknown): ErrorTrackingConfig | null {
  if (value === null || typeof value !== "object") return null;
  const { key, host } = value as Record<string, unknown>;
  if (typeof key !== "string" || typeof host !== "string") return null;
  const origin = posthogHost(host.trim());
  return PROJECT_KEY.test(key.trim()) && origin ? { key: key.trim(), host: origin } : null;
}

/** One frame of a stack, as PostHog's error tracking reads it. */
export type Frame = {
  platform: "node:javascript" | "web:javascript";
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
};

export type ExceptionEntry = {
  type: string;
  value: string;
  mechanism: { handled: boolean; synthetic: boolean; type: string };
  stacktrace?: { type: "raw"; frames: Frame[] };
};

/** A V8 stack line: `at fn (file:line:col)`, `at file:line:col`, `at async fn (...)`, `at async file:line:col`. */
const STACK_LINE = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;

/** The frames of a V8 stack, outermost call first, as PostHog wants them. */
export function parseStack(stack: string, platform: Frame["platform"]): Frame[] {
  const frames: Frame[] = [];
  for (const line of stack.split("\n")) {
    const match = STACK_LINE.exec(line);
    if (!match) continue;
    const [, fn, filename = "", lineno, colno] = match;
    frames.push({
      platform,
      filename,
      function: fn || "<anonymous>",
      lineno: Number(lineno),
      colno: Number(colno),
      in_app: !/node_modules|^node:|^internal\/|^electron\/|\(native\)/.test(filename),
    });
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.reverse();
}

/** What a thrown value says about itself, whatever was thrown. */
function described(thrown: unknown): { type: string; value: string; stack: string } {
  if (thrown instanceof Error || (thrown !== null && typeof thrown === "object" && "message" in thrown)) {
    const e = thrown as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      type: typeof e.name === "string" && e.name ? e.name : "Error",
      value: String(e.message ?? ""),
      stack: typeof e.stack === "string" ? e.stack : "",
    };
  }
  return { type: "Error", value: typeof thrown === "string" ? thrown : safeString(thrown), stack: "" };
}

function safeString(value: unknown): string {
  try {
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** The thrown value and its causes, innermost cause first, as `$exception_list`. */
export function exceptionList(
  thrown: unknown,
  opts: { handled: boolean; mechanism: string; platform: Frame["platform"] },
): ExceptionEntry[] {
  const chain: unknown[] = [thrown];
  for (let at = thrown; chain.length <= MAX_CAUSES;) {
    const cause = at !== null && typeof at === "object" ? (at as { cause?: unknown }).cause : undefined;
    if (cause === undefined || chain.includes(cause)) break;
    chain.push(cause);
    at = cause;
  }
  return chain
    .map((link, i) => {
      const { type, value, stack } = described(link);
      const frames = parseStack(stack, opts.platform);
      return {
        type,
        value: value.slice(0, MAX_MESSAGE),
        mechanism: {
          handled: opts.handled,
          synthetic: !(link instanceof Error),
          type: i === 0 ? opts.mechanism : "chained",
        },
        ...(frames.length > 0 && { stacktrace: { type: "raw" as const, frames } }),
      };
    })
    .reverse();
}

export type CaptureOptions = {
  /** False for what nothing caught; true (the default) for an error the code caught and reported. */
  handled?: boolean;
  /** How it was caught: uncaughtException, unhandledrejection, onerror, generic... */
  mechanism?: string;
  /** Where it ran when it is not the tracker's own process, such as Lanterel Host's window. */
  platform?: Frame["platform"];
  /** A few plain words about where it happened. Scrubbed like the rest. */
  properties?: Record<string, string | number | boolean>;
};

export type Tracker = {
  /** Whether reports are sent at all, now. */
  readonly enabled: boolean;
  /** Report `thrown`, in the background; never throws and never rejects. */
  capture(thrown: unknown, opts?: CaptureOptions): void;
  /** Wait for the reports still on their way, but not longer than `timeoutMs`. */
  flush(timeoutMs?: number): Promise<void>;
};

/** Post `body` to `url`; rejects or resolves, the tracker does not mind which. */
export type Send = (url: string, body: string) => Promise<unknown>;

const fetchSend: Send = (url, body) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });

export type TrackerOptions = {
  /**
   * Where reports go, or a function asked at each report, for a program that
   * learns its project after it starts (Lanterel Host asks its server).
   */
  config: ErrorTrackingConfig | null | (() => ErrorTrackingConfig | null);
  /** Which program reports: lanterel-host, swiff-hostd, swiff-streamer, swiff-steam-login. */
  service: string;
  /** Its version, when it has one. */
  release?: string;
  /**
   * Values this program holds that must never be sent, such as its machine key
   * and id. Read at each report, so a program may add to it as it learns them.
   */
  secrets?: readonly string[];
  send?: Send;
  now?: () => Date;
};

/** Random enough to tell one run's reports from another's, and nothing else. */
function runId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createTracker(opts: TrackerOptions): Tracker {
  const { service, release, secrets = [], send = fetchSend, now = () => new Date() } = opts;
  const configOf =
    typeof opts.config === "function" ? opts.config : () => opts.config as ErrorTrackingConfig | null;
  const distinctId = `${service}-run-${runId()}`;
  const pending = new Set<Promise<unknown>>();
  const seen = new Set<string>();
  let sent = 0;

  return {
    get enabled() {
      return configOf() !== null;
    },
    capture(thrown, captureOpts = {}) {
      const config = configOf();
      if (config === null || sent >= MAX_REPORTS) return;
      try {
        const list = scrub(
          exceptionList(thrown, {
            handled: captureOpts.handled ?? true,
            mechanism: captureOpts.mechanism ?? "generic",
            platform: captureOpts.platform ?? "node:javascript",
          }),
          secrets,
        );
        // The same failure over and over is one report.
        const first = list[list.length - 1];
        const fingerprint = `${first?.type}:${first?.value}:${first?.stacktrace?.frames.at(-1)?.filename}`;
        if (seen.has(fingerprint)) return;
        seen.add(fingerprint);
        sent += 1;
        const body = JSON.stringify({
          api_key: config.key,
          event: "$exception",
          distinct_id: distinctId,
          timestamp: now().toISOString(),
          properties: {
            $exception_list: list,
            $exception_level: "error",
            $process_person_profile: false,
            $geoip_disable: true,
            $lib: "lanterel-error-tracking",
            service,
            ...(release && { release: scrubText(release, secrets) }),
            ...scrub(captureOpts.properties ?? {}, secrets),
          },
        });
        const sending = send(`${config.host}/i/v0/e/`, body)
          .catch(() => {})
          .finally(() => pending.delete(sending));
        pending.add(sending);
      } catch {
        // A report that cannot be made is dropped; reporting never adds a failure.
      }
    },
    async flush(timeoutMs = FLUSH_TIMEOUT_MS) {
      if (pending.size === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs))),
      ]);
      clearTimeout(timer);
    },
  };
}

/** The parts of a Node process the tracker listens to and ends. */
export type TrackedProcess = {
  on(event: "uncaughtException", listener: (error: Error) => void): unknown;
  on(event: "uncaughtExceptionMonitor", listener: (error: Error) => void): unknown;
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  exit(code: number): never;
};

/**
 * Report what nothing caught in `proc`. A daemon (`crash: true`, the default)
 * then ends as Node would have, with the error in its log and exit code 1,
 * once the report is sent or FLUSH_TIMEOUT_MS has passed. Electron's main
 * process (`crash: false`) only watches: Electron decides what an uncaught
 * error does there, and main logs an unhandled rejection itself and goes on.
 * It watches even while reports are off, since its project may come later.
 */
export function trackProcess(
  tracker: Tracker,
  proc: TrackedProcess,
  {
    crash = true,
    log = (line: string) => console.error(line),
  }: { crash?: boolean; log?: (line: string) => void } = {},
): void {
  const text = (thrown: unknown) =>
    thrown instanceof Error ? (thrown.stack ?? String(thrown)) : `Uncaught ${safeString(thrown)}`;
  if (!crash) {
    proc.on("uncaughtExceptionMonitor", (error) =>
      tracker.capture(error, { handled: false, mechanism: "uncaughtException" }),
    );
    proc.on("unhandledRejection", (reason) =>
      tracker.capture(reason, { handled: false, mechanism: "unhandledRejection" }),
    );
    return;
  }
  // Off, a daemon keeps Node's own ending: nothing listens.
  if (!tracker.enabled) return;
  const die = (thrown: unknown, mechanism: string) => {
    tracker.capture(thrown, { handled: false, mechanism });
    log(text(thrown));
    void tracker.flush().finally(() => proc.exit(1));
  };
  proc.on("uncaughtException", (error) => die(error, "uncaughtException"));
  proc.on("unhandledRejection", (reason) => die(reason, "unhandledRejection"));
}
