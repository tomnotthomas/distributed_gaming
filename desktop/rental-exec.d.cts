// Types for rental-exec.cjs, so the main process's callers and the tests can use it.

import type { PlanOp, PlanStep, RentalPlan } from "./rental.cjs";

export type Progress = { what: string; done: number; total: number };
export type Apply = (op: PlanOp, progress?: (p: Progress) => void) => Promise<Record<string, unknown>>;
export type RunEvent =
  | { type: "step"; id: string; state: "confirm" | "running" | "done" | "failed" | "stopped"; error?: string }
  | ({ type: "progress"; id: string } & Progress);
export type RunOutcome = {
  status: "done" | "failed" | "stopped";
  done: string[];
  failed?: { step: string; op: string; error: string };
  stoppedAt?: string;
  results: Record<string, unknown>[];
};
export type WorkerClient = { apply: Apply; close(): void };
export type Channel = {
  socket: import("node:net").Socket;
  send(msg: unknown): void;
  listen(fn: ((msg: any) => void) | null): void;
};

export function runPlan(
  plan: RentalPlan,
  options: {
    apply: Apply;
    confirm?: (step: PlanStep) => Promise<boolean>;
    onEvent?: (event: RunEvent) => void;
    only?: string[] | null;
  },
): Promise<RunOutcome>;
export function dryRun(): WorkerClient & { ops: PlanOp[] };
export function isElevated(): Promise<boolean>;
export function winArg(arg: string): string;
export function launchElevated(command: { file: string; args: string[] }): Promise<void>;
export function handshake(
  socket: import("node:net").Socket,
  token: string,
  side: "app" | "worker",
): Promise<Channel>;
export function channelOf(
  socket: import("node:net").Socket,
  key: Buffer,
  side: "app" | "worker",
  buffered?: string,
): Channel;
export function startWorker(options: {
  imageDir: string;
  command: (pipe: string, token: string, imageDir: string) => { file: string; args: string[] };
  launch?: (command: { file: string; args: string[] }) => Promise<void>;
  timeout?: number;
  pipe?: string;
}): Promise<WorkerClient>;
export function clientOf(channel: Channel): WorkerClient;
