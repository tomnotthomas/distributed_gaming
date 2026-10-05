// Types for rental-cli.cjs, so its tests can use what it shows.

import type { PlanOp, RentalPlan } from "./rental.cjs";

export function shown(
  p: RentalPlan,
  codeFile?: string | null,
  files?: Pick<typeof import("node:fs"), "writeFileSync">,
): {
  kind: RentalPlan["kind"];
  target: RentalPlan["target"];
  mok?: { codeFile: string | null };
  steps: { id: string; title: string; confirm: string | null; commands: string[] }[];
};
export function unkeyed(ops: PlanOp[]): Record<string, unknown>[];
