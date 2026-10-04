import { useCallback, useEffect, useRef, useState } from "react";
import type { RentalPlan, RentalRead } from "../rental.cjs";
import { bridge } from "./bridge";
import type { RentalSetup } from "./model";

/**
 * Rental mode on this PC, read through main (rental.cjs) once on opening and
 * again when the owner asks: after a trip to the BIOS, say. Plans come back
 * as previews; nothing here changes the PC.
 */
export function useRental(): RentalSetup & {
  check(): void;
  choose(id: string): void;
  plan(kind: RentalPlan["kind"]): void;
  close(): void;
} {
  const [read, setRead] = useState<RentalRead | null>(null);
  const [reading, setReading] = useState(true);
  const [target, setTarget] = useState<string | null>(null);
  const [preview, setPreview] = useState<RentalPlan | null>(null);
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
  };
}
