import { useCallback, useEffect, useRef, useState } from "react";
import type { RunEvent } from "../rental-exec.cjs";
import type { RentalPlan, RentalRead } from "../rental.cjs";
import { bridge } from "./bridge";
import { IDLE_RUN, type RentalRun, type RentalSetup } from "./model";

/**
 * Rental mode on this PC, read through main (rental.cjs) once on opening and
 * again when the owner asks: after a trip to the BIOS, say. A plan comes
 * back for the screen; running it is main's (rental-exec.cjs), which tells
 * how each step goes and waits for the owner's yes before each step that
 * changes the disk or the firmware.
 */
export function useRental(): RentalSetup & {
  check(): void;
  choose(id: string): void;
  plan(kind: RentalPlan["kind"]): void;
  close(): void;
  start(): void;
  confirm(yes: boolean): void;
} {
  const [read, setRead] = useState<RentalRead | null>(null);
  const [reading, setReading] = useState(true);
  const [target, setTarget] = useState<string | null>(null);
  const [preview, setPreview] = useState<RentalPlan | null>(null);
  const [run, setRun] = useState<RentalRun>(IDLE_RUN);
  const reads = useRef(0);
  const plans = useRef(0);
  const running = run.status === "starting" || run.status === "running";
  const drop = () => {
    plans.current++;
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
          plans.current++;
          setPreview(null);
        }
        setRead(next);
        setReading(false);
      });
  }, []);
  const check = useCallback(() => reread(), [reread]);
  useEffect(check, [check]);

  // Each step of a run, as main reports it.
  useEffect(
    () =>
      bridge()?.onRentalEvent?.((event: RunEvent) =>
        setRun((r) => {
          if (event.type === "progress")
            return {
              ...r,
              progress: { id: event.id, what: event.what, done: event.done, total: event.total },
            };
          return {
            ...r,
            status: "running",
            steps: { ...r.steps, [event.id]: event.state },
            waiting: event.state === "confirm" ? event.id : r.waiting === event.id ? null : r.waiting,
            progress: event.state === "running" ? null : r.progress,
            failed: event.state === "failed" ? { step: event.id, error: event.error ?? "" } : r.failed,
          };
        }),
      ),
    [],
  );

  return {
    reading,
    read,
    target,
    preview,
    run,
    check: () => {
      if (running) return;
      drop();
      check();
    },
    choose: (id) => {
      if (running) return;
      setTarget(id);
      drop();
    },
    plan: (kind) => {
      if (running) return;
      const n = ++plans.current;
      setRun(IDLE_RUN);
      void bridge()
        ?.planRental({ kind, target })
        .catch(() => null)
        .then((next) => {
          if (n === plans.current) setPreview(next);
        });
    },
    close: () => {
      if (!running) drop();
    },
    start: () => {
      const host = bridge();
      if (!host || !preview || running) return;
      setRun({ ...IDLE_RUN, status: "starting" });
      void host
        .runRental()
        .catch((error: unknown) => ({
          status: "failed" as const,
          done: [],
          failed: { step: "elevate", op: "elevate", error: String(error) },
          results: [],
        }))
        .then((outcome) => {
          setRun((r) => ({
            ...r,
            status: outcome?.status ?? "failed",
            waiting: null,
            failed: outcome?.failed ? { step: outcome.failed.step, error: outcome.failed.error } : r.failed,
          }));
          // What the run changed is read again, so the screen says where the PC is now.
          reread(true);
        });
    },
    confirm: (yes) => {
      const id = run.waiting;
      if (!id) return;
      setRun((r) => ({ ...r, waiting: null }));
      void bridge()?.confirmRental(id, yes);
    },
  };
}
