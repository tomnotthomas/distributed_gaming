// Rental mode's installer from a console, on Windows, with Windows' node: the
// same plans (rental.cjs), runner (rental-exec.cjs) and elevated worker
// (rental-worker.cjs) as Swiff Host's Rental mode screen, for the VM test and
// for an install that someone carries out one announced step at a time.
//
//   node rental-cli.cjs read
//       what the app reads from this PC, and what an install recorded
//   node rental-cli.cjs run <install|uninstall|unkey|mok|once|start|stop> --image <dir>
//           [--target <id>] [--dry-run] [--code-file <file>]
//       plan it and run every step: typing this command is the confirmation
//   node rental-cli.cjs serve --image <dir> [--commands <file>] [--dry-run] [--code-file <file>]
//       one elevated worker (one UAC prompt, on `elevate` or the first `run`),
//       then commands one per line, on stdin or appended to <file> (which
//       works where a pipe into a Windows process does not, as from WSL), each
//       answered on stdout:
//         plan <install [target] | uninstall | unkey | mok | once | start | stop>
//         elevate          start the worker now
//         run <step>...    run these steps of the last plan, in order
//         read | quit
//
// Every answer is one JSON line. The worker refuses whatever does not match
// the image set and the install's record, whatever this console asks.
//
// A plan's one-time key code is never in an answer: it lets whoever has it
// enrol or remove a key at the PC's blue screen, and answers end up in logs.
// With --code-file it is written to that file alone, for its owner to read
// and delete; the answer says only that it is there.

const path = require("node:path");
const fs = require("node:fs");
const readline = require("node:readline");
const { dryRun, runPlan, startWorker } = require("./rental-exec.cjs");
const { readImageSet, trustOf } = require("./image-set.cjs");
const { bootTrail } = require("./rental-key.cjs");
const {
  installPlan,
  keyRemovalPlan,
  mokPlan,
  readRental,
  switchPlan,
  uninstallPlan,
} = require("./rental.cjs");

const say = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

/** The flags after the command: --name value, or --name alone for true. */
function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) out._.push(args[i]);
    else if (args[i + 1] && !args[i + 1].startsWith("--")) out[args[i].slice(2)] = args[++i];
    else out[args[i].slice(2)] = true;
  }
  return out;
}

async function plan(kind, { image, target = null }) {
  if (kind === "once" || kind === "start" || kind === "stop") return switchPlan(kind);
  if (kind === "mok") return mokPlan(undefined, await readRental());
  if (kind === "unkey") return keyRemovalPlan(undefined, await readRental());
  const rental = await readRental();
  if (!rental) throw new Error("This PC could not be read.");
  if (kind === "uninstall") return uninstallPlan(rental);
  if (kind === "install")
    return installPlan(rental, {
      target,
      layout: readImageSet(image, { trust: trustOf({ dev: true }) }).layout,
    });
  throw new Error(`No plan ${kind}.`);
}

/** The worker: node with rental-worker.cjs, as administrator. */
const worker = (image, dry) =>
  dry
    ? Promise.resolve(dryRun())
    : startWorker({
        imageDir: path.resolve(image),
        command: (pipe, token, dir) => ({
          file: process.execPath,
          args: [path.join(__dirname, "rental-worker.cjs"), pipe, token, dir],
        }),
      });

/**
 * A plan as an answer shows it: its key code, if it has one, only in
 * `codeFile` (written readable by its owner alone), never in the answer.
 */
function shown(p, codeFile = null, files = fs) {
  if (p.mok && codeFile) files.writeFileSync(codeFile, p.mok.code, { mode: 0o600 });
  return {
    kind: p.kind,
    target: p.target,
    ...(p.mok ? { mok: { codeFile: codeFile ?? null } } : {}),
    steps: p.steps.map(({ id, title, confirm, commands }) => ({ id, title, confirm, commands })),
  };
}

/**
 * Refuse to run `p` when it has a key code and there is no --code-file: the
 * code would be shown nowhere, and the PC's blue screen waits for it. A dry
 * run changes nothing, so it may.
 */
function mustShowCode(p, opts) {
  if (p.mok && !opts["code-file"] && !opts["dry-run"])
    throw new Error("This plan has a one-time key code, which is shown only in a file: give --code-file <file>.");
}

/** A dry run's operations as an answer shows them: without any key code. */
const unkeyed = (ops) =>
  ops.map(({ code, ...op }) => (code === undefined ? op : { ...op, code: "(hidden)" }));

/** The lines appended to `file`, as they come: the file is read again every half second. */
async function* follow(file) {
  let at = 0;
  let partial = "";
  for (;;) {
    let text = "";
    try {
      const bytes = fs.readFileSync(file);
      text = bytes.subarray(at).toString("utf8");
      at = bytes.length;
    } catch {
      // Not there yet.
    }
    const parts = (partial + text).split(/\r?\n/);
    partial = parts.pop();
    yield* parts;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function main([cmd, ...rest]) {
  const opts = flags(rest);
  // With this start's boot trail (rental-key.cjs): what ran before Windows, for the VM test.
  if (cmd === "read") return say({ read: await readRental(), trail: bootTrail() });
  if (cmd === "run") {
    const p = await plan(opts._[0], { image: opts.image, target: opts.target });
    mustShowCode(p, opts);
    say({ plan: shown(p, opts["code-file"] ?? null) });
    const w = await worker(opts.image, opts["dry-run"]);
    try {
      const outcome = await runPlan(p, { apply: w.apply, onEvent: (event) => say({ event }) });
      say({ outcome, ...(w.ops ? { ops: unkeyed(w.ops) } : {}) });
      process.exitCode = outcome.status === "done" ? 0 : 1;
    } finally {
      w.close();
    }
    return;
  }
  if (cmd === "serve") {
    let current = null;
    let w = null;
    const lines = opts.commands ? follow(opts.commands) : readline.createInterface({ input: process.stdin });
    say({ ready: true });
    for await (const line of lines) {
      const [verb, ...args] = line.trim().split(/\s+/);
      try {
        if (!verb) continue;
        if (verb === "quit") break;
        if (verb === "read") say({ read: await readRental() });
        else if (verb === "plan") {
          current = await plan(args[0], { image: opts.image, target: args[1] ?? null });
          say({ plan: shown(current, opts["code-file"] ?? null) });
        } else if (verb === "elevate") {
          w ??= await worker(opts.image, opts["dry-run"]);
          say({ elevated: true });
        } else if (verb === "run") {
          if (!current) throw new Error("No plan yet.");
          mustShowCode(current, opts);
          const unknown = args.filter((id) => !current.steps.some((s) => s.id === id));
          if (!args.length || unknown.length)
            throw new Error(`No such steps: ${unknown.join(" ") || "none given"}.`);
          w ??= await worker(opts.image, opts["dry-run"]);
          say({
            outcome: await runPlan(current, {
              apply: w.apply,
              only: args,
              onEvent: (event) => say({ event }),
            }),
          });
        } else throw new Error(`Unknown command ${verb}.`);
      } catch (error) {
        say({ error: error.message });
      }
    }
    w?.close();
    return;
  }
  console.error("usage: rental-cli.cjs read | run <kind> --image <dir> | serve --image <dir>");
  process.exitCode = 2;
}

module.exports = { mustShowCode, shown, unkeyed };

if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    say({ error: error.message });
    process.exitCode = 1;
  });
