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
/** What a provision op hands Swiff OS from --server, --machine-id and --machine-key-file; throws without them. */
export function provisioningOf(
  opts: Record<string, unknown>,
  files?: { readFileSync(path: string, encoding: "utf8"): string },
): { serverUrl: string; machineId: string; machineKey: string };
/** What wraps a worker's apply so a provision op gets its record, read now; throws when a provision in `steps` lacks it. */
export function provisioned(
  opts: Record<string, unknown>,
  steps: RentalPlan["steps"],
  files?: { readFileSync(path: string, encoding: "utf8"): string },
): (
  apply: (op: PlanOp, progress?: unknown) => Promise<unknown>,
) => (op: PlanOp, progress?: unknown) => Promise<unknown>;
