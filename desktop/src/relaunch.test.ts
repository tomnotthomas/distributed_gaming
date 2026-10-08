// @vitest-environment node
// Lanterel Host again after a restart it asked for (relaunch.cjs): this user's
// RunOnce entry opens it at the next sign-in, and a start after that restart
// clears what is left.

import { describe, expect, it, vi } from "vitest";
import {
  AFTER_RESTART,
  afterRestart,
  RUN_ONCE,
  VALUE,
  relaunchAtStart,
  relaunchCommand,
  relaunchStore,
  savedOf,
} from "../relaunch.cjs";

/** A file system in memory, as much of one as relaunch.cjs uses. */
function memoryFs() {
  const map = new Map<string, string>();
  return {
    map,
    readFileSync: (file: string) => {
      const data = map.get(file);
      if (data === undefined) throw new Error("ENOENT");
      return data;
    },
    writeFileSync: (file: string, data: string) => void map.set(file, data),
    mkdirSync: () => undefined,
    rmSync: (file: string) => void map.delete(file),
  } as unknown as typeof import("node:fs") & { map: Map<string, string> };
}

/** Windows' RunOnce for this user, as reg.exe sets and clears it. */
function registry() {
  const values = new Map<string, string>();
  const run = vi.fn(async (file: string, args: string[]) => {
    expect(file).toBe("reg.exe");
    const [verb, key, , name] = args;
    expect(key).toBe(RUN_ONCE);
    if (verb === "add") values.set(name!, args[args.indexOf("/d") + 1]!);
    else if (!values.delete(name!))
      throw new Error("ERROR: The system was unable to find the specified registry key or value.");
  });
  return { values, run };
}

describe("relaunching the app after its restart", () => {
  it("opens the exe the owner started, after the restart, quoted for Windows", () => {
    expect(relaunchCommand({ exe: String.raw`C:\Users\Jo Doe\Downloads\Lanterel Host 0.1.0.exe` })).toBe(
      String.raw`"C:\Users\Jo Doe\Downloads\Lanterel Host 0.1.0.exe" --after-restart`,
    );
    expect(AFTER_RESTART).toBe("--after-restart");
  });

  it("runs an unpackaged app from its folder, and carries a test build's remote debugging", () => {
    expect(
      relaunchCommand({
        exe: String.raw`C:\repo\node_modules\electron\dist\electron.exe`,
        appPath: String.raw`C:\my repo\desktop`,
        carry: ["--remote-debugging-port=9222"],
      }),
    ).toBe(
      String.raw`"C:\repo\node_modules\electron\dist\electron.exe" "C:\my repo\desktop" --after-restart --remote-debugging-port=9222`,
    );
  });

  it("sets this user's RunOnce entry and notes when, then clears both", async () => {
    const files = memoryFs();
    const reg = registry();
    const store = relaunchStore("/data", reg.run, files);
    expect(store.read()).toBeNull();
    await store.arm(`"C:\\Lanterel Host.exe" --after-restart`, 5000);
    expect(RUN_ONCE).toBe(String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce`);
    expect(reg.values.get(VALUE)).toBe(`"C:\\Lanterel Host.exe" --after-restart`);
    expect(reg.run).toHaveBeenCalledWith("reg.exe", [
      "add",
      RUN_ONCE,
      "/v",
      "LanterelHost",
      "/t",
      "REG_SZ",
      "/d",
      `"C:\\Lanterel Host.exe" --after-restart`,
      "/f",
    ]);
    expect(store.read()).toEqual({ at: 5000 });
    await store.clear();
    expect(reg.values.size).toBe(0);
    expect(store.read()).toBeNull();
  });

  it("clears its note when Windows already ran the entry and took it off", async () => {
    const files = memoryFs();
    const reg = registry();
    const store = relaunchStore("/data", reg.run, files);
    await store.arm("x", 5000);
    reg.values.clear(); // the sign-in after the restart ran it
    await expect(store.clear()).resolves.toBeUndefined();
    expect(store.read()).toBeNull();
  });

  it("keeps no note when Windows refuses the entry, and says so", async () => {
    const files = memoryFs();
    const store = relaunchStore(
      "/data",
      async () => {
        throw new Error("ERROR: Access is denied.");
      },
      files,
    );
    await expect(store.arm("x", 5000)).rejects.toThrow("Access is denied");
    expect(store.read()).toBeNull();
  });

  it("at start, keeps a relaunch whose restart is still ahead and clears one whose restart is behind", () => {
    const bootAt = 10_000;
    expect(relaunchAtStart(null, bootAt)).toBeNull();
    // Armed in this start: the app quit and opened again before the restart.
    expect(relaunchAtStart({ at: 12_000 }, bootAt)).toBe("keep");
    // Armed before this start: Windows opened the app, or the owner did first.
    expect(relaunchAtStart({ at: 8_000 }, bootAt)).toBe("clear");
  });

  it("opens after the restart only once that restart is behind, not at a sign-in before it", () => {
    // Windows ran the entry after the restart: the window opens at the step after it.
    expect(afterRestart(true, "clear")).toBe(true);
    // The owner signed out and in before restarting: Windows ran the entry early.
    expect(afterRestart(true, "keep")).toBe(false);
    // Opened with the flag but nothing noted (the note was never written): taken at its word.
    expect(afterRestart(true, null)).toBe(true);
    // The owner opened the app: never after a restart.
    expect(afterRestart(false, "clear")).toBe(false);
  });

  it("reads only a note it could have written", () => {
    expect(savedOf({ at: 5 })).toEqual({ at: 5 });
    expect(savedOf({ at: "5" })).toBeNull();
    expect(savedOf(null)).toBeNull();
  });
});
