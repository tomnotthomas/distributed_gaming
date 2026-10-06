import { useCallback, useEffect, useRef, useState } from "react";
import type { RentalPlan, RentalRead } from "../rental.cjs";
import { bridge } from "./bridge";
import type { NvidiaSetup, RentalSetup } from "./model";

const NVIDIA_IDLE: NvidiaSetup = { licence: { state: "idle" }, install: { state: "idle" } };

/**
 * Rental mode on this PC, read through main (rental.cjs) once on opening and
 * again when the owner asks: after a trip to the BIOS, say. Plans come back
 * as previews; nothing here changes the PC, except NVIDIA's driver, which the
 * owner downloads onto their games drive once they accepted its licence
 * (nvidia.cjs).
 */
export function useRental(): Omit<RentalSetup, "nvidiaHosting"> & {
  check(): void;
  choose(id: string): void;
  plan(kind: RentalPlan["kind"]): void;
  close(): void;
  readNvidiaLicence(): void;
  installNvidia(accepted: { licence: boolean; terms: boolean }): void;
  cancelNvidia(): void;
  removeNvidia(): void;
} {
  const [read, setRead] = useState<RentalRead | null>(null);
  const [reading, setReading] = useState(true);
  const [target, setTarget] = useState<string | null>(null);
  const [preview, setPreview] = useState<RentalPlan | null>(null);
  const [nvidia, setNvidia] = useState<NvidiaSetup>(NVIDIA_IDLE);
  const reads = useRef(0);
  const plans = useRef(0);
  const drop = () => {
    plans.current++;
    setPreview(null);
  };

  const check = useCallback(() => {
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
        plans.current++;
        setPreview(null);
        setRead(next);
        setReading(false);
      });
  }, []);
  useEffect(check, [check]);
  // How far the driver's download is, while one runs.
  useEffect(
    () =>
      bridge()?.onNvidiaProgress?.(({ done, total }) =>
        setNvidia((n) =>
          n.install.state === "running" ? { ...n, install: { ...n.install, done, total } } : n,
        ),
      ),
    [],
  );

  return {
    reading,
    read,
    target,
    preview,
    check: () => {
      drop();
      check();
    },
    choose: (id) => {
      setTarget(id);
      drop();
    },
    plan: (kind) => {
      const n = ++plans.current;
      void bridge()
        ?.planRental({ kind, target })
        .catch(() => null)
        .then((next) => {
          if (n === plans.current) setPreview(next);
        });
    },
    close: drop,
    nvidia,
    readNvidiaLicence: () => {
      const host = bridge();
      if (!host) return;
      setNvidia((n) => ({ ...n, licence: { state: "loading" } }));
      void host
        .nvidiaLicence()
        .catch(() => null)
        .then((got) =>
          setNvidia((n) => ({
            ...n,
            licence: got?.ok
              ? { state: "ready", text: got.text }
              : { state: "failed", error: got && !got.ok ? got.error : "offline" },
          })),
        );
    },
    installNvidia: (accepted) => {
      const host = bridge();
      if (!host || nvidia.install.state === "running") return;
      setNvidia((n) => ({ ...n, install: { state: "running", done: 0, total: 0, stopping: false } }));
      void host
        .installNvidia(accepted)
        .catch(() => null)
        .then((done) => {
          // Installed or not, the rows show what is on the games drive now.
          setNvidia((n) => ({
            ...n,
            install: done?.ok
              ? { state: "idle" }
              : { state: "failed", error: done && !done.ok ? done.error : "write" },
          }));
          check();
        });
    },
    cancelNvidia: () => {
      setNvidia((n) =>
        n.install.state === "running" ? { ...n, install: { ...n.install, stopping: true } } : n,
      );
      void bridge()?.cancelNvidia();
    },
    removeNvidia: () => {
      void bridge()
        ?.removeNvidia()
        .catch(() => null)
        .then(() => {
          setNvidia(NVIDIA_IDLE);
          check();
        });
    },
  };
}
