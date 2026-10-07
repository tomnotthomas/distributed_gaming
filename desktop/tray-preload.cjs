// The tray glance's only privileged API: the snapshot the app window last sent,
// and a way to send back one named action, and its own uncaught errors for main
// to report. No key, no PC reads, no capture.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("swiffTray", {
  onGlance: (listener) => {
    const forward = (_event, glance) => listener(glance);
    void ipcRenderer.invoke("glance:get").then((glance) => glance && listener(glance));
    ipcRenderer.on("glance", forward);
    return () => ipcRenderer.removeListener("glance", forward);
  },
  trayAction: (action) => ipcRenderer.send("tray:action", String(action)),
  // The same plain strings as preload.cjs's windowError (a sandboxed preload
  // cannot require it); keep the two the same.
  reportError: (report) =>
    ipcRenderer.send("errors:report", {
      name: String(report?.name ?? ""),
      message: String(report?.message ?? ""),
      stack: String(report?.stack ?? ""),
      mechanism: String(report?.mechanism ?? ""),
    }),
});
