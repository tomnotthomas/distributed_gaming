// @vitest-environment node
// What the firmware did before this Windows start, from Windows' copy of the
// TPM's event log (measured-boot.cjs): the Secure Boot db, read without a trip
// to the BIOS, and which EFI programs ran, in order.

import { describe, expect, it } from "vitest";
import { dbTrusts, parseLog, trailOf } from "../measured-boot.cjs";
import { SHIM_CA } from "../rental.cjs";
import { bootVariable, db, LOADER, MOK_MANAGER, SHIM, started, tcgLog, WINDOWS } from "./test/tcgLog";

const events = (...e: Parameters<typeof tcgLog>[0]) => parseLog(tcgLog(e));

describe("the measured-boot log", () => {
  it("reads every event of a crypto-agile log, and stops at a torn one", () => {
    const log = tcgLog([started(WINDOWS), db(SHIM_CA)]);
    expect(parseLog(log)).toHaveLength(3);
    expect(parseLog(log.subarray(0, log.length - 3))).toHaveLength(2);
    expect(parseLog(Buffer.alloc(0))).toEqual([]);
  });

  it("reads the Secure Boot db the firmware measured: the CA that signs shim, or not", () => {
    expect(dbTrusts(events(db("Microsoft Windows Production PCA 2011", SHIM_CA)), SHIM_CA)).toBe(true);
    // A Secured-core PC that leaves out the 3rd-party CA.
    expect(dbTrusts(events(db("Windows UEFI CA 2023")), SHIM_CA)).toBe(false);
    expect(dbTrusts(events(started(WINDOWS)), SHIM_CA)).toBeNull();
  });

  it("does not take Swiff OS's boot entry for shim having run: the firmware measures every Boot####", () => {
    // The GEEKOM after its key restart: a clean start into Windows, with Swiff OS's entry in the menu.
    const trail = trailOf(events(bootVariable(1, "Swiff OS", SHIM), started(WINDOWS)));
    expect(trail).toMatchObject({ shim: false, mokManager: 0, loader: false, windowsAfterShim: false });
  });

  it("sees shim fall through into Windows in the same power-on, after MokManager, without the key", () => {
    // The GEEKOM's 15:47 restart: MokManager twice, Continue boot, Windows.
    const trail = trailOf(
      events(started(SHIM), started(MOK_MANAGER), started(MOK_MANAGER), started(WINDOWS)),
    );
    expect(trail).toMatchObject({ shim: true, mokManager: 2, loader: false, windowsAfterShim: true });
  });

  it("sees shim start Swiff's own boot loader, which it does only with the key enrolled", () => {
    const trail = trailOf(events(started(SHIM), started(LOADER), started(WINDOWS)));
    expect(trail).toMatchObject({ shim: true, loader: true });
    // Paths in any case, as firmware rewrites them.
    expect(trailOf(events(started("\\EFI\\SWIFF\\SHIMX64.EFI"))).shim).toBe(true);
  });
});
