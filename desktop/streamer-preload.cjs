// The streamer window's only privileged API: what it was started with (the
// room, its session key and the game), a way to report how the session goes,
// and the commands that arrive for it. No machine key, no PC reads.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("swiffStreamer", {
  init: () => ipcRenderer.invoke("streamer:init"),
  report: (event) => ipcRenderer.send("streamer:report", event),
  onCommand: (listener) => {
    const forward = (_event, command) => listener(command);
    ipcRenderer.on("streamer:command", forward);
    return () => ipcRenderer.removeListener("streamer:command", forward);
  },
});
