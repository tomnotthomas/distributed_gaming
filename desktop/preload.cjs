// The renderer's only privileged API. No node, no ipcRenderer, no file access:
// each call does exactly one thing, and main decides what it may touch.
//
//   loadMachineKey / saveMachineKey   this machine's key, kept encrypted by the
//                                     OS (safeStorage: DPAPI on Windows)
//   readPc                            the PC's parts and installed Steam games
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
  secondsSinceInput: () => ipcRenderer.invoke("pc:idle"),
  setGlance: (glance) => ipcRenderer.send("glance:set", glance),
  onTrayAction: (listener) => subscribe("tray:action", listener),
});
