// The PC's graphics cards, read from sysfs, so the streamer tries the encoder
// that belongs to the card first: NVENC on an NVIDIA card that NVIDIA's own
// driver runs, VA-API on AMD and Intel.

import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";

export type GpuVendor = "nvidia" | "amd" | "intel" | "other";

/** One DRM card: who made it, and the kernel driver bound to it (null: none). */
export type Gpu = { vendor: GpuVendor; driver: string | null };

const VENDORS: Record<string, GpuVendor> = { "0x10de": "nvidia", "0x1002": "amd", "0x8086": "intel" };

/** The DRM cards under `sysfs` (/sys/class/drm/card<n>); none where it cannot be read. */
export function readGpus(sysfs = "/sys"): Gpu[] {
  const drm = join(sysfs, "class", "drm");
  let names: string[];
  try {
    names = readdirSync(drm);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^card\d+$/.test(name))
    .sort()
    .flatMap((name) => {
      const device = join(drm, name, "device");
      let vendor: GpuVendor;
      try {
        vendor = VENDORS[readFileSync(join(device, "vendor"), "utf8").trim().toLowerCase()] ?? "other";
      } catch {
        return [];
      }
      let driver: string | null = null;
      try {
        driver = basename(readlinkSync(join(device, "driver")));
      } catch {
        // No driver bound to the card.
      }
      return [{ vendor, driver }];
    });
}

/** An NVIDIA card that NVIDIA's driver runs, so NVENC is there (nouveau and nova have none). */
export const hasNvidia = (gpus: readonly Gpu[]): boolean =>
  gpus.some((g) => g.vendor === "nvidia" && g.driver === "nvidia");
