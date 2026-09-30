// The renderer's only privileged API: read and write this machine's key, which
// main keeps encrypted with the OS (safeStorage: DPAPI on Windows). No node,
// no ipcRenderer, no file access — two calls, each doing exactly one thing.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("swiffHost", {
  loadMachineKey: () => ipcRenderer.invoke("machine-key:load"),
  saveMachineKey: (key) => ipcRenderer.invoke("machine-key:save", String(key)),
});
