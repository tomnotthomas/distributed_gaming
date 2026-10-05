// The renderer's only privileged API. No node, no ipcRenderer, no file access:
// each call does exactly one thing, and main decides what it may touch.
//
//   loadMachineKey / saveMachineKey   this machine's key, kept encrypted by the
//                                     OS (safeStorage: DPAPI on Windows)
//   readPc                            the PC's parts and installed Steam games
//   readSteam                         Steam on this PC: installed, signed in, installing
//   installSteam                      download Valve's installer and open it for the owner
//   onGamesChanged                    the installed games, again, whenever they change
//   readRental                        what rental mode needs from this PC, and whether it is installed
//   planRental                        the steps that would install rental mode or switch to it, as a preview
//   secondsSinceInput                 how long since the keyboard or mouse was used
//   setGlance                         the tray glance's snapshot, to the tray
//   onTrayAction                      a named action the tray glance sends back
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
  readSteam: () => ipcRenderer.invoke("steam:read"),
  installSteam: () => ipcRenderer.invoke("steam:install"),
  onGamesChanged: (listener) => subscribe("pc:games", listener),
  readRental: () => ipcRenderer.invoke("rental:read"),
  planRental: (ask) =>
    ipcRenderer.invoke("rental:plan", { kind: String(ask?.kind), target: ask?.target ?? null }),
  secondsSinceInput: () => ipcRenderer.invoke("pc:idle"),
  setGlance: (glance) => ipcRenderer.send("glance:set", glance),
  onTrayAction: (listener) => subscribe("tray:action", listener),
});
