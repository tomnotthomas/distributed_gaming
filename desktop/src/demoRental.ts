// Rental mode in the demo: every state the design draws, each one a screen in
// the demo's picker, and a pretend run so the install can be watched from the
// one OK to the blue screen. Nothing here reaches the PC: the plans are
// Nova-01's, written out, and their steps take made-up times.

import { useEffect, useRef, useState } from "react";
import type { PlanStep, RentalPlan, RentalRead } from "../rental.cjs";
import { DEMO_RENTAL_READ, evening, type RentalCase } from "./demo";
import { IDLE_RUN, type RentalRun, type RentalSetup } from "./model";
import { meter, type RateMeter } from "./progress";
import { writesOf } from "./rental";

/** The demo's write, as one pass over all of Swiff OS. */
const demoPass = (done: number, total: number) => ({
  doing: "writing" as const,
  name: "Swiff OS",
  done,
  total,
});

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

// --- Nova-01's plans, written out --------------------------------------------------------------

const step = (id: string, title: string, ops: PlanStep["ops"] = [{ op: "installed" }]): PlanStep => ({
  id,
  title,
  confirm: null,
  ops,
  commands: [`# ${title}`],
});
const restart = (title: string) => ({
  ...step("mok-restart", title, [{ op: "restart" }]),
  confirm: "Restarts.",
});
const CODE = "48217730";
const NEW_CODE = "60394182";
const AT = 1_975_040_327_680;

const INSTALL: RentalPlan = {
  kind: "install",
  target: DEMO_RENTAL_READ.targets[0],
  steps: [
    step("check", "Check the Secure Boot keys and the TPM (asks for administrator)"),
    step("fast-startup", "Turn off Fast Startup so Swiff OS can read your drives"),
    step("room", "Shrink C: by 24 GB"),
    step("partitions", "Create 6 partitions for Swiff OS on disk 0"),
    step("write", "Copy Swiff OS onto them", [
      { op: "write", disk: 0, offset: AT, bytes: 1 * GiB, source: "esp" },
      { op: "write", disk: 0, offset: AT + GiB, bytes: 8 * GiB, source: "root-x86-64" },
      { op: "write", disk: 0, offset: AT + 9 * GiB, bytes: 128 * MiB, source: "root-x86-64-verity" },
    ]),
    step("boot-entry", "Add Swiff OS to the boot menu, after Windows"),
    step("games", "Label D: SWIFFGAMES so Swiff OS finds your games"),
    step("mok", "Make a one-time code for Swiff's key"),
    restart("Restart once to confirm the key"),
  ],
  mok: { code: CODE },
};

const MOK: RentalPlan = {
  kind: "mok",
  steps: [step("mok", "Make a one-time code for Swiff's key"), restart("Restart once to confirm the key")],
  mok: { code: NEW_CODE },
};

const UNKEY: RentalPlan = {
  kind: "unkey",
  steps: [
    step("mok-remove", "Make a one-time code to remove Swiff's key"),
    { ...restart("Restart once to confirm the removal"), id: "restart" },
  ],
  mok: { code: NEW_CODE },
};

const UNINSTALL: RentalPlan = {
  kind: "uninstall",
  steps: [
    step("boot-entry", "Take Swiff OS out of the boot menu"),
    step("partitions", "Remove Swiff OS's 6 partitions from disk 0"),
    step("room", "Give C: its 24 GB back"),
  ],
};

const REMOVE_KEY: RentalPlan = {
  kind: "remove",
  phase: "key",
  steps: [
    step("mok-remove", "Make a one-time code to remove Swiff's key"),
    { ...restart("Restart once to confirm the removal"), id: "restart" },
  ],
  mok: { code: NEW_CODE },
};

const REMOVE_DISK: RentalPlan = {
  kind: "remove",
  phase: "disk",
  steps: [
    step("boot-entry", "Take Swiff OS out of the boot menu"),
    step("partitions", "Remove Swiff OS's 6 partitions from disk 0"),
    step("room", "Give C: its 24 GB back"),
    step("verify", "Check nothing of Swiff OS is left"),
    step("forget", "Forget the install"),
    { ...restart("Restart once to check Windows starts"), id: "restart" },
  ],
};

const ONCE: RentalPlan = {
  kind: "once",
  steps: [
    step("once", "Start Swiff OS on the next restart only"),
    { ...restart("Restart into Swiff OS"), id: "restart" },
  ],
};

const PLANS: Partial<Record<RentalPlan["kind"], RentalPlan>> = {
  install: INSTALL,
  mok: MOK,
  unkey: UNKEY,
  uninstall: UNINSTALL,
  once: ONCE,
};

/** Remove Swiff OS's part for this read: its key first while Swiff OS is installed, then the disk. */
const removeFor = (read: RentalRead | null, key?: boolean): RentalPlan =>
  (key ?? read?.removal?.state !== "finish") && read?.installed ? REMOVE_KEY : REMOVE_DISK;

/** How long each pretend step takes, in seconds; the write goes by bytes instead. */
const SECONDS: Record<string, number> = { check: 20, room: 110, partitions: 3, "boot-entry": 2, mok: 2 };
/** The pretend write rate, in bytes a second: about three minutes for Swiff OS. */
const RATE = 55e6;

// --- the reads each case starts from -------------------------------------------------------------

const amd = [{ name: "AMD Radeon RX 7900 XTX", vendor: "amd" as const }];
const base = DEMO_RENTAL_READ;
const ready: RentalRead = { ...base, facts: { ...base.facts, iommu: true, gpus: amd } };
const volumes = [
  {
    letter: "C",
    fs: "NTFS",
    label: "Windows",
    size: 2_000_000_000_000,
    free: 19_327_352_832,
    fixed: true,
    bitlocker: "off" as const,
  },
  {
    letter: "D",
    fs: "NTFS",
    label: "Games",
    size: 1_000_000_000_000,
    free: 309_237_645_312,
    fixed: true,
    bitlocker: "off" as const,
  },
];
const installed = (key: NonNullable<RentalRead["key"]> | null): RentalRead => ({
  ...ready,
  facts: { ...ready.facts, fastStartup: false },
  installed: true,
  key,
});
const keyAs = (state: "ask" | "confirmed" | "missed" | "nokey") => installed({ state, code: null });
/** Remove Swiff OS, as far as `removal` says. */
const removing = (removal: NonNullable<RentalRead["removal"]>): RentalRead => ({
  ...keyAs("missed"),
  ...(removal.state === "restart" || removal.state === "checked"
    ? { installed: false, facts: { ...ready.facts, install: null } }
    : {}),
  removal,
});
/** What the start after Remove Swiff OS showed. */
const CHECKED: NonNullable<RentalRead["removal"]> = {
  state: "checked",
  ok: true,
  at: AT,
  checks: [
    { id: "windows", label: "Windows", ok: true, value: "Started as usual" },
    { id: "partitions", label: "Swiff OS", ok: true, value: "Gone from the disk" },
    { id: "space", label: "C:", ok: true, value: "Its 1863 GB again" },
    { id: "bitlocker-C", label: "C: BitLocker", ok: true, value: "On" },
    { id: "record", label: "Install record", ok: true, value: "Gone" },
  ],
};

/** The run of a plan at step `at` (its index), the steps before it done. */
function runAt(plan: RentalPlan, at: number, state: "running" | "failed", elapsed: number): RentalRun {
  const now = Date.now();
  const steps: RentalRun["steps"] = {};
  plan.steps.slice(0, at).forEach((s) => (steps[s.id] = "done"));
  steps[plan.steps[at]!.id] = state;
  return {
    ...IDLE_RUN,
    status: state === "failed" ? "failed" : "running",
    steps,
    startedAt: now - 300_000,
    stepStartedAt: now - elapsed * 1000,
    endedAt: state === "failed" ? now : null,
  };
}

/** A write `share` of the way through, its rate measured for `elapsed` seconds. */
function writing(run: RentalRun, share: number, elapsed: number): RentalRun {
  const total = writesOf(INSTALL.steps[4]!).reduce((a, b) => a + b, 0);
  const done = total * share;
  const now = Date.now();
  const m: RateMeter = {
    since: now - elapsed * 1000,
    at: now,
    done,
    rate: RATE,
    mark: { at: now - 1000, done: done - RATE },
    recent: RATE,
  };
  return { ...run, progress: { id: "write", done, total, pass: demoPass(done, total) }, meter: m };
}

type Start = { read: RentalRead | null; reading: boolean; preview: RentalPlan | null; run: RentalRun };

function startOf(c: RentalCase): Start {
  const idle = { reading: false, preview: null, run: IDLE_RUN };
  switch (c) {
    case "rental-checking":
      return { ...idle, read: null, reading: true };
    case "rental-unread":
      return { ...idle, read: null };
    case "rental-bios2":
      return { ...idle, read: { ...base, facts: { ...base.facts, secureBoot: false, gpus: amd } } };
    case "rental-recheck":
      return { ...idle, read: base, reading: true };
    case "rental-bitlocker":
      return {
        ...idle,
        read: {
          ...ready,
          facts: { ...ready.facts, iommu: false },
          games: { ...base.games!, bitlocker: "on" },
        },
      };
    case "rental-almost":
      return { ...idle, read: { ...base, facts: { ...base.facts, iommu: true } } };
    case "rental-ready":
      return { ...idle, read: ready };
    case "rental-preview":
      return { ...idle, read: ready, preview: INSTALL };
    case "rental-run-check":
      return { ...idle, read: ready, preview: INSTALL, run: runAt(INSTALL, 0, "running", 8) };
    case "rental-run-shrink":
      return { ...idle, read: ready, preview: INSTALL, run: runAt(INSTALL, 2, "running", 74) };
    case "rental-run-write":
      return {
        ...idle,
        read: ready,
        preview: INSTALL,
        run: writing(runAt(INSTALL, 4, "running", 131), 0.42, 131),
      };
    case "rental-run-late":
      return {
        ...idle,
        read: ready,
        preview: INSTALL,
        run: writing(runAt(INSTALL, 4, "running", 286), 0.91, 286),
      };
    case "rental-restart":
      return {
        ...idle,
        read: ready,
        preview: INSTALL,
        run: {
          ...runAt(INSTALL, 8, "running", 0),
          status: "done",
          steps: Object.fromEntries(INSTALL.steps.slice(0, 8).map((s) => [s.id, "done"])),
        },
      };
    case "rental-restarting":
      return {
        ...idle,
        read: ready,
        preview: INSTALL,
        run: {
          ...runAt(INSTALL, 8, "running", 7),
          status: "restarting",
          steps: Object.fromEntries(INSTALL.steps.slice(0, 8).map((s) => [s.id, "done"])),
        },
      };
    case "rental-ask":
      return { ...idle, read: keyAs("ask") };
    case "rental-key":
      return { ...idle, read: keyAs("missed") };
    case "rental-key-code":
      return { ...idle, read: keyAs("missed"), preview: MOK };
    case "rental-installed":
      return { ...idle, read: keyAs("confirmed") };
    case "rental-back":
      return {
        ...idle,
        read: {
          ...keyAs("confirmed"),
          lastLive: { from: evening(21), to: evening(23, 40), sessions: 2, early: 0, earned: 3.1 },
        },
      };
    case "rental-recovery":
      return { ...idle, read: { ...ready, recovery: { drives: ["C"], saved: false, at: null } } };
    case "rental-remove-code":
      return { ...idle, read: keyAs("confirmed"), preview: REMOVE_KEY };
    case "rental-remove-finish":
      return { ...idle, read: removing({ state: "finish" }) };
    case "rental-remove-check":
      return { ...idle, read: removing({ state: "restart" }) };
    case "rental-removed":
      return { ...idle, read: removing(CHECKED) };
    case "rental-fail-admin":
      return {
        ...idle,
        read: ready,
        preview: INSTALL,
        run: {
          ...IDLE_RUN,
          status: "failed",
          failed: { step: "elevate", error: "Windows did not give Swiff Host administrator rights." },
          endedAt: Date.now(),
        },
      };
    case "rental-fail-write":
      return {
        ...idle,
        read: ready,
        preview: INSTALL,
        run: {
          ...writing(runAt(INSTALL, 4, "failed", 131), 0.42, 131),
          failed: {
            step: "write",
            error:
              "Write to disk 0, partition 5 failed at 4,402,341,888 bytes: The request could not be performed because of an I/O device error. (0x8007045D)",
          },
        },
      };
    case "rental-fail-space":
      return {
        ...idle,
        read: { ...ready, facts: { ...ready.facts, volumes } },
        preview: INSTALL,
        run: {
          ...runAt(INSTALL, 2, "failed", 3),
          failed: { step: "room", error: "C: cannot shrink by 24 GB." },
        },
      };
    case "rental-nokey":
      return { ...idle, read: keyAs("nokey") };
    case "rental-ca":
      return { ...idle, read: { ...ready, facts: { ...ready.facts, db: false } } };
    case "rental-fail-bios":
      return {
        ...idle,
        read: ready,
        preview: INSTALL,
        run: {
          ...runAt(INSTALL, 0, "failed", 4),
          failed: { step: "check", error: "Secure Boot is off." },
        },
      };
    case "rental-fail-removal":
      return {
        ...idle,
        read: keyAs("confirmed"),
        preview: UNINSTALL,
        run: {
          ...runAt(UNINSTALL, 2, "failed", 12),
          failed: {
            step: "room",
            error:
              "Resize-Partition: Size Not Supported. The requested size exceeds what the partition can grow to.",
          },
        },
      };
    case "rental-fail-unknown":
      return {
        ...idle,
        read: ready,
        preview: INSTALL,
        run: {
          ...runAt(INSTALL, 1, "failed", 2),
          failed: { step: "fast-startup", error: "reg failed: exit code 1" },
        },
      };
    default:
      return { ...idle, read: base };
  }
}

// --- the hook ---------------------------------------------------------------------------------

/**
 * The demo's rental mode: the state `c` draws, and actions that move on from
 * it the way the real ones would, on a pretend run.
 */
export function useDemoRental(c: RentalCase | null, clockAt: number) {
  const [s, setS] = useState<Start & { target: string | null }>(() => ({
    target: null,
    ...startOf(c ?? "rental"),
  }));
  const caseRef = useRef(c);
  useEffect(() => {
    if (caseRef.current === c) return;
    caseRef.current = c;
    setS({ target: null, ...startOf(c ?? "rental") });
  }, [c]);

  // The pretend run: each tick moves the running step on, or starts the next one.
  const running = s.run.status === "running" && s.preview !== null;
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      setS((cur) => {
        const plan = cur.preview;
        if (!plan || cur.run.status !== "running") return cur;
        const now = Date.now();
        const auto = plan.steps.filter((x) => !x.ops.some((o) => o.op === "restart"));
        const at = auto.find((x) => cur.run.steps[x.id] !== "done");
        if (!at) return { ...cur, run: { ...cur.run, status: "done", endedAt: now } };
        const run = cur.run;
        if (run.steps[at.id] !== "running")
          return {
            ...cur,
            run: {
              ...run,
              steps: { ...run.steps, [at.id]: "running" },
              stepStartedAt: now,
              progress: null,
              meter: null,
            },
          };
        const elapsed = (now - (run.stepStartedAt ?? now)) / 1000;
        const writes = writesOf(at);
        if (writes.length) {
          const total = writes.reduce((a, b) => a + b, 0);
          const done = Math.min(
            total,
            (run.progress?.done ?? 0) + RATE * 0.25 * (0.85 + Math.random() * 0.3),
          );
          const m: RateMeter = meter(run.meter, done, now);
          if (done < total)
            return {
              ...cur,
              run: { ...run, progress: { id: at.id, done, total, pass: demoPass(done, total) }, meter: m },
            };
        } else if (elapsed < (SECONDS[at.id] ?? 1)) return cur;
        return {
          ...cur,
          run: { ...run, steps: { ...run.steps, [at.id]: "done" }, progress: null, meter: null },
        };
      });
    }, 250);
    return () => window.clearInterval(id);
  }, [running]);

  // Windows' prompt, answered after a moment.
  useEffect(() => {
    if (s.run.status !== "starting") return;
    const t = window.setTimeout(
      () => setS((cur) => ({ ...cur, run: { ...cur.run, status: "running" } })),
      1800,
    );
    return () => window.clearTimeout(t);
  }, [s.run.status]);

  // A pretend restart: Windows comes back, and only the owner knows what the blue screen did.
  useEffect(() => {
    if (s.run.status !== "restarting") return;
    const t = window.setTimeout(
      () =>
        setS((cur) => ({
          ...cur,
          preview: null,
          run: IDLE_RUN,
          read:
            cur.preview?.kind === "remove"
              ? removing(cur.preview.phase === "key" ? { state: "finish" } : CHECKED)
              : cur.preview?.kind === "uninstall"
                ? ready
                : keyAs(cur.preview?.kind === "unkey" ? "missed" : "ask"),
        })),
      5000,
    );
    return () => window.clearTimeout(t);
  }, [s.run.status]);

  // A re-check takes a few seconds and finds the PC as it was.
  useEffect(() => {
    if (!s.reading || c === "rental-checking" || c === "rental-recheck") return;
    const t = window.setTimeout(
      () => setS((cur) => ({ ...cur, reading: false, read: cur.read ?? base })),
      2500,
    );
    return () => window.clearTimeout(t);
  }, [s.reading, c]);

  const start = (plan: RentalPlan) =>
    setS((cur) => ({
      ...cur,
      preview: plan,
      run: { ...IDLE_RUN, status: "starting", startedAt: Date.now(), stepStartedAt: Date.now() },
    }));

  const setup: RentalSetup = { ...s, readAt: clockAt };
  const actions = {
    checkRental: () => setS((cur) => ({ ...cur, reading: true, preview: null, run: IDLE_RUN })),
    chooseRentalTarget: (id: string) => setS((cur) => ({ ...cur, target: id })),
    previewRental: (kind: RentalPlan["kind"], options?: { key?: boolean }) =>
      setS((cur) => ({
        ...cur,
        preview: kind === "remove" ? removeFor(cur.read, options?.key) : (PLANS[kind] ?? null),
        run: IDLE_RUN,
      })),
    closeRentalPreview: () => setS((cur) => ({ ...cur, preview: null, run: IDLE_RUN })),
    runRental: () => s.preview && start(s.preview),
    restartRental: () =>
      setS((cur) => ({ ...cur, run: { ...cur.run, status: "restarting", stepStartedAt: Date.now() } })),
    answerRentalKey: (yes: boolean) => setS((cur) => ({ ...cur, read: keyAs(yes ? "confirmed" : "missed") })),
    saveRecoveryKey: () =>
      setS((cur) => ({
        ...cur,
        read: cur.read && { ...cur.read, recovery: { drives: ["C"], saved: true, at: Date.now() } },
      })),
    openBitLocker: () => {},
    seenRemoval: () => setS((cur) => ({ ...cur, read: ready })),
    retryRental: () => s.preview && start(s.preview),
    reportRental: () => setS((cur) => ({ ...cur, run: { ...cur.run, reportedAt: Date.now() } })),
    seenLastLive: () => setS((cur) => ({ ...cur, read: cur.read && { ...cur.read, lastLive: null } })),
  };
  return { setup, actions };
}
