// Swiff host — Electron main process.
//
// The single reason this app exists instead of a browser tab: Chrome makes a
// human click "Share this screen" on the gaming PC. setDisplayMediaRequestHandler
// answers that request in code, so a rental machine needs nobody sitting at it.

const { app, BrowserWindow, desktopCapturer, ipcMain, safeStorage, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

// The machine key, encrypted by the OS for the logged-in Windows user. Never
// written in the clear: where encryption is unavailable it is not stored at
// all, and the owner pastes it again next launch.
const keyFile = () => path.join(app.getPath("userData"), "machine-key.bin");

ipcMain.handle("machine-key:load", () => {
  try {
    if (!safeStorage.isEncryptionAvailable()) return "";
    return safeStorage.decryptString(fs.readFileSync(keyFile()));
  } catch {
    return "";
  }
});

ipcMain.handle("machine-key:save", (_event, key) => {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (!key) {
    fs.rmSync(keyFile(), { force: true });
    return true;
  }
  fs.writeFileSync(keyFile(), safeStorage.encryptString(String(key)));
  return true;
});

// Chrome hides local IPs behind random `<uuid>.local` names, which the renter
// must resolve over mDNS. Windows-to-macOS that often fails, and most home
// routers will not hairpin the srflx address either, so two machines on the
// same LAN end up with no pair to try and ICE fails. This app shares the whole
// screen already; its LAN address is not the secret worth keeping.
app.commandLine.appendSwitch("disable-features", "WebRtcHideLocalIpsWithMdns");

// `titleBarOverlay` is Windows and Linux only. Passing it on macOS throws and
// the window never appears, with nothing logged.
const TITLE_BAR =
  process.platform === "darwin"
    ? { titleBarStyle: "hiddenInset" }
    : {
        titleBarStyle: "hidden",
        titleBarOverlay: { color: "#071019", symbolColor: "#8AA4BE", height: 38 },
      };

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 820,
    backgroundColor: "#071019", // matches --color-bg, so no white flash on open
    ...TITLE_BAR,
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  win.loadFile(path.join(__dirname, "dist", "index.html"));
  return win;
}

app.whenReady().then(() => {
  // Hand back the primary screen without showing a picker. `getDisplayMedia`
  // in the renderer resolves straight to it.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
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
            process.platform === "win32"
              ? { video: sources[0], audio: "loopback" }
              : { video: sources[0] },
          );
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

process.on("unhandledRejection", (cause) => {
  console.error("[swiff] startup failed:", cause);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
