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
      setPreview(null);
      check();
    },
    choose: (id) => {
      setTarget(id);
      setPreview(null);
    },
    plan: (kind) =>
      void bridge()
        ?.planRental({ kind, target })
        .catch(() => null)
        .then(setPreview),
    close: () => setPreview(null),
  };
}
