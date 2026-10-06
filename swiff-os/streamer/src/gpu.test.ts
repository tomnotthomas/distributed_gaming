import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasNvidia, readGpus } from "./gpu";

/** A fake /sys with the given DRM cards: their PCI vendor and bound driver. */
function fakeSysfs(cards: Record<string, { vendor: string; driver?: string }>, extra: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "swiff-gpu-"));
  const drm = join(root, "class", "drm");
  mkdirSync(drm, { recursive: true });
  for (const [name, card] of Object.entries(cards)) {
    const device = join(drm, name, "device");
    mkdirSync(device, { recursive: true });
    writeFileSync(join(device, "vendor"), `${card.vendor}\n`);
    if (card.driver) symlinkSync(`../../../bus/pci/drivers/${card.driver}`, join(device, "driver"));
  }
  // Connectors (card0-DP-1) and render nodes are not cards.
  for (const name of extra) mkdirSync(join(drm, name), { recursive: true });
  roots.push(root);
  return root;
}
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readGpus", () => {
  it("reads each card's vendor and driver, and nothing that is not a card", () => {
    const sysfs = fakeSysfs(
      { card1: { vendor: "0x10de", driver: "nvidia" }, card0: { vendor: "0x8086", driver: "i915" } },
      ["card0-DP-1", "renderD128", "version"],
    );
    expect(readGpus(sysfs)).toEqual([
      { vendor: "intel", driver: "i915" },
      { vendor: "nvidia", driver: "nvidia" },
    ]);
  });

  it("knows AMD, and calls any other maker other", () => {
    const sysfs = fakeSysfs({
      card0: { vendor: "0x1002", driver: "amdgpu" },
      card1: { vendor: "0x1af4", driver: "virtio-pci" },
    });
    expect(readGpus(sysfs)).toEqual([
      { vendor: "amd", driver: "amdgpu" },
      { vendor: "other", driver: "virtio-pci" },
    ]);
  });

  it("says when no driver is bound to a card", () => {
    expect(readGpus(fakeSysfs({ card0: { vendor: "0x10de" } }))).toEqual([
      { vendor: "nvidia", driver: null },
    ]);
  });

  it("reads no cards where sysfs has none, rather than failing", () => {
    expect(readGpus(join(tmpdir(), "swiff-no-such-sysfs"))).toEqual([]);
  });
});

describe("hasNvidia", () => {
  it("is an NVIDIA card run by NVIDIA's driver, not nouveau or none", () => {
    expect(hasNvidia([{ vendor: "nvidia", driver: "nvidia" }])).toBe(true);
    expect(hasNvidia([{ vendor: "nvidia", driver: "nouveau" }])).toBe(false);
    expect(hasNvidia([{ vendor: "nvidia", driver: null }])).toBe(false);
    expect(hasNvidia([{ vendor: "amd", driver: "amdgpu" }])).toBe(false);
  });
});
