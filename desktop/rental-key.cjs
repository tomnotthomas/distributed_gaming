// Swiff's key, as far as this app can know it. Whether shim's MokManager
// enrolled the key cannot be read from Windows: MokList is a boot-time
// variable, and shim publishes MokListRT only to what it starts, never to
// Windows Boot Manager. So the app remembers what it queued and when, reads
// what this start's measured-boot log shows (measured-boot.cjs), and asks the
// owner the rest.
//
//   queued     a request with this code waits for the next restart
//   ask        the PC restarted since, cleanly (MokManager's Reboot, or the
//              firmware never reached shim): only the owner knows whether the
//              code went in
//   confirmed  the owner said it did, or this start's log shows shim starting
//              Swiff's own boot loader, which it does only with the key enrolled
//   missed     the owner said it did not, or Swiff's key was taken off again:
//              a new code is the way on
//   nokey      Windows started in the same power-on as shim, after MokManager,
//              without Swiff's boot loader: the key did not go in (Continue
//              boot was chosen), and Windows met a changed PCR 7, so it may
//              ask for its PIN again, and once more after its next restart
//
// The code is kept in the owner's own app data until it is used up, encrypted
// by the OS for the logged-in Windows user (main's safeStorage), never in the
// clear: where encryption is unavailable it is not kept. It only works at the
// PC's keyboard, at the blue screen, once.

const fs = require("node:fs");
const path = require("node:path");
const { lastLog, trailOf } = require("./measured-boot.cjs");

/** @typedef {{ code: string | null, queuedAt: number | null, answer: "yes" | "no" | null }} SavedKey */

/** What was saved, checked; null when nothing was. */
function savedOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const code = typeof raw.code === "string" && /^\d{8}$/.test(raw.code) ? raw.code : null;
  const queuedAt = Number.isFinite(raw.queuedAt) ? raw.queuedAt : null;
  const answer = raw.answer === "yes" || raw.answer === "no" ? raw.answer : null;
  if (!code && !answer) return null;
  return { code, queuedAt, answer };
}

/**
 * Where the key stands, from what was saved, when this PC last started
 * (`bootAt`, ms), and this start's boot trail (bootTrail). A request queued
 * before this start has met its blue screen.
 */
function keyOf(saved, bootAt, trail = null) {
  if (!saved) return null;
  if (saved.answer === "yes") return { state: "confirmed", code: null };
  if (saved.answer === "no") return { state: "missed", code: null };
  if (!saved.code || saved.queuedAt === null) return null;
  if (saved.queuedAt > bootAt) return { state: "queued", code: saved.code };
  // This start's own log, written after the request.
  if (trail && trail.at >= saved.queuedAt && trail.shim) {
    if (trail.loader) return { state: "confirmed", code: null };
    if (trail.windowsAfterShim) return { state: "nokey", code: null };
  }
  return { state: "ask", code: null };
}

/**
 * Whether the owner may answer the blue screen's question now: when the key's
 * state is `ask`, and when nothing is saved at all (Swiff OS installed by
 * another app version, or a key file this version cannot read), since the
 * screen then asks too and must not leave the owner stuck on it.
 */
const canAnswer = (key) => key === null || key.state === "ask";

/**
 * This start's boot trail (measured-boot.cjs trailOf), and when its log was
 * written. Null where there is no log to read (off Windows, or none written).
 */
function bootTrail(dir, files = fs) {
  const log = lastLog(dir, files);
  return log ? { at: log.at, ...trailOf(log.events) } : null;
}

/**
 * The key's file in `dir` (the app's user data): read, saved, and answered.
 * `crypt.seal` encrypts the code into a Buffer and `crypt.open` decrypts it;
 * with no `crypt` the code is not kept.
 */
function keyStore(dir, crypt, files = fs) {
  const file = path.join(dir, "rental-key.json");
  const open = (sealed) => {
    try {
      return typeof sealed === "string" && crypt ? crypt.open(Buffer.from(sealed, "base64")) : null;
    } catch {
      return null;
    }
  };
  const read = () => {
    try {
      const raw = JSON.parse(files.readFileSync(file, "utf8"));
      return savedOf({ ...raw, code: open(raw?.sealed) });
    } catch {
      return null;
    }
  };
  const write = (saved) => {
    files.mkdirSync(dir, { recursive: true });
    files.writeFileSync(file, `${JSON.stringify(saved)}\n`);
  };
  return {
    read,
    /** A request with `code` was queued at `at`: the next restart shows it. */
    queued: (code, at) =>
      write({ sealed: crypt ? crypt.seal(code).toString("base64") : null, queuedAt: at, answer: null }),
    /** The owner's word on the blue screen, once the PC restarted. */
    answer: (yes) => write({ sealed: null, queuedAt: null, answer: yes ? "yes" : "no" }),
    /** Swiff OS is gone, or never was: nothing to remember. */
    forget: () => files.rmSync(file, { force: true }),
  };
}

/**
 * What a run's finished step `id` of `plan` tells the key's file (keyStore
 * `store`): `mok` queued a request with the plan's code, `mok-remove` took
 * Swiff's key off, so it must be confirmed again before rental mode goes live,
 * and a step that cancels shim's requests (`mok-cancel`) leaves none queued.
 */
function keyStep(store, plan, id, at) {
  if (id === "mok" && plan.mok) store.queued(plan.mok.code, at);
  else if (id === "mok-remove") store.answer(false);
  else if (plan.steps.find((s) => s.id === id)?.ops.some((o) => o.op === "mok-cancel")) store.forget();
}

module.exports = { savedOf, keyOf, canAnswer, keyStore, keyStep, bootTrail };
