// Getting this PC ready to host, in the main process: whether Steam is
// installed and signed in, Valve's own installer fetched and opened for the
// owner to click through, and the games Steam is installing now with how far
// along each one is. The renderer gets the result through preload calls and
// never the means to read or run anything itself.
//
// Swiff never handles the owner's Steam account: they sign in, and buy or
// install games, in Steam's own window. What the app reads is what Steam
// leaves on this PC: the registry under HKCU\Software\Valve\Steam and the
// appmanifest_<appid>.acf file it keeps for each game in each library.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { findSteamRoot, libraryPaths, steamPathFromReg } = require("./pc.cjs");

/** Valve's installer, from the link on store.steampowered.com/about. Never another address. */
const STEAM_INSTALLER_URL = "https://cdn.fastly.steamstatic.com/client/installer/SteamSetup.exe";
/** The installer is about 2.3 MB; anything far bigger is not it. */
const MAX_INSTALLER_BYTES = 16 * 1024 * 1024;
/** Installs listed at most: more than anyone queues at once. */
const MAX_INSTALLS = 50;
/** Steam libraries read, at most, as pc.cjs reads them. */
const MAX_LIBRARIES = 32;

// Steam's StateFlags bits (EAppState in its SDK) that say what an install is doing.
const FULLY_INSTALLED = 4;
const UPDATE_PAUSED = 512;
const DOWNLOADING = 1048576;
const STAGING = 2097152;
const COMMITTING = 4194304;

/** A whole number from an ACF field, 0 when absent. */
const acfNumber = (acf, key) => {
  const value = new RegExp(`"${key}"\\s+"(\\d+)"`, "i").exec(acf)?.[1];
  return value ? Number(value) : 0;
};

/**
 * One `appmanifest_<appid>.acf` of a game Steam has not finished installing:
 * the game, what Steam is doing with it, and its bytes done of all it needs
 * for that step. Null for a game that is installed, or a file that is not a
 * manifest. While Steam stages or commits the download, the bytes are the
 * staged ones; before it knows the size, both are 0.
 */
function manifestInstall(text) {
  const acf = String(text);
  const appid = acfNumber(acf, "appid");
  const name = /"name"\s+"((?:[^"\\]|\\.)*)"/i.exec(acf)?.[1]?.replace(/\\(.)/g, "$1").trim();
  const flags = acfNumber(acf, "StateFlags");
  if (!Number.isSafeInteger(appid) || appid < 1 || !name || flags & FULLY_INSTALLED) return null;
  const finishing = Boolean(flags & (STAGING | COMMITTING));
  const phase =
    flags & UPDATE_PAUSED
      ? "paused"
      : finishing
        ? "finishing"
        : flags & DOWNLOADING
          ? "downloading"
          : "queued";
  const [done, total] = finishing
    ? [acfNumber(acf, "BytesStaged"), acfNumber(acf, "BytesToStage")]
    : [acfNumber(acf, "BytesDownloaded"), acfNumber(acf, "BytesToDownload")];
  return { appid, name, phase, done: Math.min(done, total), total };
}

/** A file's text, or null when it cannot be read. */
const readText = (files, file) => {
  try {
    return files.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** The games Steam is installing on this PC, across every library, by name. Empty without Steam. */
function readInstalls(options = {}) {
  const files = options.files ?? fs;
  const root = findSteamRoot(options);
  if (!root) return [];
  const libraries = [
    root,
    ...libraryPaths(readText(files, path.join(root, "steamapps", "libraryfolders.vdf")) ?? ""),
  ];
  const found = new Map();
  for (const library of [...new Set(libraries)].slice(0, MAX_LIBRARIES)) {
    const apps = path.join(library, "steamapps");
    let names = [];
    try {
      names = files.readdirSync(apps).filter((name) => /^appmanifest_\d+\.acf$/.test(name));
    } catch {
      continue;
    }
    for (const name of names) {
      if (found.size >= MAX_INSTALLS) break;
      const install = manifestInstall(readText(files, path.join(apps, name)) ?? "");
      if (install && !found.has(install.appid)) found.set(install.appid, install);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Steam's running process and signed-in account, from what `reg query` prints
 * for HKCU\Software\Valve\Steam\ActiveProcess: Steam keeps its pid there while
 * it runs, and ActiveUser is the signed-in account's id, 0 when nobody is.
 */
function activeProcessFromReg(output) {
  const dword = (name) => {
    const hex = new RegExp(`^\\s*${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)\\s*$`, "im").exec(String(output))?.[1];
    return hex ? parseInt(hex, 16) : 0;
  };
  return { running: dword("pid") !== 0, signedIn: dword("ActiveUser") !== 0 };
}

/** What `reg query` prints for `key`, or null when it cannot be read. */
async function regQuery(args) {
  try {
    const { stdout } = await promisify(execFile)("reg", ["query", ...args], {
      timeout: 3000,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Whether Steam is installed on this PC, running and signed in, read fresh
 * each time. On Windows, installed means the registry's SteamPath holds
 * steam.exe; elsewhere, that a Steam library is where Steam keeps one.
 * `query` and `files` stand in for the registry and the disk in tests.
 */
async function readSteamStatus({
  platform = process.platform,
  query = regQuery,
  files = fs,
  ...options
} = {}) {
  if (platform !== "win32") {
    const root = findSteamRoot({ platform, files, ...options });
    return { installed: root !== null, path: root, running: false, signedIn: false };
  }
  const [main, active] = await Promise.all([
    query(["HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"]),
    query(["HKCU\\Software\\Valve\\Steam\\ActiveProcess"]),
  ]);
  const steamPath = main ? steamPathFromReg(main) : null;
  const installed = steamPath !== null && files.existsSync(path.win32.join(steamPath, "steam.exe"));
  const { running, signedIn } = active ? activeProcessFromReg(active) : { running: false, signedIn: false };
  return {
    installed,
    path: installed ? steamPath : null,
    running: installed && running,
    signedIn: installed && signedIn,
  };
}

/** Everything the setup step shows about Steam on this PC: its status and the games installing. */
async function readSteam(options = {}) {
  const status = await readSteamStatus(options);
  const installs = status.installed
    ? readInstalls({ ...options, steamPath: status.path ?? options.steamPath ?? null })
    : [];
  return { ...status, installs };
}

/**
 * Whether `file` carries a valid Authenticode signature from Valve, as
 * Windows checks it. Off Windows, never: the installer is Windows only.
 */
async function signedByValve(file, { platform = process.platform, run = promisify(execFile) } = {}) {
  if (platform !== "win32") return false;
  // The path rides in the environment, never in the command, so no name can be read as code.
  const script =
    "$s = Get-AuthenticodeSignature -LiteralPath $env:SWIFF_INSTALLER; " +
    "Write-Output ([string]$s.Status); Write-Output $s.SignerCertificate.Subject";
  try {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: 20_000,
      windowsHide: true,
      env: { ...process.env, SWIFF_INSTALLER: file },
    });
    return isValveSignature(stdout);
  } catch {
    return false;
  }
}

/** What signedByValve's check prints: `Valid`, then the signer, which must be Valve's company. */
function isValveSignature(output) {
  const [status, subject = ""] = String(output).trim().split(/\r?\n/);
  return status?.trim() === "Valid" && /(^|,\s*)O="?Valve Corp(oration)?\.?"?(,|$)/.test(subject.trim());
}

/** A refusal or failure the owner reads, as one sentence. */
class InstallerError extends Error {}

/** A response's body, or null once it runs past `limit` bytes or breaks off. */
async function cappedBody(res, limit) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of res.body ?? []) {
      size += chunk.length;
      if (size > limit) return null;
      chunks.push(Buffer.from(chunk));
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch Valve's Steam installer into `dir` over HTTPS, refusing any redirect
 * and anything too big to be it, and keep it only when Windows confirms
 * Valve signed it. Resolves with its path; nothing is run here.
 */
async function downloadSteamInstaller(
  dir,
  { fetch = globalThis.fetch, verify = signedByValve, files = fs } = {},
) {
  let res;
  try {
    res = await fetch(STEAM_INSTALLER_URL, { redirect: "error" });
  } catch {
    throw new InstallerError(
      "Steam's installer could not be downloaded. Check the connection and try again.",
    );
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (!res.ok || declared > MAX_INSTALLER_BYTES) {
    throw new InstallerError("Steam's installer could not be downloaded. Try again later.");
  }
  const bytes = await cappedBody(res, MAX_INSTALLER_BYTES);
  if (!bytes?.length) throw new InstallerError("Steam's installer could not be downloaded. Try again later.");
  files.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SteamSetup.exe");
  files.writeFileSync(file, bytes);
  if (!(await verify(file))) {
    files.rmSync(file, { force: true });
    throw new InstallerError("The downloaded installer is not signed by Valve, so it was deleted.");
  }
  return file;
}

/**
 * Download Valve's installer and open it for the owner, who clicks through
 * it: Windows asks them to allow it, and nothing is installed silently.
 * `open` is Electron's shell.openPath. Resolves with an error sentence, or
 * null once the installer is open.
 */
async function openSteamInstaller({ dir, open, platform = process.platform, ...options }) {
  if (platform !== "win32")
    return "Steam's installer is for Windows. Install Steam from store.steampowered.com.";
  try {
    const file = await downloadSteamInstaller(dir, options);
    const failed = await open(file);
    return failed ? "Steam's installer could not be opened. Try again." : null;
  } catch (cause) {
    return cause instanceof InstallerError
      ? cause.message
      : "Steam's installer could not be downloaded. Try again.";
  }
}

module.exports = {
  STEAM_INSTALLER_URL,
  MAX_INSTALLER_BYTES,
  manifestInstall,
  readInstalls,
  activeProcessFromReg,
  readSteamStatus,
  readSteam,
  isValveSignature,
  signedByValve,
  downloadSteamInstaller,
  openSteamInstaller,
};
