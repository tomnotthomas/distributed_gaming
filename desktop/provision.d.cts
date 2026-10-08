// Types for provision.cjs, so the tests can use it.

export type Provisioning = { serverUrl: string; machineId: string; machineKey: string };

export const RECORD_BYTES: number;
export const RECORD_MAGIC: Buffer;
export const RECORD_VERSION: number;
export function machineProblem(machine: { serverUrl: string; machineId: string }): string | null;
export function machineKeyProblem(machineKey: unknown): string | null;
export function provisionRecord(provisioning: Provisioning): Buffer;
export function holdsRecord(block: Buffer): boolean;

export type ProvisionStore = { read(): number | null; written(at: number): void; forget(): void };
export function provisionStore(dir: string, files?: typeof import("node:fs")): ProvisionStore;
export function provisionEvent(
  store: ProvisionStore,
  event: { type: string; id?: string; state?: string },
  at: number,
): void;
export function leftRecord(outcome: { status: string; done: string[]; failed?: { step: string } }): boolean;
export function abandoned(
  at: number | null,
  bootAt: number,
  trail?: { at: number; shim: boolean; loader: boolean; windowsAfterShim: boolean } | null,
): boolean;
export function wipeRecord(
  apply: (op: { op: string }, progress: () => void) => Promise<unknown>,
  store: ProvisionStore,
): Promise<boolean>;
