// What the host app can read about this PC, in the main process: the parts
// that decide what it can run, the controls it can take, and the Steam games
// installed on it, watched for changes. The renderer gets the result through
// preload calls and never the means to read anything itself. Every read is
// best effort: a part that cannot be read comes back null, a library that
// cannot be read is skipped. On Windows the parts come from probe.cjs.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { readWindowsProbe } = require("./probe.cjs");

/** At most this many games are listed, as the platform's host report allows (docs/system-design/host.md). */
const MAX_GAMES = 2000;
/** Steam libraries read, at most: one per drive is the usual. */
const MAX_LIBRARIES = 32;

/** Steam tools that install like games but are not games. */
const NOT_GAMES = /^(Steamworks Common Redistributables|Steam Linux Runtime|Proton\b)/;

/** `AMD Ryzen 7 7800X3D 8-Core Processor` → `Ryzen 7 7800X3D`, `Intel(R) Core(TM) i7-13700K` → `Core i7-13700K`. */
function cpuName(model) {
  const name = String(model ?? "")
    .replace(/\((R|TM|tm)\)/g, "")
    .replace(/\s+@\s*[\d.]+\s*GHz$/i, "")
    .replace(/\s+CPU$/i, "")
    .replace(/\s+\d+-Core Processor$/i, "")
    .replace(/\s+Processor$/i, "")
    .replace(/^(AMD|Intel)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return name || null;
}

/** Split `a, b (c, d), e` on the commas outside parentheses. */
function topLevelParts(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/** A renderer string as a card's name: `ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0, D3D11)` → `NVIDIA GeForce RTX 4080`. */
function cardName(text) {
  const angle = /^ANGLE \((.*)\)$/.exec(text.trim());
  const name = (angle ? (topLevelParts(angle[1])[1] ?? "") : text)
    .replace(/^ANGLE Metal Renderer:\s*/, "")
    .replace(/\s+Direct3D\S*.*$/, "")
    .replace(/\s+\(0x[0-9a-f]+\)$/i, "")
    .trim();
  return name || null;
}

/**
 * The graphics card's name from Chromium's GPU info (`app.getGPUInfo("complete")`):
 * the active adapter's own description, else the renderer string ANGLE
 * reports. Either can come wrapped in ANGLE's form, as macOS's does.
 */
function gpuName(info) {
  const devices = Array.isArray(info?.gpuDevice) ? info.gpuDevice : [];
  const device = devices.find((d) => d?.active) ?? devices[0];
  if (typeof device?.deviceString === "string" && device.deviceString.trim())
    return cardName(device.deviceString);
  const renderer = info?.auxAttributes?.glRenderer;
  return typeof renderer === "string" ? cardName(renderer) : null;
}

/** Whole megabytes: 34,213,502,976 bytes → 32628. */
const wholeMb = (bytes) => (bytes > 0 ? Math.round(bytes / 1024 ** 2) : null);

/** The primary display in real pixels, and its refresh rate where the OS reports one. */
function displayOf(display) {
  if (!display?.size) return null;
  const scale = display.scaleFactor || 1;
  return {
    width: Math.round(display.size.width * scale),
    height: Math.round(display.size.height * scale),
    refreshHz: Math.round(display.displayFrequency || 0) || null,
  };
}

/** A VDF string value: `"D:\\\\Games"` → `D:\\Games`. */
const unescapeVdf = (value) => value.replace(/\\(.)/g, "$1");

/** Every library folder `libraryfolders.vdf` names. */
function libraryPaths(vdf) {
  const paths = [];
  for (const match of String(vdf).matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/g))
    paths.push(unescapeVdf(match[1]));
  return paths;
}

/** One `appmanifest_<appid>.acf`: the game it installs, or null unless installed and ready to launch. */
function manifestGame(acf) {
  const field = (key) => new RegExp(`"${key}"\\s+"((?:[^"\\\\]|\\\\.)*)"`, "i").exec(String(acf))?.[1];
  const appid = Number(field("appid"));
  const name = unescapeVdf(field("name") ?? "").trim();
  // StateFlags 4 is fully installed with no update pending (docs/system-design/host.md).
  if (!Number.isInteger(appid) || appid < 1 || !name || field("StateFlags") !== "4") return null;
  if (NOT_GAMES.test(name)) return null;
  return { appid, name };
}

/** Steam's own install folder, from what `reg query` prints for HKCU\Software\Valve\Steam: `c:/games/steam` → `c:\games\steam`. */
function steamPathFromReg(output) {
  const value = /^\s*SteamPath\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/im.exec(String(output))?.[1];
  return value ? path.win32.normalize(value) : null;
}

/** Where Steam says it is installed, on Windows; null anywhere else or when it cannot be read. */
async function registrySteamPath() {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await promisify(execFile)(
      "reg",
      ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"],
      { timeout: 3000, windowsHide: true },
    );
    return steamPathFromReg(stdout);
  } catch {
    return null;
  }
}

/**
 * Where Steam keeps its own install, by platform: the first that exists wins.
 * On Windows, where Steam says it is (`steamPath`) comes before the defaults.
 */
function steamRoots(platform, env, home, steamPath = null) {
  if (platform === "win32") {
    const defaults = [env["ProgramFiles(x86)"], env.ProgramFiles]
      .filter(Boolean)
      .map((dir) => path.win32.join(dir, "Steam"));
    return steamPath ? [steamPath, ...defaults] : defaults;
  }
  if (platform === "darwin") return [path.join(home, "Library", "Application Support", "Steam")];
  return [path.join(home, ".steam", "steam"), path.join(home, ".local", "share", "Steam")];
}

/** A file's text, or null when it cannot be read. */
const readText = (files, file) => {
  try {
    return files.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** Steam's own install folder on this PC: the first candidate with a library list, or null. */
function findSteamRoot({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  steamPath = null,
  files = fs,
} = {}) {
  return (
    steamRoots(platform, env, home, steamPath).find((dir) =>
      readText(files, path.join(dir, "steamapps", "libraryfolders.vdf")),
    ) ?? null
  );
}

/** Every Steam library's `steamapps` folder on this PC, Steam's own first. Empty where Steam is not installed. */
function steamLibraries(options = {}) {
  const files = options.files ?? fs;
  const root = findSteamRoot(options);
  if (!root) return [];
  const libraries = [
    root,
    ...libraryPaths(readText(files, path.join(root, "steamapps", "libraryfolders.vdf"))),
  ];
  return [...new Set(libraries)].slice(0, MAX_LIBRARIES).map((library) => path.join(library, "steamapps"));
}

/** The Steam games installed on this PC, by name. Empty where Steam is not installed. */
function readSteamGames(options = {}) {
  const files = options.files ?? fs;
  const seen = new Map();
  libraries: for (const apps of steamLibraries(options)) {
    let names = [];
    try {
      names = files.readdirSync(apps).filter((name) => /^appmanifest_\d+\.acf$/.test(name));
    } catch {
      continue;
    }
    for (const name of names) {
      if (seen.size >= MAX_GAMES) break libraries;
      const game = manifestGame(readText(files, path.join(apps, name)) ?? "");
      if (game && !seen.has(game.appid)) seen.set(game.appid, game);
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// --- game art -----------------------------------------------------------------
//
// The app draws a game's art from the copy Steam keeps on this PC, never from
// the network: the window loads no remote content. The renderer asks for it as
// swiff-art://steam/<appid>/<kind>, and main answers from Steam's library cache.
// The host is fixed: Chromium reads an all-digit host as an IPv4 address.

const ART_FILES = { hero: "library_hero.jpg", header: "header.jpg" };

/** The game and the picture a swiff-art:// address asks for, or null for anything else. */
function artRequest(url) {
  const match = /^swiff-art:\/\/steam\/(\d{1,10})\/(hero|header)\/?$/.exec(String(url));
  return match ? { appid: Number(match[1]), kind: match[2] } : null;
}

/**
 * Where Steam may keep one picture of a game in its library cache: the
 * current layout (<appid>/, or one folder below it) before the older
 * <appid>_<name> files. Only names built here are ever read.
 */
function artCandidates(root, { appid, kind }, files = fs) {
  const cache = path.join(root, "appcache", "librarycache");
  const dir = path.join(cache, String(appid));
  const name = ART_FILES[kind];
  const found = [path.join(dir, name)];
  try {
    for (const sub of files.readdirSync(dir).slice(0, 16)) found.push(path.join(dir, sub, name));
  } catch {
    // No folder for this game: only the older layout is left.
  }
  found.push(path.join(cache, `${appid}_${name}`));
  return found;
}

/** The picture a swiff-art:// address asks for, as JPEG bytes, or null when this PC has none. */
async function readSteamArt(url, root, files = fs) {
  const request = artRequest(url);
  if (!request || !root) return null;
  for (const file of artCandidates(root, request, files)) {
    try {
      return await files.promises.readFile(file);
    } catch {
      // Not this one: try the next place Steam may keep it.
    }
  }
  return null;
}

/** Where Steam says it is installed, asked once per launch, or until it is found: the owner may install Steam meanwhile. */
let steamPathAsked = null;
const steamPathOnce = () =>
  (steamPathAsked ??= registrySteamPath().then((found) => {
    if (!found) steamPathAsked = null;
    return found;
  }));

/** Steam's install folder on this PC, for game art; null where Steam is not installed. */
const steamRootOnce = async () => findSteamRoot({ steamPath: await steamPathOnce() });

/** Same appids, in any order. */
const sameGames = (a, b) => a.length === b.length && a.every((g, i) => g.appid === b[i].appid);

/** How long Steam's writes settle before the library is read again: a download rewrites its manifest often. */
const SETTLE_MS = 2_000;

/**
 * Watch every Steam library for games installed, updated or removed, and call
 * `onChange` with the whole list when it changes. Returns the stop call.
 * Libraries added or removed in Steam are picked up on the next change.
 */
function watchSteamGames(onChange, options = {}) {
  const watch = options.watch ?? fs.watch;
  const read = () => readSteamGames(options);
  let last = read();
  let timer = null;
  let watchers = new Map();
  let stopped = false;

  const rewatch = () => {
    const dirs = new Set(steamLibraries(options));
    for (const [dir, watcher] of watchers) {
      if (dirs.has(dir)) continue;
      watcher.close();
      watchers.delete(dir);
    }
    for (const dir of dirs) {
      if (watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, settle);
        watcher.on?.("error", () => {
          watcher.close();
          watchers.delete(dir);
        });
        watchers.set(dir, watcher);
      } catch {
        // A library on a drive that is gone, or cannot be watched: read on the next change.
      }
    }
  };
  function settle() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      // A throw here would be uncaught in main. The list is kept as sent only
      // once onChange took it, so one that failed goes again with the next change.
      try {
        rewatch();
        const games = read();
        if (sameGames(games, last)) return;
        onChange(games);
        last = games;
      } catch (error) {
        console.warn(
          "[swiff] could not pass on the installed games:",
          error instanceof Error ? error.name : error,
        );
      }
    }, SETTLE_MS);
  }

  rewatch();
  return () => {
    stopped = true;
    clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
    watchers = new Map();
  };
}

/** The Windows probe, run once per launch: none of what it reads changes while the app runs. */
let probeAsked = null;
const probeOnce = () => (probeAsked ??= readWindowsProbe());

/**
 * Everything the app reads about this PC, given Electron's `app` and `screen`:
 * the host report's hardware (docs/system-design/host.md), each field null
 * where it cannot be read, the controls it can take, and its Steam games.
 * Off Windows, or where the probe fails, the card comes from Chromium and the
 * memory and processor from the OS; the card's memory, the cores and the
 * encoders stay unread.
 */
async function readPc({ app, screen, probe = probeOnce }) {
  const [probed, chromium] = await Promise.all([
    probe(),
    Promise.resolve()
      .then(() => app.getGPUInfo("complete"))
      .then(gpuName)
      // No GPU process, or a headless runner: the card stays unread.
      .catch(() => null),
  ]);
  return {
    hardware: {
      gpu: probed?.gpu ?? chromium,
      vramMb: probed?.vramMb ?? null,
      ramMb: probed?.ramMb ?? wholeMb(os.totalmem()),
      cpu: cpuName(probed?.cpu ?? os.cpus()[0]?.model),
      cores: probed?.cores ?? null,
      encoders: probed?.encoders ?? null,
      display: displayOf(screen.getPrimaryDisplay()),
    },
    // Every PC takes a keyboard and mouse; a renter's gamepad needs the ViGEmBus driver to appear as one.
    controls: ["kb", "mouse", ...(probed?.pad ? ["pad"] : [])],
    games: readSteamGames({ steamPath: await steamPathOnce() }),
  };
}

module.exports = {
  MAX_GAMES,
  cpuName,
  gpuName,
  wholeMb,
  displayOf,
  libraryPaths,
  manifestGame,
  steamPathFromReg,
  steamRoots,
  findSteamRoot,
  steamLibraries,
  readSteamGames,
  watchSteamGames,
  steamPathOnce,
  artRequest,
  artCandidates,
  readSteamArt,
  steamRootOnce,
  readPc,
};
