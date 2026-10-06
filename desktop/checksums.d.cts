// Types for checksums.cjs, so the tests can use it.

export type Sum = { name: string; sha256: string };
export type Release = {
  host: { file: string; sha256: string; bytes: number; url: string | null } | null;
  image: { version: string; files: Sum[] } | null;
};

export function sumOf(file: string, files?: typeof import("node:fs")): Sum & { bytes: number };
export function sumsText(sums: Sum[]): string;
export function parseSums(text: string): Sum[];
export function flags(args: string[]): { _: string[] } & Record<string, string | string[]>;
export function releaseOf(options?: {
  host?: (Sum & { bytes: number }) | null;
  url?: string | null;
  image?: { version: string; files: Sum[] } | null;
}): Release;
export function imageSums(dir: string, files?: typeof import("node:fs")): { version: string; files: Sum[] };
