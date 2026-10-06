// Rental mode's installer from a console, on Windows, with Windows' node: the
// same plans (rental.cjs), runner (rental-exec.cjs) and elevated worker
// (rental-worker.cjs) as Swiff Host's Rental mode screen, for the VM test and
// for an install that someone carries out one announced step at a time.
//
//   node rental-cli.cjs read
//       what the app reads from this PC, and what an install recorded
//   node rental-cli.cjs run <install|uninstall|unkey|mok|once|start|stop> --image <dir>
//           [--target <id>] [--dry-run] [--code <8 digits>]
//       plan it and run every step: typing this command is the confirmation
//   node rental-cli.cjs serve --image <dir> [--commands <file>] [--dry-run] [--code <8 digits>]
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
// A plan's one-time key code lets whoever has it enrol or remove a key at the
// PC's blue screen. This console never shows, logs or writes one: whoever runs
// it chooses the code and gives it with --code, so they have it already, and a
// plan that needs one is refused without it (a dry run still goes). Answers
// and a dry run's operations show it as (hidden).

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

async function plan(kind, { image, target = null, code }) {
  if (kind === "once" || kind === "start" || kind === "stop") return switchPlan(kind);
  if (kind === "mok") return mokPlan(code, await readRental());
  if (kind === "unkey") return keyRemovalPlan(code, await readRental());
  const rental = await readRental();
  if (!rental) throw new Error("This PC could not be read.");
  if (kind === "uninstall") return uninstallPlan(rental);
  if (kind === "install")
    return installPlan(rental, {
      target,
      layout: readImageSet(image, { trust: trustOf({ dev: true }) }).layout,
      ...(code ? { code } : {}),
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

/** A plan as an answer shows it: without its key code. */
const shown = (p) => ({
  kind: p.kind,
  target: p.target,
  steps: p.steps.map(({ id, title, confirm, commands }) => ({ id, title, confirm, commands })),
});

/**
 * The key code given with --code: eight digits, or none. A plan that needs one
 * runs only with it (`p`, once planned), since this console never shows a code.
 */
function codeOf(opts, p = null) {
  const code = opts.code === undefined ? undefined : String(opts.code);
  if (code !== undefined && !/^\d{8}$/.test(code)) throw new Error("--code takes 8 digits.");
  if (p?.mok && code === undefined && !opts["dry-run"])
    throw new Error(
      "This plan has a one-time key code, and this console shows none: give your own with --code.",
    );
  return code;
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
    const p = await plan(opts._[0], { image: opts.image, target: opts.target, code: codeOf(opts) });
    codeOf(opts, p);
    say({ plan: shown(p) });
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
          current = await plan(args[0], { image: opts.image, target: args[1] ?? null, code: codeOf(opts) });
          say({ plan: shown(current) });
        } else if (verb === "elevate") {
          w ??= await worker(opts.image, opts["dry-run"]);
          say({ elevated: true });
        } else if (verb === "run") {
          if (!current) throw new Error("No plan yet.");
          codeOf(opts, current);
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

module.exports = { codeOf, shown, unkeyed };

if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    say({ error: error.message });
    process.exitCode = 1;
  });
