// @vitest-environment node
// Swiff's key, as far as the app can know it (rental-key.cjs): Windows cannot
// read whether MokManager enrolled it, so the app remembers what it queued and
// when, reads this start's measured-boot log for a blue screen that fell
// through into Windows, and otherwise asks the owner.

import { describe, expect, it } from "vitest";
import { bootTrail, keyOf, keyStore, savedOf } from "../rental-key.cjs";

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

/** A TCG log's bytes with these UTF-16 device paths in it, `shift` bytes off the even alignment. */
const log = (paths: string[], shift = 0) =>
  Buffer.concat([
    Buffer.alloc(shift),
    ...paths.map((p) => Buffer.concat([Buffer.from(p, "utf16le"), Buffer.alloc(8)])),
  ]);

describe("Swiff's key, as the app knows it", () => {
  const queued = { code: "48217730", queuedAt: 1000, answer: null };

  it("waits for the restart while the request is newer than this start, with its code", () => {
    expect(keyOf(queued, 500)).toEqual({ state: "queued", code: "48217730" });
  });

  it("asks the owner once the PC has restarted, when the boot log shows nothing", () => {
    expect(keyOf(queued, 2000)).toEqual({ state: "ask", code: null });
    expect(keyOf(queued, 2000, { at: 2500, shim: false, mokManager: 0, mokList: false })).toEqual({
      state: "ask",
      code: null,
    });
  });

  it("takes the owner's word over anything else", () => {
    expect(keyOf({ code: null, queuedAt: null, answer: "yes" }, 0)).toEqual({
      state: "confirmed",
      code: null,
    });
    expect(keyOf({ code: null, queuedAt: null, answer: "no" }, 0)).toEqual({ state: "missed", code: null });
  });

  it("reads a fall-through into Windows from this start's log: timed out, no key, or refused", () => {
    const after = (trail: { shim: boolean; mokManager: number; mokList: boolean }) =>
      keyOf(queued, 2000, { at: 2500, ...trail });
    // The 10 seconds passed, then shim fell back to MokManager again and on into Windows.
    expect(after({ shim: true, mokManager: 2, mokList: true })?.state).toBe("timedout");
    expect(after({ shim: true, mokManager: 1, mokList: true })?.state).toBe("nokey");
    // shim never measured its MOK list: the firmware refused to start it.
    expect(after({ shim: true, mokManager: 0, mokList: false })?.state).toBe("blocked");
    // A log older than the request says nothing about it.
    expect(keyOf(queued, 2000, { at: 900, shim: true, mokManager: 2, mokList: true })?.state).toBe("ask");
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
  it("finds Swiff's shim and counts MokManager in the newest log, in any case and at either alignment", () => {
    const files = memoryFs(
      {
        "/mb/1.log": log(["\\EFI\\Microsoft\\Boot\\bootmgfw.efi"]),
        "/mb/2.log": log(
          [
            "HD(5)/\\EFI\\SWIFF\\SHIMX64.EFI",
            "MokList",
            "\\EFI\\swiff\\mmx64.efi",
            "\\EFI\\SWIFF\\MMX64.EFI",
          ],
          1,
        ),
        "/mb/notes.txt": "mmx64.efi",
      },
      { "/mb/1.log": 1, "/mb/2.log": 2, "/mb/notes.txt": 3 },
    );
    expect(bootTrail("/mb", files)).toEqual({ at: 2, shim: true, mokManager: 2, mokList: true });
  });

  it("sees a clean start as one, and no log as nothing to say", () => {
    const files = memoryFs(
      { "/mb/1.log": log(["\\EFI\\Microsoft\\Boot\\bootmgfw.efi"]) },
      { "/mb/1.log": 5 },
    );
    expect(bootTrail("/mb", files)).toEqual({ at: 5, shim: false, mokManager: 0, mokList: false });
    expect(bootTrail("/none", memoryFs())).toBeNull();
  });
});
