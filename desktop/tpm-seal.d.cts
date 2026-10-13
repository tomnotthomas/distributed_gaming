// Types for tpm-seal.cjs, so the tests can use it.

import type { KeyObject } from "node:crypto";
import type { Sealed } from "./provision.cjs";

/** One command in, its response out. */
export type Transport = { send(command: Buffer): Promise<Buffer> };
/** A reader over a response's parameters. */
export type Reader = { bytes(n: number): Buffer; u16(): number; u32(): number; b2(): Buffer };

export const SRK_HANDLE: number;
export function b2(data: Buffer): Buffer;
export function run(
  transport: Transport,
  code: number,
  options?: { handles?: number[]; auth?: boolean; params?: Buffer },
): Promise<Reader>;
export function signingKey(key: KeyObject | string | Buffer): { public: Buffer; name: Buffer };
export function sealPolicy(key: KeyObject | string | Buffer): Buffer;
export function sealKey(transport: Transport, policy: Buffer, key: Buffer): Promise<Sealed>;
