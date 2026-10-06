// Remove Swiff OS, as the app follows it across its restarts. The owner asks
// once; removePlan (rental.cjs) carries it out in two parts, and this file is
// what the app remembers in between, in its own user data:
//
//   key       Swiff's key's removal is queued with a code (sealed, as the
//             key's own file keeps it): the next restart shows MokManager.
//             After that restart, Finish removing runs the rest.
//   disk      Swiff OS is off the PC, and the app recorded what that left:
//             the partitions that must be gone, the drive that must have its
//             space back, the drives BitLocker must protect again. The next
//             start is checked against it, which shows Windows still starts.
//
// Nothing here needs administrator rights, and nothing in it is secret but
// the code, which is kept only sealed and only until its restart.

const fs = require("node:fs");
const path = require("node:path");

/** A drive's size may come back this much short of where it was: Windows aligns partitions to 1 MiB. */
const SLACK = 1024 * 1024;

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/**
 * What Remove Swiff OS must leave, from the install's record before the
 * uninstall (InstallRecord) and the drives BitLocker protected then.
 */
function expectOf(install, bitlocker = []) {
  return {
    ids: install.partitions.map((p) => p.id),
    room: install.shrink ? { letter: install.shrink.letter, size: install.shrink.from } : null,
    bitlocker: [...bitlocker],
  };
}

/** What was saved, checked; null when nothing (or nothing readable) was. */
function savedOf(raw) {
  if (!raw || typeof raw !== "object" || !Number.isFinite(raw.at)) return null;
  if (raw.phase === "key")
    return {
      phase: "key",
      at: raw.at,
      code: typeof raw.code === "string" && /^\d{8}$/.test(raw.code) ? raw.code : null,
    };
  if (raw.phase !== "disk") return null;
  const e = raw.expect && typeof raw.expect === "object" ? raw.expect : {};
  const room =
    e.room && /^[A-Z]$/.test(e.room.letter) && Number.isFinite(e.room.size)
      ? { letter: e.room.letter, size: e.room.size }
      : null;
  return {
    phase: "disk",
    at: raw.at,
    expect: {
      ids: Array.isArray(e.ids) ? e.ids.filter((id) => typeof id === "string" && GUID.test(id)) : [],
      room,
      bitlocker: Array.isArray(e.bitlocker) ? e.bitlocker.filter((l) => /^[A-Z]$/.test(l)) : [],
    },
  };
}

/**
 * Each thing the next start shows, against what the removal recorded:
 * `facts` the app's read (rental.cjs factsOf), `trail` this start's boot
 * trail (rental-key.cjs bootTrail), null where there is no log to read.
 */
function checksOf(expect, facts, trail) {
  const checks = [];
  checks.push({
    id: "windows",
    label: "Windows",
    ok: !trail?.shim,
    value: trail?.shim ? "Started through Swiff OS's loader" : "Started as usual",
  });
  const still = facts.partitions.filter((p) => p.id && expect.ids.includes(p.id));
  checks.push({
    id: "partitions",
    label: "Swiff OS",
    ok: still.length === 0,
    value: still.length ? `${still.length} of its partitions are still on the disk` : "Gone from the disk",
  });
  if (expect.room) {
    const { letter, size } = expect.room;
    const part = facts.partitions.find((p) => p.letter === letter);
    const ok = Boolean(part && part.size >= size - SLACK);
    checks.push({
      id: "space",
      label: `${letter}:`,
      ok,
      value: ok
        ? `Its ${Math.round(size / 1024 ** 3)} GB again`
        : part
          ? `${Math.round(part.size / 1024 ** 3)} GB, not its ${Math.round(size / 1024 ** 3)} GB`
          : "Not found",
    });
  }
  for (const letter of expect.bitlocker) {
    const state = facts.volumes.find((v) => v.letter === letter)?.bitlocker ?? null;
    checks.push({
      id: `bitlocker-${letter}`,
      label: `${letter}: BitLocker`,
      ok: state === "on",
      value: state === "on" ? "On" : state === "off" ? "Off" : "Not read",
    });
  }
  checks.push({
    id: "record",
    label: "Install record",
    ok: facts.install === null,
    value: facts.install === null ? "Gone" : "Still there",
  });
  return checks;
}

/**
 * Where a removal stands, from what was saved, when this PC last started
 * (`bootAt`, ms), the app's read now (`facts`) and this start's boot trail:
 *
 *   queued    the key's removal waits for its restart (with the code)
 *   finish    that restart happened: Finish removing runs the rest
 *   restart   Swiff OS is off: one restart shows Windows still starts
 *   checked   that restart happened: what it showed, check by check
 */
function removalOf(saved, bootAt, facts = null, trail = null) {
  if (!saved) return null;
  const restarted = saved.at <= bootAt;
  if (saved.phase === "key") return restarted ? { state: "finish" } : { state: "queued", code: saved.code };
  if (!restarted) return { state: "restart" };
  // Without a read of the PC, the restart happened but nothing was checked yet.
  const checks = facts ? checksOf(saved.expect, facts, trail) : [];
  return { state: "checked", ok: facts ? checks.every((c) => c.ok) : null, checks, at: saved.at };
}

/**
 * The removal's file in `dir` (the app's user data). `crypt` seals the key's
 * code as the key's own file does (rental-key.cjs); without it no code is kept.
 */
function removalStore(dir, crypt, files = fs) {
  const file = path.join(dir, "rental-removal.json");
  const write = (saved) => {
    files.mkdirSync(dir, { recursive: true });
    files.writeFileSync(file, `${JSON.stringify(saved)}\n`);
  };
  return {
    read() {
      try {
        const raw = JSON.parse(files.readFileSync(file, "utf8"));
        let code = null;
        try {
          code =
            typeof raw?.sealed === "string" && crypt ? crypt.open(Buffer.from(raw.sealed, "base64")) : null;
        } catch {
          code = null;
        }
        return savedOf({ ...raw, code });
      } catch {
        return null;
      }
    },
    /** Swiff's key's removal was queued with `code` at `at`: the next restart shows MokManager. */
    keyQueued: (code, at) =>
      write({ phase: "key", at, sealed: crypt ? crypt.seal(code).toString("base64") : null }),
    /** Swiff OS came off at `at`: the next start is checked against `expect` (expectOf). */
    removed: (expect, at) => write({ phase: "disk", at, expect }),
    /** The owner has seen how it ended, or there is no removal to follow. */
    forget: () => files.rmSync(file, { force: true }),
  };
}

/**
 * What a run's finished step `id` of a remove `plan` tells the removal's file
 * (`store`): the key part's `mok-remove` queued the removal with the plan's
 * code; the disk part's `forget` took the last of Swiff OS off, against
 * `expect`.
 */
function removalStep(store, plan, id, at, expect = null) {
  if (plan.kind !== "remove") return;
  if (plan.phase === "key" && id === "mok-remove" && plan.mok) store.keyQueued(plan.mok.code, at);
  else if (plan.phase === "disk" && id === "forget" && expect) store.removed(expect, at);
}

module.exports = { SLACK, expectOf, savedOf, checksOf, removalOf, removalStore, removalStep };
