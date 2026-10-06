// Types for gpt.cjs, so its tests can use it.

export class GptError extends Error {}

export type GptEntry = {
  /** The slot in the entry array, from 0. */
  index: number;
  type: string;
  id: string;
  first: number;
  last: number;
  attrs: bigint;
  name: string;
};

export type Gpt = {
  sectorSize: number;
  diskBytes: number;
  diskId: string;
  firstUsable: number;
  lastUsable: number;
  entriesLba: number;
  count: number;
  entries: GptEntry[];
};

export type Write = { offset: number; bytes: Buffer };

export function crc32(bytes: Uint8Array): number;
export function guidBytes(text: string): Buffer;
export function guidText(bytes: Uint8Array): string;
export function readGpt(
  read: (offset: number, length: number) => Buffer,
  options: { diskBytes: number; sectorSize?: number },
): Gpt;
export function emptyGpt(options: { diskBytes: number; sectorSize?: number; diskId: string }): Gpt;
export function withPartitions(
  gpt: Gpt,
  adds: { type: string; id: string; name: string; first: number; last: number; attrs?: bigint }[],
): Gpt;
export function withResized(gpt: Gpt, index: number, last: number): Gpt;
export function withRemoved(gpt: Gpt, indexes: number[]): Gpt;
export function withRetyped(gpt: Gpt, index: number, type: string): Gpt;
export function gptWrites(gpt: Gpt, options?: { mbr?: boolean }): Write[];
