// Types for provision.cjs, so the tests can use it.

export type Provisioning = { serverUrl: string; machineId: string; machineKey: string };

export const RECORD_BYTES: number;
export const RECORD_MAGIC: Buffer;
export const RECORD_VERSION: number;
export function machineProblem(machine: { serverUrl: string; machineId: string }): string | null;
export function machineKeyProblem(machineKey: unknown): string | null;
/** What tpm-seal.cjs sealKey makes of a key: the sealed object's TPMT_PUBLIC and TPM2B_PRIVATE contents. */
export type Sealed = { public: Buffer; private: Buffer };
export function provisionRecord(
  provisioning: Provisioning,
  seal: (key: Buffer) => Promise<Sealed>,
): Promise<Buffer>;
export function holdsRecord(block: Buffer): boolean;

export type ProvisionNote = { at: number; done: boolean };
export type ProvisionStore = {
  read(): ProvisionNote | null;
  written(at: number): void;
  finished(): void;
  forget(): void;
};
export function provisionStore(dir: string, files?: typeof import("node:fs")): ProvisionStore;
export function provisionEvent(
  store: ProvisionStore,
  event: { type: string; id?: string; state?: string },
  at: number,
): void;
export function leftRecord(outcome: { status: string; done: string[]; failed?: { step: string } }): boolean;
export function fateOf(
  note: ProvisionNote,
  bootAt: number,
  trail?: { at: number; shim: boolean; loader: boolean; windowsAfterShim: boolean } | null,
): "wipe" | "wait" | "gone";
export function wipesAtStart(fate: "wipe" | "wait" | "gone"): boolean;
export function wipeRecord(
  apply: (op: { op: string }, progress: () => void) => Promise<unknown>,
  store: ProvisionStore,
): Promise<boolean>;
