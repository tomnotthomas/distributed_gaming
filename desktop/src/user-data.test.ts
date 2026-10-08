// @vitest-environment node
// Lanterel Host's own user data (user-data.cjs): its own folder, so an old
// Swiff Host's single-instance lock never takes its launch, and a one-time
// copy of what Swiff Host kept in %APPDATA%\@swiff\desktop.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fateOf, provisionStore, wipesAtStart } from "../provision.cjs";
import { KEPT, moveUserData, userDataOf } from "../user-data.cjs";

let appData = "";
let where = { dir: "", old: "" };
beforeEach(() => {
  appData = fs.mkdtempSync(path.join(os.tmpdir(), "user-data-"));
  where = userDataOf(appData);
});
afterEach(() => fs.rmSync(appData, { recursive: true, force: true }));

/** Write `text` to `name` under `dir`. */
const put = (dir: string, name: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
};
const read = (dir: string, name: string) => fs.readFileSync(path.join(dir, name), "utf8");
const has = (dir: string, name: string) => fs.existsSync(path.join(dir, name));

describe("userDataOf", () => {
  it("is Lanterel Host's own folder, apart from Swiff Host's", () => {
    expect(userDataOf("C:\\Users\\a\\AppData\\Roaming")).toEqual({
      dir: path.join("C:\\Users\\a\\AppData\\Roaming", "Lanterel Host"),
      old: path.join("C:\\Users\\a\\AppData\\Roaming", "@swiff", "desktop"),
    });
  });
});

describe("moveUserData", () => {
  it("copies what the app keeps, leaves the rest and the old folder as they were", () => {
    put(where.old, "machine-key.bin", "sealed");
    put(where.old, "Local State", "{}");
    put(where.old, "Local Storage/leveldb/000003.log", "settings");
    put(where.old, "Local Storage/leveldb/LOCK", "");
    put(where.old, "rental-provision.json", '{"at":1,"done":false}\n');
    put(where.old, "rental-reports/r1.json", "{}");
    put(where.old, "Cache/data_0", "x");
    expect(moveUserData(where)).toBe(true);
    expect(read(where.dir, "machine-key.bin")).toBe("sealed");
    expect(read(where.dir, "Local State")).toBe("{}");
    expect(read(where.dir, "Local Storage/leveldb/000003.log")).toBe("settings");
    expect(read(where.dir, "rental-reports/r1.json")).toBe("{}");
    expect(has(where.dir, "Local Storage/leveldb/LOCK")).toBe(false);
    expect(has(where.dir, "Cache")).toBe(false);
    expect(read(where.old, "machine-key.bin")).toBe("sealed");
    expect(KEPT).toContain("swiff-os");
  });

  it("links the image set's finished files and leaves its unfinished parts", () => {
    put(where.old, "swiff-os/swiffos.json", "{}");
    put(where.old, "swiff-os/swiffos_0.1.0.esp.raw", "esp");
    put(where.old, "swiff-os/.download/root.gz.000", "part");
    moveUserData(where);
    const from = fs.statSync(path.join(where.old, "swiff-os/swiffos_0.1.0.esp.raw"));
    const to = fs.statSync(path.join(where.dir, "swiff-os/swiffos_0.1.0.esp.raw"));
    expect(to.ino).toBe(from.ino);
    expect(read(where.dir, "swiff-os/swiffos.json")).toBe("{}");
    expect(has(where.dir, "swiff-os/.download")).toBe(false);
  });

  it("runs once: a key or note the app wiped since never comes back", () => {
    put(where.old, "machine-key.bin", "sealed");
    put(where.old, "rental-provision.json", '{"at":1,"done":false}\n');
    expect(moveUserData(where)).toBe(true);
    // The record was wiped (provision.cjs wipeRecord) and the key cleared (machine-key:save "").
    provisionStore(where.dir).forget();
    fs.rmSync(path.join(where.dir, "machine-key.bin"));
    expect(moveUserData(where)).toBe(false);
    expect(provisionStore(where.dir).read()).toBe(null);
    expect(has(where.dir, "machine-key.bin")).toBe(false);
  });

  it("carries a left-behind provisioning note over, so the next start still wipes it", () => {
    provisionStore(where.old).written(5);
    moveUserData(where);
    const note = provisionStore(where.dir).read();
    expect(note).toEqual({ at: 5, done: false });
    expect(wipesAtStart(fateOf(note!, 10))).toBe(true);
  });

  it("keeps what the new folder already has", () => {
    put(where.old, "error-reports.json", "old");
    put(where.dir, "error-reports.json", "new");
    moveUserData(where);
    expect(read(where.dir, "error-reports.json")).toBe("new");
  });

  it("with no Swiff Host before it, starts afresh", () => {
    expect(moveUserData(where)).toBe(true);
    expect(fs.readdirSync(where.dir)).toEqual(["moved-from-swiff-host"]);
    expect(has(where.old, "")).toBe(false);
  });
});
