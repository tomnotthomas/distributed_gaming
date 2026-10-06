// Types for rental-cli.cjs, so its tests can use what it shows.

import type { PlanOp, RentalPlan } from "./rental.cjs";

/** A plan as the console's answer shows it: never with its key code. */
export function shown(p: RentalPlan): {
  kind: RentalPlan["kind"];
  target: RentalPlan["target"];
  steps: { id: string; title: string; confirm: string | null; commands: string[] }[];
};
/** The key code given with --code (8 digits); throws for a malformed one, or when `p` needs one and none was given. */
export function codeOf(opts: Record<string, unknown>, p?: RentalPlan | null): string | undefined;
export function unkeyed(ops: PlanOp[]): Record<string, unknown>[];
