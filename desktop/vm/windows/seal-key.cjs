// The VM test's stand-in for the install's last step (scenario 14): Lanterel's key queued for the
// next restart, kept exactly as Lanterel Host keeps it (rental-key.cjs keyStore), its code sealed
// with Electron's safeStorage under the app's own user data. Run by Electron as an app, in the
// logged-on user's session (a scheduled task with /it): the seal is that Windows user's.
//   electron.exe seal-key.cjs <the app's .cjs folder> <the app's user data> <result file>
// The result file gets "ok", or what went wrong; the code goes nowhere else.

const { app, safeStorage } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [desktop, userData, result] = process.argv.slice(-3);
app.setPath("userData", userData);
app.whenReady().then(() => {
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron's safeStorage is not available");
    const { keyStore } = require(path.join(desktop, "rental-key.cjs"));
    const crypt = {
      seal: (text) => safeStorage.encryptString(text),
      open: (sealed) => safeStorage.decryptString(sealed),
    };
    const store = keyStore(userData, crypt);
    store.queued(String(crypto.randomInt(1e8)).padStart(8, "0"), Date.now());
    if (!store.read()?.code) throw new Error("the queued key does not read back");
    fs.writeFileSync(result, "ok");
  } catch (error) {
    fs.writeFileSync(result, error instanceof Error ? error.message : String(error));
  }
  // quit, not exit: Electron writes the seal's key to Local State on its way out, for the app to open.
  app.quit();
});
