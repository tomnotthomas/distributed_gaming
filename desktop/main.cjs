// Swiff host — Electron main process.
//
// Rental mode, with Swiff OS, is the only way to host. Sharing the owner's own
// Windows desktop is a development path only (share-gate.cjs): there,
// setDisplayMediaRequestHandler answers Chrome's "Share this screen" in code.

const {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
  webContents,
} = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { readPc, readSteamArt, steamPathOnce, steamRootOnce, watchSteamGames } = require("./pc.cjs");
const { testBuild } = require("./build-kind.cjs");
const { MANIFEST, readImageSet, trustOf } = require("./image-set.cjs");
const { downloadSet, sourceOf } = require("./image-download.cjs");
const { runPlan, startWorker } = require("./rental-exec.cjs");
const { BITLOCKER_PANEL, drivesOff, recoveryOf, recoveryStore } = require("./recovery-key.cjs");
const { bootTrail, canAnswer, keyOf, keyStep, keyStore } = require("./rental-key.cjs");
const { expectOf, removalOf, removalStep, removalStore } = require("./rental-removal.cjs");
const {
  BOOT_CHANGES,
  bitlockerDrives,
  installPlan,
  keyRemovalPlan,
  mokPlan,
  readRental,
  removePlan,
  switchPlan,
  uninstallPlan,
} = require("./rental.cjs");
const { openSteamInstaller, readSteam } = require("./steam.cjs");
const { TRAY_ICON_SIZE, trayIconPixels } = require("./tray-icon.cjs");
const { windowsShareAllowed } = require("./share-gate.cjs");

/** The signed-in user's name, never sent in an error report; "" where the OS will not say. */
function userName() {
  try {
    return os.userInfo().username;
  } catch {
    return "";
  }
}

// Error reports to PostHog (src/mainErrors.ts), built into dist/ beside the
// window, to the project the Lanterel server names (kept in the app's data
// between starts). A PC with DO_NOT_TRACK set sends none; and an unbuilt
// checkout has no dist/ to load, so it runs without them.
/** The project Lanterel Host reports to now, for Lanterel OS's ESP too: null when there is none. */
let errorProject = () => null;
try {
  const errorProjectFile = () => path.join(app.getPath("userData"), "error-reports.json");
  errorProject = require("./dist/main-errors.cjs").startErrorTracking({
    app,
    ipcMain,
    proc: process,
    env: process.env,
    fromWindow: (event) =>
      (win !== null && event.sender === win.webContents) ||
      (glance !== null && event.sender === glance.webContents),
    secrets: [os.homedir(), userName()],
    // The project's key is PostHog's public client token, never a personal API
    // key: projectOf (packages/error-tracking) takes only phc_ keys.
    store: {
      read: () => JSON.parse(fs.readFileSync(errorProjectFile(), "utf8")),
      write: (kept) => fs.writeFileSync(errorProjectFile(), `${JSON.stringify(kept)}\n`),
    },
  }).project;
} catch {
  // No reports, then; the app is the same without them.
}

const INDEX = path.join(__dirname, "dist", "index.html");
// Each window gets only its own calls: the app window its preload, the tray
// glance one that can show a snapshot and send back a named action, nothing else.
const PRELOAD = path.join(__dirname, "preload.cjs");
const TRAY_PRELOAD = path.join(__dirname, "tray-preload.cjs");

// `--demo` (npm run demo) opens the app on its labelled demo data instead of
// this PC's: the screens the platform cannot fill yet, walkable end to end.
const DEMO = process.argv.includes("--demo");
// One Swiff Host at a time. Two would each run their own installer, and the
// second one's administrator helper would wait behind the first for ever. A
// second launch hands over to the first, which comes to the front.
if (!app.requestSingleInstanceLock()) app.exit(0);
else app.on("second-instance", () => showWindow());

/** A build packaged by `npm run pack:test` (build-kind.cjs). */
const TEST_BUILD = testBuild();
/** The app page's query string: `extra`, plus demo=1 in demo mode and build=test in a test build. */
const query = (extra = {}) => ({
  ...extra,
  ...(DEMO ? { demo: "1" } : {}),
  ...(TEST_BUILD ? { build: "test" } : {}),
});

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
// without administrator rights, and the steps that install it, take it off
// again, start it once, or confirm its key again. Main keeps the plan it last
// showed the window, and only that plan runs (rental-exec.cjs), through one
// elevated worker that Windows starts after one UAC prompt. The owner's one OK
// starts the run, and every step runs by itself until a restart: that waits
// for Restart now, so the owner has the code written down first.

/** Where Swiff OS's image set is (image-set.cjs). */
const imageDir = () => process.env.SWIFF_OS_IMAGE_DIR || path.join(app.getPath("userData"), "swiff-os");
/** Swiff OS's image set, signed by a key this build trusts. */
const imageSet = () => readImageSet(imageDir(), { trust: trustOf({ dev: TEST_BUILD }) });
/**
 * The image set's version, or null when there is none Swiff signed; `imageRefused` when there is one
 * on this PC all the same.
 */
const imageRead = () => {
  try {
    return { image: imageSet().version, imageRefused: false };
  } catch {
    return { image: null, imageRefused: fs.existsSync(path.join(imageDir(), MANIFEST)) };
  }
};
/** The image set's download under way (image-download.cjs), so only one runs at a time: a second ask gets its outcome. */
let imageDownload = null;
ipcMain.handle("image:download", (event) => {
  if (!fromApp(event)) return null;
  if (imageDownload) return imageDownload;
  if (imageRead().image) return null;
  const tell = (p) => {
    if (win && !win.isDestroyed()) win.webContents.send("image:progress", p);
  };
  let last = 0;
  imageDownload = downloadSet({
    url: sourceOf(),
    dir: imageDir(),
    trust: trustOf({ dev: TEST_BUILD }),
    onProgress: (p) => {
      // A few a second is plenty for the screen.
      const now = Date.now();
      if (p.phase !== "check" && now - last < 250 && p.done < p.total) return;
      last = now;
      tell(p);
    },
  })
    .then(
      (version) => ({ ok: true, version }),
      (error) => ({ ok: false, error: error.message, retry: error.retry !== false }),
    )
    .finally(() => {
      imageDownload = null;
    });
  return imageDownload;
});
/** The OS's encryption for the logged-in Windows user, as the machine key has it; null where there is none. */
const crypt = () =>
  safeStorage.isEncryptionAvailable()
    ? {
        seal: (text) => safeStorage.encryptString(text),
        open: (sealed) => safeStorage.decryptString(sealed),
      }
    : null;
/**
 * What the app queued for Swiff's key, and what the owner said about its blue screen (rental-key.cjs).
 * Its code is encrypted by the OS for the logged-in Windows user, as the machine key is.
 */
const keys = () => keyStore(app.getPath("userData"), crypt());
/** Remove Swiff OS across its restarts (rental-removal.cjs): its key's code sealed the same way. */
const removals = () => removalStore(app.getPath("userData"), crypt());
/** That the owner saved their BitLocker recovery key, and for which drives: never the key (recovery-key.cjs). */
const recoveries = () => recoveryStore(app.getPath("userData"));
/** When this PC last started: a key request queued before it has met its blue screen. */
const bootAt = () => Date.now() - os.uptime() * 1000;

const RUNNABLE = new Set(["install", "uninstall", "mok", "unkey", "remove", "once"]);
/** A step that restarts the PC: never run by itself, only on the owner's Restart now. */
const restarts = (step) => step.ops.some((o) => o.op === "restart");
/** The plan on the window's screen, which `rental:run` runs; whether a run is under way. */
let rentalPlan = null;
let rentalRun = null;
/** What a remove plan's disk part must leave (rental-removal.cjs expectOf), from the read it was planned on. */
let rentalExpect = null;
/** A run finished up to its restart: Restart now may restart the PC. */
let restartReady = false;
/** The PC's last read: which drives BitLocker protects, for the recovery key's gate. */
let lastRead = null;

/**
 * Whether the owner still has to save a BitLocker recovery key before a boot change (recovery-key.cjs),
 * from this read: a drive it saw without BitLocker loses its confirmation first, so protecting it again
 * asks again.
 */
function recoveryNow(read) {
  recoveries().forget(drivesOff(read));
  return recoveryOf(recoveries().read(), bitlockerDrives(read));
}

ipcMain.handle("rental:read", async (event) => {
  if (!fromApp(event)) return null;
  const read = await readRental();
  if (!read) return null;
  lastRead = read;
  // Swiff OS gone, or never there: an old code or answer means nothing any more.
  if (!read.facts.install) keys().forget();
  const trail = bootTrail();
  return {
    ...read,
    ...imageRead(),
    key: keyOf(keys().read(), bootAt(), trail),
    removal: removalOf(removals().read(), bootAt(), read.facts, trail),
    recovery: recoveryNow(read),
  };
});
ipcMain.handle("rental:plan", async (event, ask) => {
  if (!fromApp(event) || !ask || typeof ask !== "object" || rentalRun) return null;
  rentalPlan = null;
  rentalExpect = null;
  let plan = null;
  try {
    if (ask.kind === "start" || ask.kind === "stop" || ask.kind === "once")
      plan = switchPlan(ask.kind, {
        // The EK the app registered: the TPM step stops before any boot change when the TPM has another.
        registered:
          ask.registered === null || typeof ask.registered === "string" ? ask.registered : undefined,
      });
    else if (ask.kind === "remove") {
      const rental = await readRental();
      if (!rental) return null;
      lastRead = rental;
      plan = removePlan(rental, { key: typeof ask.key === "boolean" ? ask.key : removeKeyFirst(rental) });
      if (plan.phase === "disk") rentalExpect = expectOf(rental.facts.install, bitlockerDrives(rental));
    }
    // The key's restarts suspend BitLocker on C: when it is on: the read says.
    else if (ask.kind === "mok") plan = mokPlan(undefined, await readRental());
    else if (ask.kind === "unkey") plan = keyRemovalPlan(undefined, await readRental());
    else if (ask.kind === "install" || ask.kind === "uninstall") {
      const rental = await readRental();
      if (!rental) return null;
      plan =
        ask.kind === "uninstall"
          ? uninstallPlan(rental)
          : installPlan(rental, {
              target: typeof ask.target === "string" ? ask.target : null,
              layout: imageSet().layout,
              errorReports: errorProject(),
            });
    }
  } catch {
    return null;
  }
  if (plan && RUNNABLE.has(plan.kind)) rentalPlan = plan;
  return plan;
});
/**
 * Whether Remove Swiff OS starts with Swiff's key: the install finished and queued it, and nothing
 * says it is off already (its removal met its restart, the owner said it did not go in, or this
 * start's log showed it did not).
 */
function removeKeyFirst(rental) {
  const install = rental.facts.install;
  if (!install?.complete || !install.mok) return false;
  if (removalOf(removals().read(), bootAt())?.state === "finish") return false;
  const key = keyOf(keys().read(), bootAt(), bootTrail());
  return !key || key.state === "confirmed" || key.state === "ask";
}
ipcMain.handle("rental:run", async (event) => {
  if (!fromApp(event) || !rentalPlan || rentalRun) return null;
  const plan = rentalPlan;
  const expect = rentalExpect;
  // Nothing changes what the PC starts while a drive's BitLocker recovery key is not saved: read the
  // PC now, since BitLocker may have been turned on since the screen's read, and refuse when it cannot be read.
  if (BOOT_CHANGES.has(plan.kind)) {
    const now = await readRental();
    if (now) lastRead = now;
    if (!now || !recoveryNow(now).saved)
      return {
        status: "failed",
        done: [],
        failed: { step: "recovery", op: "recovery", error: "Save your BitLocker recovery key first." },
        results: [],
      };
  }
  rentalRun = {};
  restartReady = false;
  const tell = (e) => {
    if (win && !win.isDestroyed()) win.webContents.send("rental:event", e);
  };
  let worker;
  try {
    worker = await startWorker({
      imageDir: imageDir(),
      // This app again, as the worker (start.cjs); `electron .` needs the app's folder first.
      command: (pipe, token, dir) => ({
        file: process.execPath,
        args: [...(process.defaultApp ? [app.getAppPath()] : []), "--swiff-rental-worker", pipe, token, dir],
      }),
    });
  } catch (error) {
    rentalRun = null;
    return {
      status: "failed",
      done: [],
      failed: { step: "elevate", op: "elevate", error: error.message },
      results: [],
    };
  }
  try {
    const outcome = await runPlan(plan, {
      apply: worker.apply,
      // The owner agreed to every step at once, with the OK that started this run.
      confirm: async () => true,
      only: plan.steps.filter((s) => !restarts(s)).map((s) => s.id),
      onEvent: (e) => {
        // The key's request is in the firmware, or its removal: the key's file must outlive this window.
        if (e.type === "step" && e.state === "done") {
          keyStep(keys(), plan, e.id, Date.now());
          // Remove Swiff OS: its key's restart, then the start that shows Windows after it.
          removalStep(removals(), plan, e.id, Date.now(), expect);
        }
        tell(e);
      },
    });
    restartReady = outcome.status === "done" && plan.steps.some(restarts);
    return outcome;
  } finally {
    worker.close();
    rentalRun = null;
    rentalPlan = null;
  }
});
// Restart now: after a run that ended at its restart, or with a key request still waiting for one.
ipcMain.handle("rental:restart", async (event) => {
  if (!fromApp(event) || rentalRun) return false;
  const waiting =
    keyOf(keys().read(), bootAt())?.state === "queued" ||
    ["queued", "restart"].includes(removalOf(removals().read(), bootAt())?.state);
  if (!restartReady && !waiting) return false;
  try {
    await promisify(execFile)("shutdown.exe", ["/r", "/t", "5"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
});
// Send details to Swiff: what failed, at which step, and this PC's rental checks, never files or
// account names. Kept with the app's data for Swiff to collect until the platform takes reports.
ipcMain.handle("rental:report", (event, report) => {
  if (!fromApp(event) || !report || typeof report !== "object") return null;
  const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  const at = Date.now();
  const body = {
    at: new Date(at).toISOString(),
    app: app.getVersion(),
    step: text(report.step, 64),
    error: text(report.error, 4000),
    checks: Array.isArray(report.checks)
      ? report.checks.slice(0, 40).map((c) => ({ id: text(c?.id, 32), value: text(c?.value, 120) }))
      : [],
  };
  try {
    const dir = path.join(app.getPath("userData"), "rental-reports");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${body.at.replace(/[:.]/g, "-")}.json`),
      `${JSON.stringify(body, null, 2)}\n`,
    );
    return at;
  } catch {
    return null;
  }
});
// The owner's word that they saved their BitLocker recovery key, for the drives BitLocker protects
// now. Swiff never reads the key: only that they said so, and when.
ipcMain.handle("rental:recovery-saved", async (event) => {
  if (!fromApp(event)) return false;
  const read = await readRental();
  if (read) lastRead = read;
  const drives = bitlockerDrives(lastRead);
  if (!drives.length) return true;
  recoveries().saved(drives, Date.now());
  return true;
});
// Windows' own BitLocker page, where Back up your recovery key is: false where it did not open.
ipcMain.handle("rental:open-bitlocker", async (event) => {
  if (!fromApp(event) || process.platform !== "win32") return false;
  try {
    await promisify(execFile)(BITLOCKER_PANEL.file, BITLOCKER_PANEL.args, { windowsHide: false });
    return true;
  } catch {
    return false;
  }
});
// The owner has seen how Remove Swiff OS ended: its record goes.
ipcMain.handle("rental:removal-seen", (event) => {
  if (!fromApp(event)) return false;
  if (removalOf(removals().read(), bootAt())?.state === "checked") removals().forget();
  return true;
});
// The owner's word on the blue screen, which Windows cannot see.
ipcMain.handle("rental:key-answer", (event, yes) => {
  if (!fromApp(event) || !canAnswer(keyOf(keys().read(), bootAt()))) return false;
  keys().answer(yes === true);
  return true;
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
if (process.platform === "win32") app.setAppUserModelId("com.lanterel.host");

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
 * Steam (to sign in) or its library, Steam's store, and the page where a
 * Microsoft account keeps its BitLocker recovery keys.
 */
const EXTERNAL =
  /^(steam:\/\/install\/\d+|steam:\/\/open\/(main|games)|https:\/\/store\.steampowered\.com\/app\/\d+\/?|https:\/\/aka\.ms\/myrecoverykey)$/;

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
  if (win.isMinimized()) win.restore();
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
  tray.setToolTip("Lanterel Host");
  tray.on("click", toggleGlance);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Lanterel", click: showWindow },
      { type: "separator" },
      { label: "Quit Lanterel Host", click: () => app.quit() },
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
    tray.setToolTip(`Lanterel Host: ${snapshot.status}`.slice(0, 120));
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
  protocol.handle("swiff-art", async (request) => {
    const art = await readSteamArt(request.url, await steamRootOnce());
    return art
      ? new Response(art, { headers: { "content-type": "image/jpeg", "cache-control": "max-age=3600" } })
      : new Response(null, { status: 404 });
  });

  // Development only: hand back the primary screen without showing a picker, so
  // `getDisplayMedia` in the renderer resolves straight to it. In the app hosts
  // download no handler is registered, and a stray request gets no source.
  if (windowsShareAllowed({ isPackaged: app.isPackaged, env: process.env }))
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
