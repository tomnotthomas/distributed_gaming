import { useCallback, useEffect, useRef, useState } from "react";
import type { RunEvent } from "../rental-exec.cjs";
import type { EkCertificate, RentalPlan, RentalRead } from "../rental.cjs";
import { bridge } from "./bridge";
import type { EkResult } from "./ek";
import { IDLE_RUN, type ImageDownload, type RentalRun, type RentalSetup, type WritePass } from "./model";
import { meter } from "./progress";
import { endsInRestart, fileName, firmwareChecks, pcChecks, recoveryDue, writesOf } from "./rental";

const LIVE_SEEN = "swiff.rental.liveSeen";

/** A write's three passes over its bytes, in the order the worker makes them (rental-worker.cjs). */
const PASSES = ["copying", "writing", "checking"] as const;

/**
 * How far a measured step is from one write's progress: `done` of `total`
 * across the whole step, which only moves forward, and the pass itself, in
 * its own file's bytes. Each write is copied into the administrators' folder,
 * written, then read back to check it: each pass counts a third of its bytes
 * across the step. The write is told apart by its size (Swiff OS's three are
 * all different).
 */
export function stepBytes(
  writes: number[],
  event: { what: string; done: number; total: number },
): { done: number; total: number; pass: WritePass } | null {
  const total = writes.reduce((sum, b) => sum + b, 0);
  const at = writes.indexOf(event.total);
  const pass = PASSES.findIndex((p) => event.what.toLowerCase().startsWith(`${p} `));
  if (at < 0 || pass < 0 || total <= 0) return null;
  const before = writes.slice(0, at).reduce((sum, b) => sum + b, 0);
  return {
    done: before + (pass * event.total + event.done) / 3,
    total,
    pass: {
      doing: PASSES[pass]!,
      name: fileName(event.what.slice(PASSES[pass]!.length + 1)),
      done: event.done,
      total: event.total,
    },
  };
}

/**
 * Rental mode on this PC, read through main (rental.cjs) once on opening and
 * again when the owner asks: after a trip to the BIOS, say. A plan comes back
 * for the screen; running it is main's (rental-exec.cjs), which runs every
 * step by itself after the owner's one OK and tells how each goes. A restart
 * waits for the owner's Restart now. Go live registers the TPM's EK with the
 * server first, with `registerEk` (ek.ts).
 */
export function useRental({
  registerEk = async () => ({ ok: false, error: "no-machine" }),
}: { registerEk?: (ek: EkCertificate) => Promise<EkResult> } = {}): RentalSetup & {
  check(): void;
  choose(id: string): void;
  plan(kind: RentalPlan["kind"], options?: { key?: boolean }): void;
  close(): void;
  start(): void;
  restart(): void;
  answer(yes: boolean): void;
  goLive(): void;
  retry(): void;
  report(): void;
  seenLive(): void;
  saveRecovery(): void;
  openBitLocker(): void;
  seenRemoval(): void;
  finishRemoval(): void;
  downloadImage(): void;
} {
  const [read, setRead] = useState<RentalRead | null>(null);
  const [reading, setReading] = useState(true);
  const [target, setTarget] = useState<string | null>(null);
  const [preview, setPreview] = useState<RentalPlan | null>(null);
  const [run, setRun] = useState<RentalRun>(IDLE_RUN);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [planning, setPlanning] = useState(false);
  const [bitlockerPage, setBitlockerPage] = useState<"opened" | "failed" | null>(null);
  const [download, setDownload] = useState<ImageDownload>({ status: "idle" });
  // Which live run the owner has seen summed up: kept in this window's storage, a convenience only.
  const [liveSeen, setLiveSeen] = useState<number | null>(() => {
    try {
      return Number(localStorage.getItem(LIVE_SEEN)) || null;
    } catch {
      return null;
    }
  });
  const reads = useRef(0);
  const plans = useRef(0);
  // The plan being run, for its events: they name steps, the plan says what each writes.
  const running = useRef<RentalPlan | null>(null);
  const busy = run.status === "starting" || run.status === "running" || run.status === "restarting";
  const nextPlan = () => {
    setPlanning(false);
    return ++plans.current;
  };
  const drop = () => {
    nextPlan();
    setPreview(null);
    setRun(IDLE_RUN);
  };

  /** Read the PC again. `keep` keeps the plan on screen: the one that just ran, with how it went. */
  const reread = useCallback((keep = false) => {
    const host = bridge();
    if (!host) return setReading(false);
    const n = ++reads.current;
    setReading(true);
    void host
      .readRental()
      .catch(() => null)
      .then((next) => {
        if (n !== reads.current) return;
        // A plan asked for during the read was built from the old one: it describes a PC that has moved on.
        if (!keep) {
          nextPlan();
          setPreview(null);
        }
        setRead(next);
        setReadAt(Date.now());
        setReading(false);
      });
  }, []);
  const check = useCallback(() => reread(), [reread]);
  useEffect(check, [check]);

  // Whether this window follows a download main runs: one it asked for, or one under way when it opened.
  const following = useRef(false);
  const follow = useCallback(
    (host: NonNullable<ReturnType<typeof bridge>>) => {
      following.current = true;
      void host
        .downloadImage()
        .catch(() => ({ ok: false as const, error: "The download stopped. Try again.", retry: true }))
        .then((outcome) => {
          following.current = false;
          if (outcome && !outcome.ok)
            setDownload({ status: "failed", error: outcome.error, retry: outcome.retry });
          else setDownload({ status: "idle" });
          // Its files are on this PC now, or another window got them there: the next read says.
          reread();
        });
    },
    [reread],
  );
  // How far Lanterel OS's download is, as main reports it.
  useEffect(
    () =>
      bridge()?.onImageProgress?.((p) => {
        const host = bridge();
        if (host && !following.current) follow(host);
        setDownload((d) => {
          const now = Date.now();
          const same = d.status === "running" && d.phase === p.phase && d.total === p.total;
          return { status: "running", ...p, meter: meter(same ? d.meter : null, p.done, now) };
        });
      }),
    [follow],
  );
  const downloadImage = () => {
    const host = bridge();
    if (!host || following.current) return;
    setDownload({ status: "running", phase: "check", done: 0, total: 0, meter: null });
    follow(host);
  };

  // Each step of a run, as main reports it.
  useEffect(
    () =>
      bridge()?.onRentalEvent?.((event: RunEvent) => {
        const now = Date.now();
        setRun((r) => {
          if (event.type === "progress") {
            const step = running.current?.steps.find((s) => s.id === event.id);
            const bytes = step ? stepBytes(writesOf(step), event) : null;
            if (!bytes) return r;
            return {
              ...r,
              progress: { id: event.id, ...bytes },
              meter: meter(r.progress?.id === event.id ? r.meter : null, bytes.done, now),
            };
          }
          const starts = event.state === "running";
          return {
            ...r,
            status: "running",
            steps: { ...r.steps, [event.id]: event.state },
            stepStartedAt: starts ? now : r.stepStartedAt,
            progress: starts ? null : r.progress,
            meter: starts ? null : r.meter,
            failed: event.state === "failed" ? { step: event.id, error: event.error ?? "" } : r.failed,
            endedAt: event.state === "failed" ? now : r.endedAt,
          };
        });
      }),
    [],
  );

  /** Run `plan` (the one main last planned): the owner's one OK. Resolves with how it ended. */
  const runPlan = (plan: RentalPlan) => {
    const host = bridge();
    if (!host) return Promise.resolve(null);
    running.current = plan;
    const now = Date.now();
    setRun({ ...IDLE_RUN, status: "starting", startedAt: now, stepStartedAt: now });
    // Only main's own "elevate" failure is the administrator prompt: a run main rejected or no longer
    // has a plan for failed after that, so it is planned afresh (step "run"), never asked again as is.
    return host
      .runRental()
      .catch((error: unknown) => ({
        status: "failed" as const,
        done: [],
        failed: { step: "run", op: "run", error: String(error) },
        results: [],
      }))
      .then((outcome) => {
        setRun((r) => ({
          ...r,
          endedAt: Date.now(),
          status: outcome?.status ?? "failed",
          failed: outcome?.failed
            ? { step: outcome.failed.step, error: outcome.failed.error }
            : outcome
              ? r.failed
              : { step: "run", error: "The installer did not start." },
        }));
        // What the run changed is read again, so the screen says where the PC is now. A run that
        // ended at its restart keeps its plan on screen, for Restart now; a finished one is done with.
        reread(outcome?.status !== "done" || endsInRestart(plan));
        return outcome;
      });
  };

  const restart = () => {
    const host = bridge();
    if (!host) return;
    setRun((r) => ({ ...r, status: "restarting", stepStartedAt: Date.now() }));
    void host
      .restartRental()
      .catch(() => false)
      .then((ok) => {
        if (!ok)
          setRun((r) => ({
            ...r,
            status: "failed",
            failed: { step: "restart", error: "Windows didn't restart." },
          }));
      });
  };

  /** Plan `kind` afresh and run it at once: Try again and Ask again, where the owner's OK stands. */
  const again = (kind: RentalPlan["kind"], key?: boolean) => {
    const host = bridge();
    if (!host || busy) return;
    const n = nextPlan();
    setPlanning(true);
    void host
      .planRental({ kind, target, ...(key === undefined ? {} : { key }) })
      .catch(() => null)
      .then((plan) => {
        if (n !== plans.current) return;
        setPlanning(false);
        setPreview(plan);
        if (plan) void runPlan(plan);
        else
          setRun({
            ...IDLE_RUN,
            status: "failed",
            failed: { step: "plan", error: "Lanterel couldn't plan this again." },
          });
      });
  };

  /** Go live stopped at the TPM's EK (`error`, ek.ts's or "none" for no certificate): nothing restarts. */
  const ekFailed = (error: string) =>
    setRun((r) => ({ ...r, status: "failed", endedAt: Date.now(), failed: { step: "ek", error } }));

  /**
   * Swiff OS once, for now: going live for good (Swiff OS first in the boot order) waits on Swiff OS
   * handing the PC back. Holding Go live is the owner's OK, so it restarts by itself, once the server
   * has this TPM's EK, which is always before anything changes what the PC starts: the app registers
   * the one the last check read, and the plan's own read stops it before BootNext when the TPM has
   * another (a new board) or none was read before. That read is recorded, so the app registers it and
   * goes live again, once.
   */
  const goLive = () => {
    const host = bridge();
    if (!host || busy) return;
    const n = nextPlan();
    const checked = (r: RentalRead | null): EkCertificate | null =>
      r?.facts.checked?.certificate
        ? { certificate: r.facts.checked.certificate, intermediates: r.facts.checked.intermediates }
        : null;
    void (async () => {
      let registered = checked(read);
      for (let again = false; ; again = true) {
        if (registered)
          setRun({ ...IDLE_RUN, status: "running", startedAt: Date.now(), stepStartedAt: Date.now() });
        const plan = await host
          .planRental({ kind: "once", registered: registered?.certificate ?? null })
          .catch(() => null);
        if (n !== plans.current) return;
        if (!plan) {
          if (registered) setRun(IDLE_RUN);
          return;
        }
        setPreview(plan);
        if (registered) {
          const result = await registerEk(registered);
          if (n !== plans.current) return;
          if (!result.ok) return ekFailed(result.error);
        }
        const outcome = await runPlan(plan);
        if (n !== plans.current || !outcome) return;
        if (outcome.status === "done") return restart();
        if (outcome.failed?.step !== "ek" || again) return;
        // The TPM step stopped before any boot change: its read is recorded. A certificate other than
        // the one registered is this TPM's, to register before going live again; none, or the same one,
        // leaves the run's own failure on screen.
        const now = checked(await host.readRental().catch(() => null));
        if (n !== plans.current || !now || now.certificate === registered?.certificate) return;
        registered = now;
      }
    })();
  };

  // Remove Swiff OS goes on by itself once its key's restart is behind it, once per app start:
  // the owner asked once. After that, only the owner's own Try again or the key's removal again.
  const [removalTried, setRemovalTried] = useState(false);
  useEffect(() => {
    if (
      read?.removal?.state !== "finish" ||
      recoveryDue(read) ||
      preview ||
      planning ||
      run.status !== "idle" ||
      removalTried
    )
      return;
    setRemovalTried(true);
    again("remove", false);
  });

  return {
    reading,
    read,
    readAt,
    planning,
    liveSeen,
    bitlockerPage,
    removalTried,
    download,
    downloadImage,
    target,
    preview,
    run,
    check: () => {
      if (busy) return;
      drop();
      check();
    },
    choose: (id) => {
      if (busy) return;
      setTarget(id);
      drop();
    },
    plan: (kind, options) => {
      if (busy) return;
      const n = nextPlan();
      setPreview(null);
      setRun(IDLE_RUN);
      const asked = bridge()?.planRental({
        kind,
        target,
        ...(typeof options?.key === "boolean" ? { key: options.key } : {}),
      });
      if (!asked) return;
      setPlanning(true);
      void asked
        .catch(() => null)
        .then((next) => {
          if (n !== plans.current) return;
          setPlanning(false);
          setPreview(next);
        });
    },
    close: () => {
      if (!busy) drop();
    },
    start: () => {
      if (!preview || busy) return;
      void runPlan(preview);
    },
    restart,
    seenLive: () => {
      const to = read?.lastLive?.to ?? null;
      if (to === null) return;
      setLiveSeen(to);
      try {
        localStorage.setItem(LIVE_SEEN, String(to));
      } catch {
        // Not kept: it shows again next time, which is harmless.
      }
    },
    retry: () => {
      if (!preview) return;
      if (run.failed?.step === "restart") return restart();
      // Go live goes through the TPM's EK again, whatever else stopped it.
      if (preview.kind === "once") return goLive();
      // Windows said no before anything ran: main still holds the same plan, and its code stands.
      if (run.failed?.step === "elevate") return void runPlan(preview);
      // Remove Swiff OS goes on with the part that stopped.
      again(preview.kind, preview.kind === "remove" ? preview.phase === "key" : undefined);
    },
    saveRecovery: () => {
      void bridge()
        ?.saveRecoveryKey()
        .catch(() => false)
        .then(() => reread());
    },
    openBitLocker: () => {
      void bridge()
        ?.openBitLocker()
        .catch(() => false)
        .then((opened) => setBitlockerPage(opened ? "opened" : "failed"));
    },
    finishRemoval: () => again("remove", false),
    seenRemoval: () => {
      void bridge()
        ?.seenRemoval()
        .catch(() => false)
        .then(() => reread());
    },
    report: () => {
      const host = bridge();
      if (!host || !run.failed) return;
      const checks = read ? [...firmwareChecks(read), ...pcChecks(read, target)] : [];
      void host
        .reportRental({
          step: run.failed.step,
          error: run.failed.error,
          checks: checks.map((c) => ({ id: c.id, value: c.value })),
        })
        .catch(() => null)
        .then((at) => setRun((r) => ({ ...r, reportedAt: at })));
    },
    answer: (yes) => {
      void bridge()
        ?.answerRentalKey(yes)
        .catch(() => false)
        .then(() => reread());
    },
    goLive,
  };
}
