// @vitest-environment node
// The main process's reading of this PC: names cleaned for people, and the
// installed Steam games found the way the platform's host report describes.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  artCandidates,
  artRequest,
  cpuName,
  displayOf,
  gpuName,
  libraryPaths,
  manifestGame,
  MAX_GAMES,
  readPc,
  readSteamArt,
  readSteamGames,
  steamLibraries,
  steamPathFromReg,
  steamRoots,
  watchSteamGames,
  wholeMb,
} from "../pc.cjs";
import { parseProbe, readWindowsProbe } from "../probe.cjs";

describe("cpuName", () => {
  it("drops the vendor, trademarks and core counts", () => {
    expect(cpuName("AMD Ryzen 7 7800X3D 8-Core Processor")).toBe("Ryzen 7 7800X3D");
    expect(cpuName("Intel(R) Core(TM) i7-13700K")).toBe("Core i7-13700K");
    expect(cpuName("Intel(R) Core(TM) i5-8400 CPU @ 2.80GHz")).toBe("Core i5-8400");
    expect(cpuName("Apple M1 Pro")).toBe("Apple M1 Pro");
  });

  it("is null when there is nothing to name", () => {
    expect(cpuName(undefined)).toBeNull();
    expect(cpuName("  ")).toBeNull();
  });
});

describe("gpuName", () => {
  it("prefers the active adapter's own description", () => {
    const info = {
      gpuDevice: [
        { active: false, deviceString: "Intel(R) UHD Graphics 770" },
        { active: true, deviceString: "NVIDIA GeForce RTX 4080" },
      ],
      auxAttributes: {
        glRenderer: "ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    };
    expect(gpuName(info)).toBe("NVIDIA GeForce RTX 4080");
  });

  it("unwraps an adapter description that comes in ANGLE's form, as on macOS", () => {
    const deviceString = "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Version 15.6.1 (Build 24G90))";
    expect(gpuName({ gpuDevice: [{ active: true, deviceString }] })).toBe("Apple M2");
  });

  it("reads the card out of ANGLE's renderer string", () => {
    const of = (glRenderer: string) =>
      gpuName({ gpuDevice: [{ active: true }], auxAttributes: { glRenderer } });
    expect(of("ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe(
      "NVIDIA GeForce RTX 4080",
    );
    expect(of("ANGLE (AMD, AMD Radeon RX 7900 XTX (0x0000744C) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe(
      "AMD Radeon RX 7900 XTX",
    );
    expect(of("ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)")).toBe("Apple M1 Pro");
    expect(of("ANGLE (Mesa, llvmpipe (LLVM 15.0.7, 256 bits), OpenGL 4.5)")).toBe(
      "llvmpipe (LLVM 15.0.7, 256 bits)",
    );
  });

  it("is null without GPU info", () => {
    expect(gpuName(undefined)).toBeNull();
    expect(gpuName({ gpuDevice: [] })).toBeNull();
  });
});

describe("sizes", () => {
  it("measures memory in whole megabytes", () => {
    expect(wholeMb(34_213_502_976)).toBe(32_629);
    expect(wholeMb(17_179_869_184)).toBe(16_384);
    expect(wholeMb(0)).toBeNull();
  });

  it("measures the primary display in real pixels", () => {
    expect(
      displayOf({ size: { width: 1280, height: 720 }, scaleFactor: 2, displayFrequency: 143.9 }),
    ).toEqual({
      width: 2560,
      height: 1440,
      refreshHz: 144,
    });
    expect(displayOf({ size: { width: 1920, height: 1080 }, scaleFactor: 1, displayFrequency: 0 })).toEqual({
      width: 1920,
      height: 1080,
      refreshHz: null,
    });
    expect(displayOf(undefined)).toBeNull();
  });
});

const LIBRARY_FOLDERS = `"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"apps" { "730" "0" }
	}
	"1"
	{
		"path"		"D:\\\\SteamLibrary"
	}
}`;

/** A file tree to read from, either separator matching either. */
function fakeFiles(tree: Record<string, string>) {
  const slash = (p: string) => p.replace(/\\/g, "/");
  const files = new Map(Object.entries(tree).map(([file, text]) => [slash(file), text]));
  return {
    readFileSync(file: string) {
      const text = files.get(slash(file));
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
    readdirSync(dir: string) {
      const names = [...files.keys()]
        .filter((file) => file.startsWith(`${slash(dir)}/`))
        .map((file) => file.slice(slash(dir).length + 1));
      if (!names.length) throw new Error("ENOENT");
      return names;
    },
  };
}

const manifest = (appid: number, name: string, flags = 4) => `"AppState"
{
	"appid"		"${appid}"
	"name"		"${name}"
	"StateFlags"		"${flags}"
	"installdir"		"x"
}`;

describe("Steam library", () => {
  it("lists every library folder, unescaped", () => {
    expect(libraryPaths(LIBRARY_FOLDERS)).toEqual(["C:\\Program Files (x86)\\Steam", "D:\\SteamLibrary"]);
  });

  it("takes a game only when it is installed and ready to launch", () => {
    expect(manifestGame(manifest(730, "Counter-Strike 2"))).toEqual({ appid: 730, name: "Counter-Strike 2" });
    expect(manifestGame(manifest(1245620, "ELDEN RING", 6))).toBeNull(); // update pending
    expect(manifestGame(manifest(228980, "Steamworks Common Redistributables"))).toBeNull();
    expect(manifestGame("garbage")).toBeNull();
  });

  it("looks for Steam where each platform installs it", () => {
    expect(steamRoots("win32", { "ProgramFiles(x86)": "C:\\Program Files (x86)" }, "C:\\Users\\kai")).toEqual(
      ["C:\\Program Files (x86)\\Steam"],
    );
    expect(
      steamRoots("win32", { "ProgramFiles(x86)": "C:\\Program Files (x86)" }, "C:\\Users\\kai", "D:\\Steam"),
    ).toEqual(["D:\\Steam", "C:\\Program Files (x86)\\Steam"]);
    expect(steamRoots("darwin", {}, "/Users/kai")).toEqual(["/Users/kai/Library/Application Support/Steam"]);
    expect(steamRoots("linux", {}, "/home/kai")).toEqual([
      "/home/kai/.steam/steam",
      "/home/kai/.local/share/Steam",
    ]);
  });

  it("reads installed games across libraries, once each, by name", () => {
    const root = "/home/kai/.local/share/Steam";
    const tree: Record<string, string> = {
      [`${root}/steamapps/libraryfolders.vdf`]: `"libraryfolders" { "0" { "path" "${root}" } "1" { "path" "/mnt/games" } }`,
      [`${root}/steamapps/appmanifest_730.acf`]: manifest(730, "Counter-Strike 2"),
      [`${root}/steamapps/appmanifest_1245620.acf`]: manifest(1245620, "ELDEN RING"),
      "/mnt/games/steamapps/appmanifest_1091500.acf": manifest(1091500, "Cyberpunk 2077"),
      "/mnt/games/steamapps/appmanifest_730.acf": manifest(730, "Counter-Strike 2"),
      "/mnt/games/steamapps/appmanifest_553850.acf": manifest(553850, "HELLDIVERS 2", 1026),
    };
    const files = {
      readFileSync(file: string) {
        if (!(file in tree)) throw new Error("ENOENT");
        return tree[file]!;
      },
      readdirSync(dir: string) {
        const names = Object.keys(tree)
          .filter((file) => file.startsWith(`${dir}/`))
          .map((file) => file.slice(dir.length + 1));
        if (!names.length) throw new Error("ENOENT");
        return names;
      },
    };
    expect(readSteamGames({ platform: "linux", env: {}, home: "/home/kai", files })).toEqual([
      { appid: 730, name: "Counter-Strike 2" },
      { appid: 1091500, name: "Cyberpunk 2077" },
      { appid: 1245620, name: "ELDEN RING" },
    ]);
  });

  it("reads where Steam says it is installed out of the registry, with Windows separators", () => {
    const output = [
      "",
      "HKEY_CURRENT_USER\\Software\\Valve\\Steam",
      "    SteamPath    REG_SZ    d:/games/steam",
      "",
    ].join("\r\n");
    expect(steamPathFromReg(output)).toBe("d:\\games\\steam");
    expect(
      steamPathFromReg("ERROR: The system was unable to find the specified registry key or value."),
    ).toBeNull();
    expect(steamPathFromReg("")).toBeNull();
  });

  it("finds a Steam installed where the registry says, before the defaults", () => {
    const root = "D:\\Steam";
    const tree: Record<string, string> = {
      [`${root}\\steamapps\\libraryfolders.vdf`]: `"libraryfolders" { "0" { "path" "D:\\\\Steam" } }`,
      [`${root}\\steamapps\\appmanifest_730.acf`]: manifest(730, "Counter-Strike 2"),
    };
    const files = fakeFiles(tree);
    const env = { "ProgramFiles(x86)": "C:\\Program Files (x86)" };
    expect(readSteamGames({ platform: "win32", env, home: "C:\\Users\\kai", files })).toEqual([]);
    expect(
      readSteamGames({ platform: "win32", env, home: "C:\\Users\\kai", steamPath: root, files }),
    ).toEqual([{ appid: 730, name: "Counter-Strike 2" }]);
  });

  it("lists no more games than the host report allows, across every library", () => {
    const root = "/home/kai/.local/share/Steam";
    const libraries = ["/mnt/a", "/mnt/b", "/mnt/c"];
    const tree: Record<string, string> = {
      [`${root}/steamapps/libraryfolders.vdf`]: `"libraryfolders" { ${libraries
        .map((lib, i) => `"${i}" { "path" "${lib}" }`)
        .join(" ")} }`,
    };
    let appid = 1;
    for (const lib of [root, ...libraries]) {
      const n = lib === root ? MAX_GAMES : 2;
      for (let i = 0; i < n; i++, appid++)
        tree[`${lib}/steamapps/appmanifest_${appid}.acf`] = manifest(appid, `Game ${appid}`);
    }
    const files = fakeFiles(tree);
    expect(readSteamGames({ platform: "linux", env: {}, home: "/home/kai", files })).toHaveLength(MAX_GAMES);
  });

  it("finds nothing where Steam is not installed", () => {
    const files = {
      readFileSync(): string {
        throw new Error("ENOENT");
      },
      readdirSync(): string[] {
        throw new Error("ENOENT");
      },
    };
    expect(readSteamGames({ platform: "darwin", env: {}, home: "/Users/kai", files })).toEqual([]);
  });
});

describe("watching the Steam library", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls back with the whole list once Steam's writes settle, only when the games changed", () => {
    vi.useFakeTimers();
    const root = "/home/kai/.local/share/Steam";
    const tree: Record<string, string> = {
      [`${root}/steamapps/libraryfolders.vdf`]: `"libraryfolders" { "0" { "path" "${root}" } "1" { "path" "/mnt/games" } }`,
      [`${root}/steamapps/appmanifest_730.acf`]: manifest(730, "Counter-Strike 2"),
    };
    const listeners = new Map<string, () => void>();
    const closed: string[] = [];
    const watch = (dir: string, listener: () => void) => {
      listeners.set(dir, listener);
      return { close: () => closed.push(dir) };
    };
    const changes = vi.fn();
    // Read live: the test installs games as it goes.
    const files = {
      readFileSync: (file: string) => fakeFiles(tree).readFileSync(file),
      readdirSync: (dir: string) => fakeFiles(tree).readdirSync(dir),
    };
    const options = { platform: "linux", env: {}, home: "/home/kai", files, watch };
    expect(steamLibraries(options)).toEqual([`${root}/steamapps`, "/mnt/games/steamapps"]);
    const stop = watchSteamGames(changes, options);
    expect([...listeners.keys()]).toEqual([`${root}/steamapps`, "/mnt/games/steamapps"]);

    // A download in progress rewrites its manifest: nothing installed yet, nothing to say.
    tree["/mnt/games/steamapps/appmanifest_1091500.acf"] = manifest(1091500, "Cyberpunk 2077", 1026);
    listeners.get("/mnt/games/steamapps")!();
    vi.advanceTimersByTime(2_000);
    expect(changes).not.toHaveBeenCalled();

    tree["/mnt/games/steamapps/appmanifest_1091500.acf"] = manifest(1091500, "Cyberpunk 2077");
    listeners.get("/mnt/games/steamapps")!();
    vi.advanceTimersByTime(1_000);
    listeners.get("/mnt/games/steamapps")!();
    vi.advanceTimersByTime(1_999);
    expect(changes).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(changes).toHaveBeenCalledExactlyOnceWith([
      { appid: 730, name: "Counter-Strike 2" },
      { appid: 1091500, name: "Cyberpunk 2077" },
    ]);

    stop();
    expect(closed.sort()).toEqual([`${root}/steamapps`, "/mnt/games/steamapps"]);
  });
});

describe("the Windows probe", () => {
  const PRINTED = [
    "#< CLIXML",
    JSON.stringify({
      adapters: [
        { name: "AMD Radeon(TM) Graphics", vram: 536_870_912 },
        { name: "NVIDIA GeForce RTX 4070 Laptop GPU", vram: 8_403_288_064 },
      ],
      encoders: { h264: 2, hevc: 1, av1: 0 },
      ram: [17_179_869_184, 17_179_869_184],
      cpus: [{ name: "AMD Ryzen 9 7940HS w/ Radeon 780M Graphics      ", cores: 8 }],
      vigem: true,
    }),
    '<Objs Version="1.1.0.1"></Objs>',
  ].join("\r\n");

  it("takes the card with the most memory of its own, and sums memory and cores", () => {
    expect(parseProbe(PRINTED)).toEqual({
      gpu: "NVIDIA GeForce RTX 4070 Laptop GPU",
      vramMb: 8014,
      ramMb: 32_768,
      cpu: "AMD Ryzen 9 7940HS w/ Radeon 780M Graphics",
      cores: 8,
      encoders: ["h264", "hevc"],
      pad: true,
    });
  });

  it("leaves unread what the probe could not read", () => {
    expect(parseProbe('{"ram":[8589934592],"vigem":false}')).toEqual({
      gpu: null,
      vramMb: null,
      ramMb: 8192,
      cpu: null,
      cores: null,
      encoders: null,
      pad: false,
    });
    // PowerShell prints a list of one as the item itself.
    expect(
      parseProbe(
        '{"adapters":{"name":"Intel(R) UHD Graphics","vram":134217728},"encoders":{"h264":1,"hevc":0,"av1":0}}',
      ),
    ).toMatchObject({
      gpu: "Intel(R) UHD Graphics",
      vramMb: 128,
      encoders: ["h264"],
    });
    expect(parseProbe("")).toBeNull();
    expect(parseProbe("Add-Type : compiler error")).toBeNull();
  });

  it("runs Windows PowerShell hidden, with the script encoded, and only on Windows", async () => {
    const run = vi.fn(
      (_file: string, _args: string[], _options: unknown, done: (e: Error | null, out: string) => void) =>
        done(null, '{"vigem":true}'),
    );
    expect(await readWindowsProbe({ platform: "linux", run })).toBeNull();
    expect(run).not.toHaveBeenCalled();

    expect(
      await readWindowsProbe({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, run }),
    ).toMatchObject({ pad: true });
    const [file, args, options] = run.mock.calls[0]!;
    expect(file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(Buffer.from(args[3]!, "base64").toString("utf16le")).toContain("MFTEnumEx");
    expect(options).toMatchObject({ windowsHide: true });

    const failing = vi.fn(
      (_f: string, _a: string[], _o: unknown, done: (e: Error | null, out: string) => void) =>
        done(new Error("spawn powershell.exe ENOENT"), ""),
    );
    expect(await readWindowsProbe({ platform: "win32", env: {}, run: failing })).toBeNull();
  });

  it("reads this PC from the probe, the OS where it cannot, and lists a gamepad only with ViGEmBus", async () => {
    const screen = {
      getPrimaryDisplay: () => ({
        size: { width: 1920, height: 1080 },
        scaleFactor: 1,
        displayFrequency: 60,
      }),
    };
    const app = {
      getGPUInfo: async () => ({ gpuDevice: [{ active: true, deviceString: "Chromium's card" }] }),
    };
    const probed = parseProbe(PRINTED);
    const full = await readPc({ app, screen, probe: async () => probed });
    expect(full.hardware).toEqual({
      gpu: "NVIDIA GeForce RTX 4070 Laptop GPU",
      vramMb: 8014,
      ramMb: 32_768,
      cpu: "Ryzen 9 7940HS w/ Radeon 780M Graphics",
      cores: 8,
      encoders: ["h264", "hevc"],
      display: { width: 1920, height: 1080, refreshHz: 60 },
    });
    expect(full.controls).toEqual(["kb", "mouse", "pad"]);

    const bare = await readPc({ app, screen, probe: async () => null });
    expect(bare.hardware).toMatchObject({
      gpu: "Chromium's card",
      vramMb: null,
      cores: null,
      encoders: null,
    });
    expect(bare.hardware.ramMb).toBeGreaterThan(0);
    expect(bare.controls).toEqual(["kb", "mouse"]);
  });
});

describe("game art from Steam's own cache", () => {
  const root = "/home/kai/.local/share/Steam";
  const cache = `${root}/appcache/librarycache`;

  it("answers only swiff-art://steam/<appid>/<hero|header>", () => {
    expect(artRequest("swiff-art://steam/730/hero")).toEqual({ appid: 730, kind: "hero" });
    expect(artRequest("swiff-art://steam/1245620/header")).toEqual({ appid: 1245620, kind: "header" });
    for (const url of [
      "swiff-art://730/hero",
      "swiff-art://0.0.2.218/hero",
      "swiff-art://steam/730/../../etc/passwd",
      "swiff-art://steam/730/hero.jpg",
      "swiff-art://steam/x/hero",
      "swiff-art://other/730/hero",
      "file:///etc/passwd",
      "swiff-art://steam/730/hero?x=1",
    ]) {
      expect(artRequest(url)).toBeNull();
    }
  });

  it("looks where Steam keeps it, in the current layout before the older one", () => {
    const files = {
      readdirSync: (dir: string) => {
        if (dir !== `${cache}/730`) throw new Error("ENOENT");
        return ["4f2a"];
      },
    };
    expect(artCandidates(root, { appid: 730, kind: "hero" }, files)).toEqual([
      `${cache}/730/library_hero.jpg`,
      `${cache}/730/4f2a/library_hero.jpg`,
      `${cache}/730_library_hero.jpg`,
    ]);
  });

  it("reads the first picture this PC has, and nothing for a game it has none of", async () => {
    const stored: Record<string, string> = { [`${cache}/730_header.jpg`]: "jpeg bytes" };
    const files = {
      readdirSync: () => {
        throw new Error("ENOENT");
      },
      promises: {
        readFile: async (file: string) => {
          if (!(file in stored)) throw new Error("ENOENT");
          return stored[file];
        },
      },
    };
    expect(await readSteamArt("swiff-art://steam/730/header", root, files)).toBe("jpeg bytes");
    expect(await readSteamArt("swiff-art://steam/730/hero", root, files)).toBeNull();
    expect(await readSteamArt("swiff-art://steam/730/header", null, files)).toBeNull();
  });
});
