// Types for efi.cjs, so the installer's tests can use it.

export const GLOBAL: string;
export const SHIM_LOCK: string;
export const CERT_X509: string;
export const NV_BS_RT: number;
export function guidBytes(guid: string): Buffer;
export function guidText(bytes: Uint8Array): string;
export function bootName(index: number): string;
export function bootIndex(name: string): number | null;
export function loadOption(option: {
  title: string;
  partition: { number: number; first: number; sectors: number; id: string };
  path: string;
}): Buffer;
export function parseLoadOption(
  bytes: Uint8Array,
): { active: boolean; title: string; partition: string | null; file: string | null } | null;
export function orderBytes(indexes: number[]): Buffer;
export function orderOf(bytes: Uint8Array | null | undefined): number[];
export function placeIn(order: number[], index: number, where: "first" | "last"): number[];
export function certList(cert: Uint8Array): Buffer;
export function mokVariables(
  cert: Uint8Array,
  code: string,
  options?: { remove?: boolean },
): Record<string, Buffer>;
export function mokListHas(list: Uint8Array | null | undefined, cert: Uint8Array): boolean;
