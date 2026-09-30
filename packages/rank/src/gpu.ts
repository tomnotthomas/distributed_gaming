// GPU name → score, RTX 3060 = 100. See README.md for where the numbers come from.

import table from "./gpu-scores.json";

/**
 * Reduce a reported GPU name to the table's spelling: vendor words and
 * suffixes dropped, case and spacing ignored, so "NVIDIA GeForce RTX 4090"
 * and "rtx 4090" land on the same row.
 */
export function normalizeGpu(name: string): string {
  return name
    .toUpperCase()
    .replace(/\((R|TM)\)/g, " ")
    .replace(/\b(NVIDIA|GEFORCE|AMD|RADEON|GRAPHICS)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SCORES = new Map<string, number>(
  Object.entries(table as Record<string, number>).map(([name, score]) => [normalizeGpu(name), score]),
);

/** A GPU's score, or 0 when it is not in the table: unknown fails E3 rather than guessing. */
export function gpuScore(name: string): number {
  return SCORES.get(normalizeGpu(name)) ?? 0;
}
