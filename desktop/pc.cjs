// What the host app can read about this PC, in the main process: the parts
// that decide what it can run, and the Steam games installed on it. The
// renderer gets the result through one preload call and never the means to
// read anything itself. Every read is best effort: a part that cannot be read
// comes back null, a library that cannot be read is skipped.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

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

/** Whole gigabytes, the way the box was sold: 34,213,502,976 bytes → 32. */
const wholeGb = (bytes) => (bytes > 0 ? Math.round(bytes / 1024 ** 3) : null);

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

/** The Steam games installed on this PC, by name. Empty where Steam is not installed. */
function readSteamGames({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  steamPath = null,
  files = fs,
} = {}) {
  const read = (file) => {
    try {
      return files.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  const root = steamRoots(platform, env, home, steamPath).find((dir) =>
    read(path.join(dir, "steamapps", "libraryfolders.vdf")),
  );
  if (!root) return [];

  const libraries = [root, ...libraryPaths(read(path.join(root, "steamapps", "libraryfolders.vdf")))];
  const seen = new Map();
  libraries: for (const library of [...new Set(libraries)].slice(0, MAX_LIBRARIES)) {
    const apps = path.join(library, "steamapps");
    let names = [];
    try {
      names = files.readdirSync(apps).filter((name) => /^appmanifest_\d+\.acf$/.test(name));
    } catch {
      continue;
    }
    for (const name of names) {
      if (seen.size >= MAX_GAMES) break libraries;
      const game = manifestGame(read(path.join(apps, name)) ?? "");
      if (game && !seen.has(game.appid)) seen.set(game.appid, game);
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Everything the app reads about this PC, given Electron's `app` and `screen`. */
async function readPc({ app, screen }) {
  let gpu = null;
  try {
    gpu = gpuName(await app.getGPUInfo("complete"));
  } catch {
    // No GPU process, or a headless runner: the card stays unread.
  }
  const cpus = os.cpus();
  return {
    hardware: {
      gpu,
      cpu: cpuName(cpus[0]?.model),
      ramGb: wholeGb(os.totalmem()),
      display: displayOf(screen.getPrimaryDisplay()),
    },
    games: readSteamGames({ steamPath: await registrySteamPath() }),
  };
}

module.exports = {
  MAX_GAMES,
  cpuName,
  gpuName,
  wholeGb,
  displayOf,
  libraryPaths,
  manifestGame,
  steamPathFromReg,
  steamRoots,
  readSteamGames,
  readPc,
};
