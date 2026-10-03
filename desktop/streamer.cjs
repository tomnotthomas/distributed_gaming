// The streamer: this app started with --streamer, in the Windows account a
// renter plays in (or, with no session service installed, beside the owner's
// app). It never holds the machine key. Everything it knows arrives on stdin,
// one JSON line at a time, from whoever started it (session-host.cjs, or the
// session service on its behalf):
//
//   { url, hostId, sessionKey, appid }   first: the room, its session key, the game
//   { type: "key", sessionKey }          register again with a fresh key
//   { type: "launch-game" }              the session has started: launch the game
//   { type: "stop" }                     quit
//
// and everything it reports goes to stdout the same way: registered,
// peer-joined, peer-left { grace }, first-frame, game-started { appid },
// denied { reason }. stdin closing means whoever started it is gone: it quits.
//
// The window that captures the screen and holds the room (src/streamer.ts) is
// never shown: the renter sees their game, not this app.

const { app, BrowserWindow, desktopCapturer, ipcMain, session, shell, webContents } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { lineReader, streamerCommand, streamerEvent, streamerInit } = require("./session-host.cjs");

const INDEX = path.join(__dirname, "dist", "index.html");
const PRELOAD = path.join(__dirname, "streamer-preload.cjs");

// As in main.cjs: a renter on the same LAN needs this PC's real local address.
app.commandLine.appendSwitch("disable-features", "WebRtcHideLocalIpsWithMdns");
// Its own profile, so it never shares one with the owner's app.
app.setPath("userData", path.join(app.getPath("userData"), "streamer"));

let win = null;
let init = null;
/** Commands that arrived before the window could take them. */
const pending = [];

// stdin and stdout by their descriptors: on Windows, Electron is a GUI
// program and its process.stdin ends at once, though the pipe it was handed
// reads and writes fine.
const report = (event) => {
  try {
    fs.writeSync(1, `${JSON.stringify(event)}\n`);
  } catch {
    // Nobody is reading any more: stdin closing quits us.
  }
};

/** Where the game is launched: Steam, or a file the end-to-end tests read instead. */
function launchGame(appid) {
  const url = `steam://rungameid/${appid}`;
  const log = process.env.SWIFF_GAME_LAUNCH_LOG;
  if (log) return fs.promises.appendFile(log, `${url}\n`);
  return shell.openExternal(url);
}

function command(raw) {
  const valid = streamerCommand(raw);
  if (!valid) return;
  if (valid.type === "stop") return app.quit();
  if (valid.type === "launch-game") {
    launchGame(init.appid)
      .then(() => toWindow({ type: "game-launched" }))
      .catch(() => report({ type: "error", step: "launch-game" }));
    return;
  }
  toWindow(valid);
}

function toWindow(message) {
  if (win) win.webContents.send("streamer:command", message);
  else pending.push(message);
}

const input = fs.createReadStream(null, { fd: 0, autoClose: false });
input.on(
  "data",
  lineReader((value) => {
    if (init) return command(value);
    try {
      init = streamerInit(value);
    } catch {
      report({ type: "error", step: "init" });
      app.exit(2);
      return;
    }
    if (app.isReady()) open();
  }),
);
input.on("end", () => app.quit());
input.on("error", () => app.quit());

const fromStreamer = (event) => win !== null && event.sender === win.webContents;

// SWIFF_STREAMER_TEST_PATTERN=1 streams a moving test pattern instead of the
// screen: the end-to-end tests run where no display can be captured.
const testPattern = process.env.SWIFF_STREAMER_TEST_PATTERN === "1";

ipcMain.handle("streamer:init", (event) => (fromStreamer(event) ? { ...init, testPattern } : null));
ipcMain.on("streamer:report", (event, raw) => {
  if (!fromStreamer(event)) return;
  const valid = streamerEvent(raw);
  if (valid) report(valid);
});

function open() {
  if (win) return;
  win = new BrowserWindow({
    show: false,
    webPreferences: { preload: PRELOAD, backgroundThrottling: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.once("did-finish-load", () => {
    for (const message of pending.splice(0)) toWindow(message);
  });
  win.loadFile(INDEX, { query: { view: "streamer" } });
  win.on("closed", () => {
    win = null;
    app.quit();
  });
}

app.whenReady().then(() => {
  // The primary screen, with no picker, to the streamer's window only.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      const from = request.frame ? webContents.fromFrame(request.frame) : undefined;
      if (!win || from !== win.webContents) return callback({});
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => {
          if (!sources.length) return callback({});
          callback(
            process.platform === "win32" ? { video: sources[0], audio: "loopback" } : { video: sources[0] },
          );
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );
  if (init) open();
});

app.on("window-all-closed", () => app.quit());
