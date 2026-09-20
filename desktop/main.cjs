// Swiff host — Electron main process.
//
// The single reason this app exists instead of a browser tab: Chrome makes a
// human click "Share this screen" on the gaming PC. setDisplayMediaRequestHandler
// answers that request in code, so a rental machine needs nobody sitting at it.

const { app, BrowserWindow, desktopCapturer, session } = require("electron");
const path = require("node:path");

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
        .then((sources) => callback(sources.length ? { video: sources[0] } : {}))
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
