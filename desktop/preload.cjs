// The renderer's only privileged API. No node, no ipcRenderer, no file access:
// each call does exactly one thing, and main decides what it may touch.
//
//   loadMachineKey / saveMachineKey   this machine's key, kept encrypted by the
//                                     OS (safeStorage: DPAPI on Windows)
//   readPc                            the PC's parts and installed Steam games
//   onGamesChanged                    the installed games, again, whenever they change
//   secondsSinceInput                 how long since the keyboard or mouse was used
//   setGlance                         the tray glance's snapshot, to the tray
//   onTrayAction                      a named action the tray glance sends back
//   sessionLogon / sessionLaunch      a renter's session (session-host.cjs): sign
//   sessionSend / sessionEnd          the renter in, start this app's streamer with
//   onSessionEvent                    a session key, tell it what next, give the PC
//                                     back; and what the streamer reports
//
// The tray glance has its own, smaller preload (tray-preload.cjs).

const { contextBridge, ipcRenderer } = require("electron");

/** Subscribe `listener` to `channel`'s payloads, without handing it the IPC event. */
function subscribe(channel, listener) {
  const forward = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, forward);
  return () => ipcRenderer.removeListener(channel, forward);
}

contextBridge.exposeInMainWorld("swiffHost", {
  loadMachineKey: () => ipcRenderer.invoke("machine-key:load"),
  saveMachineKey: (key) => ipcRenderer.invoke("machine-key:save", String(key)),
  readPc: () => ipcRenderer.invoke("pc:read"),
  onGamesChanged: (listener) => subscribe("pc:games", listener),
  secondsSinceInput: () => ipcRenderer.invoke("pc:idle"),
  setGlance: (glance) => ipcRenderer.send("glance:set", glance),
  onTrayAction: (listener) => subscribe("tray:action", listener),
  sessionLogon: () => ipcRenderer.invoke("session:logon"),
  sessionLaunch: (init) => ipcRenderer.invoke("session:launch", init),
  sessionSend: (command) => ipcRenderer.invoke("session:send", command),
  sessionEnd: () => ipcRenderer.invoke("session:end"),
  onSessionEvent: (listener) => subscribe("session:event", listener),
});
