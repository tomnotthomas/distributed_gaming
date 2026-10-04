// What the agent asks of the machine itself: restart it clean into rental mode,
// hand it back to the owner's Windows, and whether it meets the hardware floor.
//
// Rental mode is first in the firmware's BootOrder while the PC is shared, so a
// plain reboot comes back into rental mode, with the ephemeral scratch's key
// gone and RAM cleared. Going back to Windows puts Windows Boot Manager first
// and reboots (rental-mode report §5.1).

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FloorCheck, HardwareFloor } from "./config.ts";

export type System = {
  /** Restart into rental mode. */
  reboot(): Promise<void>;
  /** Put Windows first in the boot order and restart into it. */
  returnToWindows(): Promise<void>;
  /** The checks of the hardware floor this machine fails; empty when it meets it. */
  unmetFloor(): Promise<FloorCheck[]>;
};

/** Runs a command and resolves with its stdout. */
export type Run = (command: string, args: string[]) => Promise<string>;

const run: Run = async (command, args) => (await promisify(execFile)(command, args)).stdout;

/** The EFI global variable that says whether Secure Boot is enforcing. */
const SECURE_BOOT_VAR = "sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c";

/** The machine as it is, under `root` (tests point it at a directory of their own). */
export function linuxSystem(floor: HardwareFloor, root = "/", exec: Run = run): System {
  const at = (path: string) => join(root, path);
  const probes: Record<FloorCheck, () => Promise<boolean>> = {
    uefi: async () => exists(at("sys/firmware/efi")),
    // An efivar is 4 bytes of attributes, then its value: 1 when enforcing.
    secureBoot: async () => (await readFile(at(SECURE_BOOT_VAR)).catch(() => null))?.[4] === 1,
    tpm2: async () =>
      (await readFile(at("sys/class/tpm/tpm0/tpm_version_major"), "utf8").catch(() => "")).trim() === "2",
    iommu: async () => (await readdir(at("sys/class/iommu")).catch(() => [])).length > 0,
  };

  return {
    reboot: async () => {
      await exec("systemctl", ["reboot"]);
    },
    returnToWindows: async () => {
      const order = windowsFirst(await exec("efibootmgr", []));
      if (!order) throw new Error("no Windows Boot Manager entry in the firmware's boot entries");
      await exec("efibootmgr", ["--bootorder", order]);
      await exec("systemctl", ["reboot"]);
    },
    unmetFloor: async () => {
      const checks = (Object.keys(probes) as FloorCheck[]).filter((check) => floor[check]);
      const met = await Promise.all(checks.map((check) => probes[check]()));
      return checks.filter((_, i) => !met[i]);
    },
  };
}

/**
 * The BootOrder with Windows Boot Manager first and every other entry after it
 * in the order it had, from `efibootmgr`'s listing; null when there is no
 * Windows Boot Manager entry.
 *
 *   BootOrder: 0003,0000,0001
 *   Boot0000* Windows Boot Manager  HD(1,GPT,...)/File(\EFI\Microsoft\Boot\bootmgfw.efi)
 *   Boot0003* Swiff OS  ...
 *
 * gives 0000,0003,0001.
 */
export function windowsFirst(listing: string): string | null {
  const windows = /^Boot([0-9A-Fa-f]{4})\*?\s+Windows Boot Manager\b/m.exec(listing)?.[1];
  if (!windows) return null;
  const order = /^BootOrder:\s*([0-9A-Fa-f,]*)/m.exec(listing)?.[1]?.split(",").filter(Boolean) ?? [];
  return [windows, ...order.filter((entry) => entry.toUpperCase() !== windows.toUpperCase())].join(",");
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
