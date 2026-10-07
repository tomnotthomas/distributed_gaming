import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createTracker,
  errorTrackingConfig,
  exceptionList,
  MAX_REPORTS,
  parseStack,
  projectOf,
  trackProcess,
  type TrackedProcess,
} from "./tracker.ts";

const CONFIG = { key: "phc_test", host: "https://eu.i.posthog.com" };

/** A tracker whose reports land in `bodies`, parsed. */
function recorded(opts: { secrets?: string[]; send?: (url: string, body: string) => Promise<unknown> } = {}) {
  const urls: string[] = [];
  const bodies: Record<string, any>[] = [];
  const tracker = createTracker({
    config: CONFIG,
    service: "swiff-hostd",
    release: "0.1.0",
    secrets: opts.secrets ?? [],
    now: () => new Date("2026-10-07T12:00:00Z"),
    send:
      opts.send ??
      (async (url, body) => {
        urls.push(url);
        bodies.push(JSON.parse(body));
      }),
  });
  return { tracker, urls, bodies };
}

describe("projectOf", () => {
  it("takes a PostHog project key and an https origin on posthog.com, normalised, and nothing else", () => {
    expect(projectOf({ key: "phc_abc", host: "https://EU.i.posthog.com/", extra: 1 })).toEqual({
      key: "phc_abc",
      host: "https://eu.i.posthog.com",
    });
    for (const bad of [
      null,
      "phc_abc",
      { key: "phc_abc" },
      { key: "phx_personal", host: "https://eu.i.posthog.com" },
      { key: "phc_abc", host: "http://eu.i.posthog.com" },
      { key: "phc_abc", host: "https://eu.i.posthog.com.evil.example" },
      { key: "phc_abc\nLANTEREL_X=1", host: "https://eu.i.posthog.com" },
    ])
      expect(projectOf(bad)).toBeNull();
  });
});

describe("projectOf's table of cases, which the server's and rental.cjs's copies run too", () => {
  const cases = JSON.parse(readFileSync(new URL("./project-cases.json", import.meta.url), "utf8")) as {
    what: string;
    key: string;
    host: string;
    origin: string | null;
  }[];
  it.each(cases)("$what", ({ key, host, origin }) => {
    expect(projectOf({ key, host })).toEqual(origin === null ? null : { key, host: origin });
  });
});

describe("errorTrackingConfig", () => {
  it("reads the key and https host, and trims the host's trailing slash", () => {
    expect(
      errorTrackingConfig({
        LANTEREL_POSTHOG_KEY: " phc_x ",
        LANTEREL_POSTHOG_HOST: "https://eu.i.posthog.com/",
      }),
    ).toEqual({ key: "phc_x", host: "https://eu.i.posthog.com" });
  });

  it("is off without a key or host, with a host that is not https, or with DO_NOT_TRACK", () => {
    const on = { LANTEREL_POSTHOG_KEY: "phc_x", LANTEREL_POSTHOG_HOST: "https://eu.i.posthog.com" };
    expect(errorTrackingConfig({ LANTEREL_POSTHOG_KEY: "phc_x" })).toBeNull();
    expect(errorTrackingConfig({ LANTEREL_POSTHOG_HOST: on.LANTEREL_POSTHOG_HOST })).toBeNull();
    expect(errorTrackingConfig({ ...on, LANTEREL_POSTHOG_HOST: "http://eu.i.posthog.com" })).toBeNull();
    expect(errorTrackingConfig({ ...on, DO_NOT_TRACK: "1" })).toBeNull();
    expect(errorTrackingConfig({ ...on, DO_NOT_TRACK: "0" })).not.toBeNull();
  });

  it.each([
    ["a key that is not a project key", { LANTEREL_POSTHOG_KEY: "phx_personal" }],
    ["a key with more than letters and digits", { LANTEREL_POSTHOG_KEY: "phc_x\nNODE_OPTIONS=y" }],
    ["a host off posthog.com", { LANTEREL_POSTHOG_HOST: "https://evil.example" }],
    ["a host that only ends in posthog.com", { LANTEREL_POSTHOG_HOST: "https://notposthog.com" }],
    ["a host with a path", { LANTEREL_POSTHOG_HOST: "https://eu.i.posthog.com/x" }],
    ["a host with a port", { LANTEREL_POSTHOG_HOST: "https://eu.i.posthog.com:8443" }],
    ["a host with a user", { LANTEREL_POSTHOG_HOST: "https://a@eu.i.posthog.com" }],
    ["a host that is not a URL", { LANTEREL_POSTHOG_HOST: "eu.i.posthog.com" }],
  ])("is off with %s", (_what, change) => {
    const on = { LANTEREL_POSTHOG_KEY: "phc_x", LANTEREL_POSTHOG_HOST: "https://eu.i.posthog.com" };
    expect(errorTrackingConfig({ ...on, ...change })).toBeNull();
  });

  it("reads other names when given them", () => {
    expect(
      errorTrackingConfig({ K: "phc_y", H: "https://us.i.posthog.com" }, { key: "K", host: "H" }),
    ).toEqual({
      key: "phc_y",
      host: "https://us.i.posthog.com",
    });
  });
});

describe("parseStack", () => {
  it("reads V8 frames, outermost call first, and tells the app's code from Node's and its packages'", () => {
    const stack = [
      "Error: boom",
      "    at readPc (/usr/lib/swiff/hostd/src/agent.ts:120:15)",
      "    at async Promise.all (index 0)",
      "    at async run (file:///usr/lib/swiff/hostd/src/main.ts:40:3)",
      "    at /usr/lib/swiff/streamer/node_modules/werift/lib/index.js:9:1",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
    ].join("\n");
    expect(parseStack(stack, "node:javascript")).toEqual([
      expect.objectContaining({ function: "process.processTicksAndRejections", in_app: false }),
      expect.objectContaining({ function: "<anonymous>", in_app: false, lineno: 9, colno: 1 }),
      expect.objectContaining({
        function: "run",
        filename: "file:///usr/lib/swiff/hostd/src/main.ts",
        in_app: true,
      }),
      {
        platform: "node:javascript",
        filename: "/usr/lib/swiff/hostd/src/agent.ts",
        function: "readPc",
        lineno: 120,
        colno: 15,
        in_app: true,
      },
    ]);
  });
});

describe("exceptionList", () => {
  it("lists the error after its causes, and reports what was thrown when it is no Error", () => {
    const error = new TypeError("outer", { cause: new RangeError("inner") });
    const list = exceptionList(error, {
      handled: false,
      mechanism: "uncaughtException",
      platform: "node:javascript",
    });
    expect(list.map((e) => [e.type, e.value, e.mechanism.type])).toEqual([
      ["RangeError", "inner", "chained"],
      ["TypeError", "outer", "uncaughtException"],
    ]);
    expect(list[1]?.stacktrace?.frames.length).toBeGreaterThan(0);

    expect(
      exceptionList("just text", { handled: true, mechanism: "generic", platform: "node:javascript" }),
    ).toEqual([
      { type: "Error", value: "just text", mechanism: { handled: true, synthetic: true, type: "generic" } },
    ]);
  });

  it("stops at a cause that points back into the chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(
      exceptionList(b, { handled: true, mechanism: "generic", platform: "node:javascript" }),
    ).toHaveLength(2);
  });
});

describe("createTracker", () => {
  it("posts one $exception event to the project's capture API, with no person and no location", async () => {
    const { tracker, urls, bodies } = recorded();
    tracker.capture(new Error("boom"), {
      handled: false,
      mechanism: "uncaughtException",
      properties: { step: "attest" },
    });
    await tracker.flush();
    expect(urls).toEqual(["https://eu.i.posthog.com/i/v0/e/"]);
    const [body] = bodies;
    expect(body).toMatchObject({
      api_key: "phc_test",
      event: "$exception",
      timestamp: "2026-10-07T12:00:00.000Z",
      properties: {
        $exception_level: "error",
        $process_person_profile: false,
        $geoip_disable: true,
        service: "swiff-hostd",
        release: "0.1.0",
        step: "attest",
        $exception_list: [
          { type: "Error", value: "boom", mechanism: { handled: false, type: "uncaughtException" } },
        ],
      },
    });
    expect(body?.distinct_id).toMatch(/^swiff-hostd-run-[0-9a-f]{32}$/);
  });

  it("never sends a secret, an invite link or a user's path, in the message, the stack or the properties", async () => {
    const { tracker, bodies } = recorded({ secrets: ["mk_very_secret_machine_key"] });
    const error = new Error("register mk_very_secret_machine_key for /invite/abc123 as 76561198012345678");
    error.stack = `Error: ${error.message}\n    at run (C:\\Users\\Tom\\AppData\\Local\\Lanterel\\main.cjs:1:2)`;
    tracker.capture(error, { properties: { where: "/Users/tom/x" } });
    await tracker.flush();
    const sent = JSON.stringify(bodies);
    for (const leak of ["mk_very_secret_machine_key", "abc123", "76561198012345678", "Tom", "/Users/tom"]) {
      expect(sent).not.toContain(leak);
    }
    expect(sent).toContain("C:\\\\Users\\\\<user>\\\\AppData");
  });

  it("asks a config function at each report, for a project learned after start", async () => {
    let project: typeof CONFIG | null = null;
    const urls: string[] = [];
    const tracker = createTracker({
      config: () => project,
      service: "x",
      send: async (url) => void urls.push(url),
    });
    tracker.capture(new Error("before"));
    expect(tracker.enabled).toBe(false);
    project = CONFIG;
    tracker.capture(new Error("after"));
    await tracker.flush();
    expect(tracker.enabled).toBe(true);
    expect(urls).toEqual(["https://eu.i.posthog.com/i/v0/e/"]);
  });

  it("sends nothing without a config", async () => {
    const send = vi.fn(async () => {});
    const tracker = createTracker({ config: null, service: "x", send });
    tracker.capture(new Error("boom"));
    await tracker.flush();
    expect(tracker.enabled).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the same failure once, and at most MAX_REPORTS a run", async () => {
    const { tracker, bodies } = recorded();
    const again = () => new Error("same");
    for (let i = 0; i < 3; i++) tracker.capture(again());
    for (let i = 0; i < MAX_REPORTS + 10; i++) tracker.capture(new Error(`failure ${"x".repeat(i)}`));
    await tracker.flush();
    expect(bodies).toHaveLength(MAX_REPORTS);
  });

  it("never throws or rejects, when sending fails or hangs", async () => {
    const hang = createTracker({ config: CONFIG, service: "x", send: () => new Promise(() => {}) });
    const fail = createTracker({
      config: CONFIG,
      service: "x",
      send: async () => Promise.reject(new Error("offline")),
    });
    expect(() => hang.capture(new Error("a"))).not.toThrow();
    expect(() => fail.capture(new Error("b"))).not.toThrow();
    await expect(hang.flush(10)).resolves.toBeUndefined();
    await expect(fail.flush()).resolves.toBeUndefined();
  });
});

/** A process that records its exit instead of exiting. */
function fakeProcess() {
  const emitter = new EventEmitter();
  const exited = new Promise<number>((resolve) => {
    (emitter as unknown as { exit: (code: number) => void }).exit = resolve;
  });
  return { proc: emitter as unknown as TrackedProcess & EventEmitter, exited };
}

describe("trackProcess", () => {
  it("reports what nothing caught in a daemon, logs it, and exits 1 once the report is sent", async () => {
    const { tracker, bodies } = recorded();
    const { proc, exited } = fakeProcess();
    const log = vi.fn();
    trackProcess(tracker, proc, { log });
    proc.emit("unhandledRejection", new Error("nobody waited"));
    expect(await exited).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Error: nobody waited"));
    expect(bodies[0]?.properties.$exception_list[0]).toMatchObject({
      value: "nobody waited",
      mechanism: { handled: false, type: "unhandledRejection" },
    });
  });

  it("in Electron's main process only watches: it reports, and neither logs, exits nor takes over uncaught errors", async () => {
    const { tracker, bodies } = recorded();
    const { proc } = fakeProcess();
    const exit = vi.spyOn(proc, "exit");
    const log = vi.fn();
    trackProcess(tracker, proc, { crash: false, log });
    expect(proc.listenerCount("uncaughtException")).toBe(0);
    proc.emit("uncaughtExceptionMonitor", new Error("main broke"));
    proc.emit("unhandledRejection", "a string");
    await tracker.flush();
    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(bodies.map((b) => b.properties.$exception_list[0].mechanism.type)).toEqual([
      "uncaughtException",
      "unhandledRejection",
    ]);
  });

  it("leaves the process alone when reports are off", () => {
    const { proc } = fakeProcess();
    trackProcess(createTracker({ config: null, service: "x" }), proc);
    expect(proc.eventNames()).toEqual([]);
  });
});
