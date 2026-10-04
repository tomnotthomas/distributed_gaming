// @vitest-environment node
// Getting this PC ready to host, in the main process: Steam's state read from
// its registry keys and files, its installs and their progress, and Valve's
// installer fetched and kept only when Valve signed it.

import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  activeProcessFromReg,
  downloadSteamInstaller,
  isValveSignature,
  manifestInstall,
  MAX_INSTALLER_BYTES,
  openSteamInstaller,
  readInstalls,
  readSteam,
  readSteamStatus,
  signedByValve,
  STEAM_INSTALLER_URL,
} from "../steam.cjs";

/** An appmanifest as Steam writes one, with the fields given. */
const acf = (fields: Record<string, string | number>) =>
  `"AppState"\n{\n${Object.entries(fields)
    .map(([k, v]) => `\t"${k}"\t\t"${v}"`)
    .join("\n")}\n}\n`;

/** A disk of `files` (path → text), read the way pc.cjs and steam.cjs read one. */
function disk(files: Record<string, string>) {
  return {
    readFileSync(file: string) {
      if (!(file in files)) throw new Error(`ENOENT ${file}`);
      return files[file]!;
    },
    readdirSync(dir: string) {
      const names = Object.keys(files)
        .filter((f) => path.dirname(f) === dir)
        .map((f) => path.basename(f));
      if (!names.length) throw new Error(`ENOENT ${dir}`);
      return names;
    },
    existsSync: (file: string) => file in files,
  };
}

describe("manifestInstall", () => {
  it("is null for an installed game", () => {
    expect(manifestInstall(acf({ appid: 730, name: "Counter-Strike 2", StateFlags: 4 }))).toBeNull();
    // Installed with an update waiting is still installed.
    expect(manifestInstall(acf({ appid: 730, name: "Counter-Strike 2", StateFlags: 6 }))).toBeNull();
  });

  it("reads a download's bytes done of all it needs", () => {
    const install = manifestInstall(
      acf({
        appid: 570,
        name: "Dota 2",
        StateFlags: 1026 + 1048576,
        BytesToDownload: 40_000_000_000,
        BytesDownloaded: 10_000_000_000,
        BytesToStage: 50_000_000_000,
        BytesStaged: 0,
      }),
    );
    expect(install).toEqual({
      appid: 570,
      name: "Dota 2",
      phase: "downloading",
      done: 10_000_000_000,
      total: 40_000_000_000,
    });
  });

  it("reads the staged bytes while Steam stages or commits the download", () => {
    const install = manifestInstall(
      acf({
        appid: 570,
        name: "Dota 2",
        StateFlags: 1026 + 2097152,
        BytesToDownload: 40,
        BytesDownloaded: 40,
        BytesToStage: 50,
        BytesStaged: 25,
      }),
    );
    expect(install).toMatchObject({ phase: "finishing", done: 25, total: 50 });
  });

  it("tells a paused or queued install, and knows no size before Steam does", () => {
    expect(manifestInstall(acf({ appid: 570, name: "Dota 2", StateFlags: 1026 + 512 }))).toMatchObject({
      phase: "paused",
    });
    expect(manifestInstall(acf({ appid: 570, name: "Dota 2", StateFlags: 1026 }))).toEqual({
      appid: 570,
      name: "Dota 2",
      phase: "queued",
      done: 0,
      total: 0,
    });
  });

  it("never reports more done than there is", () => {
    const install = manifestInstall(
      acf({ appid: 570, name: "Dota 2", StateFlags: 1048576, BytesToDownload: 10, BytesDownloaded: 12 }),
    );
    expect(install).toMatchObject({ done: 10, total: 10 });
  });

  it("is null for a file that is not a manifest", () => {
    expect(manifestInstall("")).toBeNull();
    expect(manifestInstall(acf({ appid: 0, name: "x", StateFlags: 2 }))).toBeNull();
    expect(manifestInstall(acf({ appid: 570, StateFlags: 2 }))).toBeNull();
  });
});

describe("readInstalls", () => {
  it("lists the installs under way in every library, once each, by name", () => {
    const root = "/home/o/.steam/steam";
    const files = disk({
      [`${root}/steamapps/libraryfolders.vdf`]: `"libraryfolders" { "0" { "path" "${root}" } "1" { "path" "/games" } }`,
      [`${root}/steamapps/appmanifest_730.acf`]: acf({ appid: 730, name: "Counter-Strike 2", StateFlags: 4 }),
      [`${root}/steamapps/appmanifest_570.acf`]: acf({
        appid: 570,
        name: "Dota 2",
        StateFlags: 1048576,
        BytesToDownload: 100,
        BytesDownloaded: 50,
      }),
      ["/games/steamapps/appmanifest_440.acf"]: acf({
        appid: 440,
        name: "Team Fortress 2",
        StateFlags: 1026,
      }),
      ["/games/steamapps/appmanifest_570.acf"]: acf({ appid: 570, name: "Dota 2", StateFlags: 1026 }),
      ["/games/steamapps/notes.txt"]: "",
    });
    const installs = readInstalls({ platform: "linux", home: "/home/o", files });
    expect(installs.map((i) => [i.name, i.phase])).toEqual([
      ["Dota 2", "downloading"],
      ["Team Fortress 2", "queued"],
    ]);
  });

  it("is empty without Steam", () => {
    expect(readInstalls({ platform: "linux", home: "/home/o", files: disk({}) })).toEqual([]);
  });
});

describe("activeProcessFromReg", () => {
  it("reads Steam's pid and signed-in account", () => {
    const out = [
      "HKEY_CURRENT_USER\\Software\\Valve\\Steam\\ActiveProcess",
      "    pid    REG_DWORD    0x3a2c",
      "    SteamClientDll    REG_SZ    C:\\Program Files (x86)\\Steam\\steamclient.dll",
      "    ActiveUser    REG_DWORD    0x1d2c3b4a",
    ].join("\r\n");
    expect(activeProcessFromReg(out)).toEqual({ running: true, signedIn: true });
  });

  it("reads Steam running at its sign-in window, and Steam closed", () => {
    expect(
      activeProcessFromReg("    pid    REG_DWORD    0x3a2c\n    ActiveUser    REG_DWORD    0x0\n"),
    ).toEqual({
      running: true,
      signedIn: false,
    });
    expect(activeProcessFromReg("    pid    REG_DWORD    0x0\n    ActiveUser    REG_DWORD    0x0\n")).toEqual(
      {
        running: false,
        signedIn: false,
      },
    );
    expect(activeProcessFromReg("")).toEqual({ running: false, signedIn: false });
  });
});

describe("readSteamStatus", () => {
  const STEAM = "c:\\games\\steam";
  const registry =
    (active: string | null) =>
    async ([key]: string[]): Promise<string | null> =>
      key!.endsWith("ActiveProcess")
        ? active
        : `HKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    c:/games/steam\r\n`;
  const signedIn = "    pid    REG_DWORD    0x10\n    ActiveUser    REG_DWORD    0x22\n";

  it("finds Steam where the registry says, with steam.exe there", async () => {
    const files = disk({ [path.win32.join(STEAM, "steam.exe")]: "" });
    expect(await readSteamStatus({ platform: "win32", query: registry(signedIn), files })).toEqual({
      installed: true,
      path: STEAM,
      running: true,
      signedIn: true,
    });
  });

  it("is not installed where the registry names a folder without Steam, or nothing", async () => {
    expect(await readSteamStatus({ platform: "win32", query: registry(signedIn), files: disk({}) })).toEqual({
      installed: false,
      path: null,
      running: false,
      signedIn: false,
    });
    const none = async () => null;
    expect(await readSteamStatus({ platform: "win32", query: none, files: disk({}) })).toMatchObject({
      installed: false,
    });
  });

  it("is installed but signed out while Steam has not run or nobody signed in", async () => {
    const files = disk({ [path.win32.join(STEAM, "steam.exe")]: "" });
    expect(await readSteamStatus({ platform: "win32", query: registry(null), files })).toMatchObject({
      installed: true,
      running: false,
      signedIn: false,
    });
  });

  it("reads the installs alongside, only where Steam is installed", async () => {
    const files = disk({
      "/home/o/.steam/steam/steamapps/libraryfolders.vdf": `"libraryfolders" {}`,
      "/home/o/.steam/steam/steamapps/appmanifest_570.acf": acf({
        appid: 570,
        name: "Dota 2",
        StateFlags: 1026,
      }),
    });
    const read = await readSteam({ platform: "linux", home: "/home/o", files });
    expect(read.installed).toBe(true);
    expect(read.installs.map((i) => i.appid)).toEqual([570]);
    expect((await readSteam({ platform: "linux", home: "/nobody", files })).installs).toEqual([]);
  });
});

describe("Valve's installer", () => {
  const VALVE = "CN=Valve Corp., O=Valve Corp., L=Bellevue, S=Washington, C=US";

  it("is Valve's only when the signature is valid and the signer is Valve", () => {
    expect(isValveSignature(`Valid\r\n${VALVE}\r\n`)).toBe(true);
    expect(isValveSignature(`HashMismatch\r\n${VALVE}`)).toBe(false);
    expect(isValveSignature("NotSigned\r\n")).toBe(false);
    expect(isValveSignature("Valid\r\nCN=Valve Corp. Impostor, O=Someone Else, C=US")).toBe(false);
    expect(isValveSignature('Valid\r\nCN=x, O="Valve Corp.Evil", C=US')).toBe(false);
  });

  it("checks the signature with the path in the environment, never in the command", async () => {
    const run = vi.fn(async () => ({ stdout: `Valid\r\n${VALVE}\r\n` }));
    const file = "C:\\Temp\\x'; Remove-Item C:\\ -Recurse; '.exe";
    expect(await signedByValve(file, { platform: "win32", run })).toBe(true);
    const [, args, options] = run.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(args.join(" ")).not.toContain(file);
    expect(options.env.SWIFF_INSTALLER).toBe(file);
    expect(await signedByValve(file, { platform: "linux", run })).toBe(false);
  });

  /** A response of `bytes` bytes, declaring `length`. */
  const answer = (bytes: number, { status = 200, length = bytes } = {}) =>
    new Response(new Uint8Array(bytes), { status, headers: { "content-length": String(length) } });

  function memory() {
    const written = new Map<string, Uint8Array>();
    return {
      written,
      files: {
        mkdirSync: vi.fn(),
        writeFileSync: (file: string, data: Uint8Array) => void written.set(file, data),
        rmSync: (file: string) => void written.delete(file),
      },
    };
  }

  it("fetches from Valve's address alone, refusing redirects, and keeps a signed installer", async () => {
    const fetch = vi.fn(async () => answer(2_380_800));
    const { written, files } = memory();
    const file = await downloadSteamInstaller("/tmp/swiff", { fetch, verify: async () => true, files });
    expect(fetch).toHaveBeenCalledWith(STEAM_INSTALLER_URL, { redirect: "error" });
    expect(STEAM_INSTALLER_URL).toMatch(/^https:\/\/cdn\.fastly\.steamstatic\.com\//);
    expect(file).toBe(path.join("/tmp/swiff", "SteamSetup.exe"));
    expect(written.get(file)?.length).toBe(2_380_800);
  });

  it("deletes an installer Valve did not sign", async () => {
    const { written, files } = memory();
    await expect(
      downloadSteamInstaller("/tmp/swiff", {
        fetch: async () => answer(100),
        verify: async () => false,
        files,
      }),
    ).rejects.toThrow("not signed by Valve");
    expect(written.size).toBe(0);
  });

  it("refuses a failed answer, an empty one, and anything too big to be the installer", async () => {
    const { written, files } = memory();
    const verify = async () => true;
    const tries = [
      answer(100, { status: 404 }),
      answer(0),
      answer(10, { length: MAX_INSTALLER_BYTES + 1 }),
      // Too big, though it says otherwise.
      answer(MAX_INSTALLER_BYTES + 1, { length: 10 }),
    ];
    for (const res of tries) {
      await expect(
        downloadSteamInstaller("/tmp/swiff", { fetch: async () => res, verify, files }),
      ).rejects.toThrow("could not be downloaded");
    }
    await expect(
      downloadSteamInstaller("/tmp/swiff", {
        fetch: async () => Promise.reject(new TypeError("redirect")),
        verify,
        files,
      }),
    ).rejects.toThrow("Check the connection");
    expect(written.size).toBe(0);
  });

  it("opens the installer for the owner, and says why when it cannot", async () => {
    const { files } = memory();
    const base = { dir: "/tmp/swiff", fetch: async () => answer(100), verify: async () => true, files };
    const open = vi.fn(async () => "");
    expect(await openSteamInstaller({ ...base, platform: "win32", open })).toBeNull();
    expect(open).toHaveBeenCalledWith(path.join("/tmp/swiff", "SteamSetup.exe"));

    expect(await openSteamInstaller({ ...base, platform: "win32", open: async () => "denied" })).toMatch(
      /could not be opened/,
    );
    expect(await openSteamInstaller({ ...base, platform: "win32", open, verify: async () => false })).toMatch(
      /not signed by Valve/,
    );
    open.mockClear();
    expect(await openSteamInstaller({ ...base, platform: "darwin", open })).toMatch(/for Windows/);
    expect(open).not.toHaveBeenCalled();
  });
});
