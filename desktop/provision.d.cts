// Types for provision.cjs, so the tests can use it.

export type Provisioning = { serverUrl: string; machineId: string; machineKey: string };

export const RECORD_BYTES: number;
export const RECORD_MAGIC: Buffer;
export const RECORD_VERSION: number;
export function machineProblem(machine: { serverUrl: string; machineId: string }): string | null;
export function provisionRecord(provisioning: Provisioning): Buffer;
