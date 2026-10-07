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
//   planRental                        the steps that would install rental mode, confirm its key again or switch to it, as a preview
//   runRental / onRentalEvent         run that plan up to its restart, and hear each step as it goes
//   restartRental                     Restart now: the PC restarts, to the blue screen or Swiff OS
//   answerRentalKey                   the owner's word on whether the blue screen took the code
//   saveRecoveryKey                   the owner's word that they saved their BitLocker recovery key (never the key)
//   openBitLocker                     Windows' BitLocker page, where the key is backed up
//   seenRemoval                       the owner has seen how Remove Swiff OS ended
//   reportRental                      Send details to Swiff: a failed step's error and this PC's checks
//   secondsSinceInput                 how long since the keyboard or mouse was used
//   setGlance                         the tray glance's snapshot, to the tray
//   onTrayAction                      a named action the tray glance sends back
//   reportError                       an error nothing caught in the window, for main to report
//   setErrorProject                   the Lanterel server's error-reports project (or null), for main
//
// The tray glance has its own, smaller preload (tray-preload.cjs).

const { contextBridge, ipcRenderer } = require("electron");

/** Subscribe `listener` to `channel`'s payloads, without handing it the IPC event. */
function subscribe(channel, listener) {
  const forward = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, forward);
  return () => ipcRenderer.removeListener(channel, forward);
}

/**
 * An error report as plain strings: nothing else crosses to main. A sandboxed
 * preload cannot require a local file, so tray-preload.cjs has its own copy;
 * keep the two the same.
 */
const windowError = (report) => ({
  name: String(report?.name ?? ""),
  message: String(report?.message ?? ""),
  stack: String(report?.stack ?? ""),
  mechanism: String(report?.mechanism ?? ""),
});

contextBridge.exposeInMainWorld("swiffHost", {
  loadMachineKey: () => ipcRenderer.invoke("machine-key:load"),
  saveMachineKey: (key) => ipcRenderer.invoke("machine-key:save", String(key)),
  readPc: () => ipcRenderer.invoke("pc:read"),
  readSteam: () => ipcRenderer.invoke("steam:read"),
  installSteam: () => ipcRenderer.invoke("steam:install"),
  onGamesChanged: (listener) => subscribe("pc:games", listener),
  readRental: () => ipcRenderer.invoke("rental:read"),
  planRental: (ask) =>
    ipcRenderer.invoke("rental:plan", {
      kind: String(ask?.kind),
      target: ask?.target ?? null,
      ...(typeof ask?.key === "boolean" ? { key: ask.key } : {}),
    }),
  runRental: () => ipcRenderer.invoke("rental:run"),
  restartRental: () => ipcRenderer.invoke("rental:restart"),
  answerRentalKey: (yes) => ipcRenderer.invoke("rental:key-answer", yes === true),
  saveRecoveryKey: () => ipcRenderer.invoke("rental:recovery-saved"),
  openBitLocker: () => ipcRenderer.invoke("rental:open-bitlocker"),
  seenRemoval: () => ipcRenderer.invoke("rental:removal-seen"),
  reportRental: (report) => ipcRenderer.invoke("rental:report", report),
  onRentalEvent: (listener) => subscribe("rental:event", listener),
  secondsSinceInput: () => ipcRenderer.invoke("pc:idle"),
  setGlance: (glance) => ipcRenderer.send("glance:set", glance),
  onTrayAction: (listener) => subscribe("tray:action", listener),
  reportError: (report) => ipcRenderer.send("errors:report", windowError(report)),
  setErrorProject: (project) =>
    ipcRenderer.send(
      "errors:project",
      project === null ? null : { key: String(project?.key ?? ""), host: String(project?.host ?? "") },
    ),
});
