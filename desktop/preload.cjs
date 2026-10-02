// The renderer's only privileged API. No node, no ipcRenderer, no file access:
// each call does exactly one thing, and main decides what it may touch.
//
//   loadMachineKey / saveMachineKey   this machine's key, kept encrypted by the
//                                     OS (safeStorage: DPAPI on Windows)
//   readPc                            the PC's parts and installed Steam games
//   secondsSinceInput                 how long since the keyboard or mouse was used
//   setGlance / onGlance              the tray glance's snapshot, main window → tray
//   trayAction / onTrayAction         a named action from the tray glance → main window

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
  secondsSinceInput: () => ipcRenderer.invoke("pc:idle"),
  setGlance: (glance) => ipcRenderer.send("glance:set", glance),
  onGlance: (listener) => {
    void ipcRenderer.invoke("glance:get").then((glance) => glance && listener(glance));
    return subscribe("glance", listener);
  },
  trayAction: (action) => ipcRenderer.send("tray:action", String(action)),
  onTrayAction: (listener) => subscribe("tray:action", listener),
});
