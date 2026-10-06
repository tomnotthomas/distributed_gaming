// Whether this build may share the owner's Windows desktop. Rental mode, with
// Swiff OS, is the only way to host: sharing from Windows would be an insecure
// alternative, so it exists only in a development build run unpackaged with
// SWIFF_DEV_WINDOWS_SHARE=1, never in the app hosts download. Kept apart from
// main.cjs so the rule can be checked without Electron.

/** True only for an unpackaged development run that asked for Windows sharing. */
function windowsShareAllowed({ isPackaged, env }) {
  return !isPackaged && env.SWIFF_DEV_WINDOWS_SHARE === "1";
}

module.exports = { windowsShareAllowed };
