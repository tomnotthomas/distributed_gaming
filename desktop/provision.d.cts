// Types for provision.cjs, so the tests can use it.

export type Provisioning = { serverUrl: string; machineId: string; machineKey: string };

export const RECORD_BYTES: number;
export const RECORD_MAGIC: Buffer;
export const RECORD_VERSION: number;
export function machineProblem(machine: { serverUrl: string; machineId: string }): string | null;
export function machineKeyProblem(machineKey: unknown): string | null;
export function provisionRecord(provisioning: Provisioning): Buffer;
export function holdsRecord(block: Buffer): boolean;

export type ProvisionNote = { at: number; kind: string; done: boolean };
export type ProvisionStore = {
  read(): ProvisionNote | null;
  written(at: number, kind: string): void;
  finished(): void;
  forget(): void;
};
export function provisionStore(dir: string, files?: typeof import("node:fs")): ProvisionStore;
export function provisionEvent(
  store: ProvisionStore,
  plan: { kind: string },
  event: { type: string; id?: string; state?: string },
  at: number,
): void;
export function leftRecord(outcome: { status: string; done: string[]; failed?: { step: string } }): boolean;
export function fateOf(
  note: ProvisionNote,
  bootAt: number,
  trail?: { at: number; shim: boolean; loader: boolean; windowsAfterShim: boolean } | null,
): "wipe" | "wait" | "gone";
export function wipeRecord(
  apply: (op: { op: string }, progress: () => void) => Promise<unknown>,
  store: ProvisionStore,
): Promise<boolean>;
