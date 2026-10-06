// Swiff host — Electron main process.
//
// The single reason this app exists instead of a browser tab: Chrome makes a
// human click "Share this screen" on the gaming PC. setDisplayMediaRequestHandler
// answers that request in code, so a rental machine needs nobody sitting at it.

const {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  Menu,
  nativeImage,
  net,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
  webContents,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { readPc, readSteamArt, steamPathOnce, steamRootOnce, watchSteamGames } = require("./pc.cjs");
const {
  driverFolder,
  driverState,
  fetchLicence,
  installDriver,
  readManifest,
  removeDriver,
  supportedCard,
} = require("./nvidia.cjs");
const { installPlan, mokPlan, readRental, switchPlan } = require("./rental.cjs");
const { openSteamInstaller, readSteam } = require("./steam.cjs");
const { TRAY_ICON_SIZE, trayIconPixels } = require("./tray-icon.cjs");

const INDEX = path.join(__dirname, "dist", "index.html");
// Each window gets only its own calls: the app window its preload, the tray
// glance one that can show a snapshot and send back a named action, nothing else.
const PRELOAD = path.join(__dirname, "preload.cjs");
const TRAY_PRELOAD = path.join(__dirname, "tray-preload.cjs");

// `--demo` (npm run demo) opens the app on its labelled demo data instead of
// this PC's: the screens the platform cannot fill yet, walkable end to end.
const DEMO = process.argv.includes("--demo");
// `--nvidia-rental` lets rental mode take NVIDIA cards Swiff OS's driver runs.
// A test switch: NVIDIA in Swiff OS is off for owners until it has passed its
// test on real hardware (swiff-os/NVIDIA.md).
const NVIDIA_RENTAL = process.argv.includes("--nvidia-rental");
/** The app page's query string: `extra`, plus demo=1 in demo mode. */
const query = (extra = {}) => ({ ...extra, ...(DEMO ? { demo: "1" } : {}) });

// The machine key, encrypted by the OS for the logged-in Windows user. Never
// written in the clear: where encryption is unavailable it is not stored at
// all, and the owner pastes it again next launch.
const keyFile = () => path.join(app.getPath("userData"), "machine-key.bin");

/** Whether an IPC call came from the app window: every call but the tray's must. */
const fromApp = (event) => win !== null && event.sender === win.webContents;

ipcMain.handle("machine-key:load", (event) => {
  if (!fromApp(event)) return "";
  try {
    if (!safeStorage.isEncryptionAvailable()) return "";
    return safeStorage.decryptString(fs.readFileSync(keyFile()));
  } catch {
    return "";
  }
});

ipcMain.handle("machine-key:save", (event, key) => {
  if (!fromApp(event) || !safeStorage.isEncryptionAvailable()) return false;
  if (!key) {
    fs.rmSync(keyFile(), { force: true });
    return true;
  }
  fs.writeFileSync(keyFile(), safeStorage.encryptString(String(key)));
  return true;
});

// What the app can read about this PC: its parts and its installed Steam games.
ipcMain.handle("pc:read", (event) => (fromApp(event) ? readPc({ app, screen }) : null));

// Getting this PC ready to host (steam.cjs): whether Steam is installed and
// signed in, and the games it is installing, read fresh on each call.
ipcMain.handle("steam:read", (event) => (fromApp(event) ? readSteam() : null));

// Valve's installer, downloaded and opened for the owner to click through.
// One at a time: a second ask while one is under way gets the same answer.
let installingSteam = null;
ipcMain.handle("steam:install", (event) => {
  if (!fromApp(event)) return "Not allowed.";
  installingSteam ??= openSteamInstaller({
    dir: path.join(app.getPath("temp"), "SwiffHost"),
    open: (file) => shell.openPath(file),
  }).finally(() => {
    installingSteam = null;
  });
  return installingSteam;
});

// Games installed or removed while the app runs go to the app window as the
// whole list, so the platform hears of them without a restart.
let stopWatchingGames = null;
/** Start watching Steam's libraries, once; the list goes to the app window as it changes. */
async function watchGames() {
  const steamPath = await steamPathOnce();
  if (stopWatchingGames) return;
  stopWatchingGames = watchSteamGames(
    (games) => {
      // A closed window has no one to tell: its next load reads the games afresh.
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed())
        win.webContents.send("pc:games", games);
    },
    { steamPath },
  );
}

// Rental mode (rental.cjs): what Swiff OS needs from this PC, read fresh and
// without administrator rights, and the steps that would install it or switch
// to and from it, or confirm its key again. The steps are previews: nothing
// here runs them.
ipcMain.handle("rental:read", (event) => (fromApp(event) ? readRentalHere() : null));
ipcMain.handle("rental:plan", async (event, ask) => {
  if (!fromApp(event) || !ask || typeof ask !== "object") return null;
  if (ask.kind === "start" || ask.kind === "stop") return switchPlan(ask.kind);
  if (ask.kind === "mok") return mokPlan();
  if (ask.kind !== "install") return null;
  const rental = await readRentalHere();
  if (!rental) return null;
  try {
    return installPlan(rental, { target: typeof ask.target === "string" ? ask.target : null });
  } catch {
    return null;
  }
});

// NVIDIA's driver (nvidia.cjs), which Swiff does not ship: the owner reads
// NVIDIA's licence, accepts it and Swiff's terms on the Rental mode screen, and
// the driver comes from Ubuntu onto their games drive. Only with
// --nvidia-rental, until NVIDIA has passed its hardware test, and only for a
// card Swiff OS runs. Downloads go through Chromium's network stack (net.fetch),
// which follows the PC's proxy settings.
const NVIDIA_MANIFEST = (() => {
  try {
    return readManifest();
  } catch {
    return null;
  }
})();
const nvidiaDriver = (letter) =>
  NVIDIA_MANIFEST
    ? driverState({ manifest: NVIDIA_MANIFEST, letter, dataDir: app.getPath("userData") })
    : null;
const readRentalHere = () => readRental({ nvidiaRental: NVIDIA_RENTAL, nvidiaDriver });
/** The install under way, to stop it; null when none is. */
let nvidiaInstall = null;
/** Progress to the window at most this often: a download is thousands of chunks. */
const NVIDIA_PROGRESS_MS = 200;

ipcMain.handle("rental:nvidia-licence", (event) =>
  fromApp(event) && NVIDIA_RENTAL && NVIDIA_MANIFEST
    ? fetchLicence({ manifest: NVIDIA_MANIFEST, fetch: net.fetch })
    : null,
);
ipcMain.handle("rental:nvidia-install", async (event, ask) => {
  if (!fromApp(event) || !NVIDIA_RENTAL || !NVIDIA_MANIFEST || nvidiaInstall) return null;
  // The owner ticks both on the screen, each time they install.
  if (ask?.licence !== true || ask?.terms !== true) return null;
  const rental = await readRentalHere();
  const games = rental?.games;
  if (!games || games.bitlocker === "on" || !supportedCard(rental.facts.gpus)) return null;
  const sender = event.sender;
  let sent = 0;
  nvidiaInstall = new AbortController();
  try {
    return await installDriver({
      manifest: NVIDIA_MANIFEST,
      folder: driverFolder(games.letter, NVIDIA_MANIFEST.version),
      dataDir: app.getPath("userData"),
      free: rental.facts.volumes.find((v) => v.letter === games.letter)?.free ?? null,
      fetch: net.fetch,
      signal: nvidiaInstall.signal,
      onProgress: (done, total) => {
        if (sender.isDestroyed() || (done < total && Date.now() - sent < NVIDIA_PROGRESS_MS)) return;
        sent = Date.now();
        sender.send("rental:nvidia-progress", { done, total });
      },
    });
  } finally {
    nvidiaInstall = null;
  }
});
ipcMain.handle("rental:nvidia-cancel", (event) => {
  if (fromApp(event)) nvidiaInstall?.abort();
});
ipcMain.handle("rental:nvidia-remove", async (event) => {
  if (!fromApp(event) || !NVIDIA_MANIFEST || nvidiaInstall) return null;
  const games = (await readRentalHere())?.games;
  if (!games) return null;
  return removeDriver({
    folder: driverFolder(games.letter, NVIDIA_MANIFEST.version),
    dataDir: app.getPath("userData"),
  });
});

// Seconds since anyone touched this PC's keyboard or mouse. The app injects no
// input of its own, so during a session this is the owner sitting down.
ipcMain.handle("pc:idle", (event) => (fromApp(event) ? powerMonitor.getSystemIdleTime() : null));

// Game art, from the copy Steam keeps on this PC (pc.cjs): the windows load no
// remote content, asked for as swiff-art://steam/<appid>/<kind>. Registered
// before the app is ready, as Electron requires.
protocol.registerSchemesAsPrivileged([{ scheme: "swiff-art", privileges: { standard: true, secure: true } }]);

// Chrome hides local IPs behind random `<uuid>.local` names, which the renter
// must resolve over mDNS. Windows-to-macOS that often fails, and most home
// routers will not hairpin the srflx address either, so two machines on the
// same LAN end up with no pair to try and ICE fails. This app shares the whole
// screen already; its LAN address is not the secret worth keeping.
app.commandLine.appendSwitch("disable-features", "WebRtcHideLocalIpsWithMdns");

// Toasts on Windows ("Notify me at 22:40") need the app's own id.
if (process.platform === "win32") app.setAppUserModelId("com.swiff.host");

// `titleBarOverlay` is Windows and Linux only. Passing it on macOS throws and
// the window never appears, with nothing logged. The overlay takes the rail's
// grey, so the window controls sit on the app rather than over it.
const TITLE_BAR =
  process.platform === "darwin"
    ? { titleBarStyle: "hiddenInset" }
    : {
        titleBarStyle: "hidden",
        titleBarOverlay: { color: "#c9cac9", symbolColor: "#242525", height: 38 },
      };

/**
 * Links the app may hand to the OS: installing a game in Steam, opening
 * Steam (to sign in) or its library, and Steam's store.
 */
const EXTERNAL =
  /^(steam:\/\/install\/\d+|steam:\/\/open\/(main|games)|https:\/\/store\.steampowered\.com\/app\/\d+\/?)$/;

/** Open allowed links outside the app; the app itself never navigates away. */
function guardNavigation(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event) => event.preventDefault());
}

let win = null;
let quitting = false;

/** Open the app window; closing it hides it to the tray. */
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#e8e9e8", // matches the panel, so no white flash on open
    ...TITLE_BAR,
    webPreferences: { preload: PRELOAD },
  });
  guardNavigation(win.webContents);
  win.loadFile(INDEX, { query: query() });
  // Closing the window keeps Swiff in the tray: a player's session must not end
  // because the owner closed a window. Quit is in the tray's menu.
  win.on("close", (event) => {
    if (quitting || !tray) return;
    event.preventDefault();
    win.hide();
  });
  win.on("closed", () => {
    win = null;
  });
  return win;
}

/** Bring the app window up, opening it again if it was destroyed. */
function showWindow() {
  if (!win) createWindow();
  win.show();
  win.focus();
}

// --- tray -------------------------------------------------------------------
//
// The tray glance: a small window by the tray icon with what Swiff is doing,
// for an owner who is away from the app. The main window owns the state and
// sends a plain snapshot of it here; the glance sends back one of a few named
// actions, which go to the main window to carry out.

const GLANCE = { width: 360, height: 430 };
const TRAY_ACTIONS = new Set(["stop-new", "allow-new", "pause", "resume", "retry"]);
/** A glance is a few short strings; anything bigger is not one. */
const MAX_GLANCE_BYTES = 8 * 1024;

let tray = null;
let glance = null;
let latest = null;

/** A ring with a dot in it, drawn in code: the menu bar's and the tray's icon. */
function trayIcon() {
  const size = TRAY_ICON_SIZE;
  const pixels = trayIconPixels(size);
  const image = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 });
  if (process.platform === "darwin") image.setTemplateImage(true);
  return image;
}

/** Place the glance by the tray icon, inside the screen it sits on. */
function placeGlance() {
  const icon = tray.getBounds();
  const { workArea } = screen.getDisplayNearestPoint({ x: icon.x, y: icon.y });
  const x = Math.round(
    Math.min(
      Math.max(icon.x + icon.width / 2 - GLANCE.width / 2, workArea.x),
      workArea.x + workArea.width - GLANCE.width,
    ),
  );
  // A tray at the bottom (Windows) opens the glance upward; a menu bar at the top, downward.
  const below = icon.y < workArea.y + workArea.height / 2;
  const y = below ? icon.y + icon.height + 4 : icon.y - GLANCE.height - 4;
  glance.setPosition(x, Math.round(Math.max(workArea.y, y)));
}

/** Show the tray glance by the tray icon, or hide it when it is showing. */
function toggleGlance() {
  if (glance?.isVisible()) return glance.hide();
  if (!glance) {
    glance = new BrowserWindow({
      ...GLANCE,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: "#e8e9e8",
      webPreferences: { preload: TRAY_PRELOAD },
    });
    guardNavigation(glance.webContents);
    glance.loadFile(INDEX, { query: query({ view: "tray" }) });
    glance.on("blur", () => glance?.hide());
    glance.on("closed", () => {
      glance = null;
    });
  }
  placeGlance();
  glance.show();
  glance.focus();
}

/** The tray icon: a click toggles the glance, its menu opens or quits Swiff. */
function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("Swiff Host");
  tray.on("click", toggleGlance);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Swiff", click: showWindow },
      { type: "separator" },
      { label: "Quit Swiff Host", click: () => app.quit() },
    ]),
  );
}

ipcMain.on("glance:set", (event, snapshot) => {
  if (!fromApp(event)) return;
  try {
    if (!snapshot || typeof snapshot !== "object") return;
    if (JSON.stringify(snapshot).length > MAX_GLANCE_BYTES) return;
  } catch {
    return;
  }
  latest = snapshot;
  if (tray && typeof snapshot.status === "string")
    tray.setToolTip(`Swiff Host: ${snapshot.status}`.slice(0, 120));
  glance?.webContents.send("glance", latest);
});

ipcMain.handle("glance:get", (event) => (glance && event.sender === glance.webContents ? latest : null));

ipcMain.on("tray:action", (event, action) => {
  if (!glance || event.sender !== glance.webContents) return;
  if (action === "open") {
    glance.hide();
    showWindow();
  } else if (TRAY_ACTIONS.has(action)) {
    win?.webContents.send("tray:action", action);
  }
});

app.whenReady().then(() => {
  // Hand back the primary screen without showing a picker. `getDisplayMedia`
  // in the renderer resolves straight to it.
  protocol.handle("swiff-art", async (request) => {
    const art = await readSteamArt(request.url, await steamRootOnce());
    return art
      ? new Response(art, { headers: { "content-type": "image/jpeg", "cache-control": "max-age=3600" } })
      : new Response(null, { status: 404 });
  });

  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      // Only the app window shares the screen; the tray glance never can.
      const from = request.frame ? webContents.fromFrame(request.frame) : undefined;
      if (!win || from !== win.webContents) return callback({});
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => {
          if (!sources.length) return callback({});
          // `"loopback"` is what the machine is playing — the game — and is
          // Windows only. Not `true`, which would be a microphone nobody is
          // speaking into. `"loopbackWithMute"` silences the host's own
          // speakers, which is wrong for a machine with nobody sitting at it
          // and one more state to get stuck in.
          callback(
            process.platform === "win32" ? { video: sources[0], audio: "loopback" } : { video: sources[0] },
          );
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );

  createWindow();
  void watchGames();
  try {
    createTray();
  } catch (cause) {
    // A desktop with no tray (a bare Linux session) still gets the app.
    console.warn("[swiff] no tray:", cause instanceof Error ? cause.message : cause);
  }
  app.on("activate", showWindow);
});

app.on("before-quit", () => {
  quitting = true;
  stopWatchingGames?.();
});

process.on("unhandledRejection", (cause) => {
  console.error("[swiff] startup failed:", cause);
});

// The tray keeps the app running with no window open; Quit is in its menu.
// Without a tray there is nothing to come back from, so the app quits.
app.on("window-all-closed", () => {
  if (!tray && process.platform !== "darwin") app.quit();
});
