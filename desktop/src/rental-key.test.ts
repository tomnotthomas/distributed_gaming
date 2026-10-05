// @vitest-environment node
// Swiff's key, as far as the app can know it (rental-key.cjs): Windows cannot
// read whether MokManager enrolled it, so the app remembers what it queued and
// when, reads this start's measured-boot log for shim starting Swiff's boot
// loader (the key works) or falling through into Windows (it does not), and
// otherwise asks the owner.

import { describe, expect, it } from "vitest";
import { bootTrail, keyOf, keyStore, savedOf } from "../rental-key.cjs";
import { bootVariable, MOK_MANAGER, SHIM, started, tcgLog, WINDOWS } from "./test/tcgLog";

/** A boot trail: what one power-on started, at `at`. */
const trail = (
  at: number,
  more: Partial<{ shim: boolean; mokManager: number; loader: boolean; windowsAfterShim: boolean }> = {},
) => ({
  at,
  apps: [],
  shim: false,
  mokManager: 0,
  loader: false,
  windowsAfterShim: false,
  ...more,
});

/** A file system in memory, as much of one as rental-key.cjs uses. */
function memoryFs(files: Record<string, Buffer | string> = {}, times: Record<string, number> = {}) {
  const map = new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
  return {
    map,
    readFileSync: (file: string, encoding?: string) => {
      const data = map.get(file);
      if (!data) throw new Error("ENOENT");
      return encoding ? data.toString() : data;
    },
    writeFileSync: (file: string, data: string) => void map.set(file, Buffer.from(data)),
    mkdirSync: () => undefined,
    rmSync: (file: string) => void map.delete(file),
    readdirSync: (dir: string) =>
      [...map.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    statSync: (file: string) => ({ mtimeMs: times[file] ?? 0 }),
  } as unknown as typeof import("node:fs") & { map: Map<string, Buffer> };
}

describe("Swiff's key, as the app knows it", () => {
  const queued = { code: "48217730", queuedAt: 1000, answer: null };

  it("waits for the restart while the request is newer than this start, with its code", () => {
    expect(keyOf(queued, 500)).toEqual({ state: "queued", code: "48217730" });
  });

  it("asks the owner once the PC has restarted, when the boot log shows nothing", () => {
    expect(keyOf(queued, 2000)).toEqual({ state: "ask", code: null });
    expect(keyOf(queued, 2000, trail(2500))).toEqual({ state: "ask", code: null });
  });

  it("takes the owner's word over anything else", () => {
    expect(keyOf({ code: null, queuedAt: null, answer: "yes" }, 0)).toEqual({
      state: "confirmed",
      code: null,
    });
    expect(keyOf({ code: null, queuedAt: null, answer: "no" }, 0)).toEqual({ state: "missed", code: null });
  });

  it("reads from this start's log whether the key works: shim started Swiff's loader, or fell into Windows", () => {
    // MokManager, then Continue boot without the key: Windows in the same power-on.
    expect(
      keyOf(queued, 2000, trail(2500, { shim: true, mokManager: 2, windowsAfterShim: true }))?.state,
    ).toBe("nokey");
    // shim started Swiff's own systemd-boot: only an enrolled key lets it.
    expect(keyOf(queued, 2000, trail(2500, { shim: true, loader: true }))?.state).toBe("confirmed");
    // A clean restart (MokManager's Reboot) leaves nothing in the log: the owner is asked.
    expect(keyOf(queued, 2000, trail(2500))?.state).toBe("ask");
    // A log older than the request says nothing about it.
    expect(
      keyOf(queued, 2000, trail(900, { shim: true, mokManager: 2, windowsAfterShim: true }))?.state,
    ).toBe("ask");
  });

  it("knows nothing when nothing was saved, and drops what is malformed", () => {
    expect(keyOf(null, 0)).toBeNull();
    expect(savedOf({ code: "1234", queuedAt: 5, answer: null })).toBeNull();
    expect(savedOf({ code: "48217730", queuedAt: "soon", answer: "maybe" })).toEqual({
      code: "48217730",
      queuedAt: null,
      answer: null,
    });
    expect(savedOf("garbage")).toBeNull();
  });
});

describe("the key's file", () => {
  it("keeps the queued code, then the owner's answer, and forgets both", () => {
    const files = memoryFs();
    const store = keyStore("/data", files);
    expect(store.read()).toBeNull();
    store.queued("48217730", 1000);
    expect(store.read()).toEqual({ code: "48217730", queuedAt: 1000, answer: null });
    store.answer(true);
    expect(store.read()).toEqual({ code: null, queuedAt: null, answer: "yes" });
    // The answer replaces the code: it is used up.
    expect(files.map.get("/data/rental-key.json")!.toString()).not.toContain("48217730");
    store.forget();
    expect(store.read()).toBeNull();
  });
});

describe("this start's measured-boot log", () => {
  it("reads the newest log in the folder, and only .log files", () => {
    const files = memoryFs(
      {
        "/mb/1.log": tcgLog([started(WINDOWS)]),
        "/mb/2.log": tcgLog([started(SHIM), started(MOK_MANAGER), started(MOK_MANAGER), started(WINDOWS)]),
        "/mb/notes.txt": "mmx64.efi",
      },
      { "/mb/1.log": 1, "/mb/2.log": 2, "/mb/notes.txt": 3 },
    );
    expect(bootTrail("/mb", files)).toMatchObject({
      at: 2,
      shim: true,
      mokManager: 2,
      windowsAfterShim: true,
    });
  });

  it("sees a clean start as one, Swiff OS's boot entry and all, and no log as nothing to say", () => {
    const files = memoryFs(
      { "/mb/1.log": tcgLog([bootVariable(1, "Swiff OS", SHIM), started(WINDOWS)]) },
      { "/mb/1.log": 5 },
    );
    expect(bootTrail("/mb", files)).toMatchObject({ at: 5, shim: false, mokManager: 0, loader: false });
    expect(bootTrail("/none", memoryFs())).toBeNull();
  });
});
