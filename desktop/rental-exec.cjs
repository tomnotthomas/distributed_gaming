// The rental-mode installer's app side: runs a plan (rental.cjs) step by
// step, asking the owner before each step that changes the disk or the
// firmware, through one elevated worker (rental-worker.cjs) that Windows
// starts after one UAC prompt.
//
//   runPlan      the steps in order, each step's operations in order; stops at
//                the first that fails, or when the owner says no
//   startWorker  open a named pipe only this app knows the name of, start the
//                worker as administrator, and wait for it to prove it holds
//                the token it was given (handshake) and say hello
//   dryRun       a worker that only records what it is asked: the tests', and
//                a rehearsal's

const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const net = require("node:net");

/**
 * Run `plan` through `apply(op, progress)`. Before a step with `confirm`,
 * `confirm(step)` must resolve true, or the run stops there. `only` limits
 * the run to those step ids (one step at a time, say). `onEvent` hears each
 * step start, finish or fail, and each operation's progress.
 * Resolves with { status: "done" | "failed" | "stopped", done, failed?, results }.
 */
async function runPlan(plan, { apply, confirm = async () => true, onEvent = () => {}, only = null }) {
  const done = [];
  const results = [];
  for (const step of plan.steps) {
    if (only && !only.includes(step.id)) continue;
    if (step.confirm) {
      onEvent({ type: "step", id: step.id, state: "confirm" });
      if (!(await confirm(step))) {
        onEvent({ type: "step", id: step.id, state: "stopped" });
        return { status: "stopped", done, stoppedAt: step.id, results };
      }
    }
    onEvent({ type: "step", id: step.id, state: "running" });
    for (const op of step.ops) {
      try {
        const result = await apply(op, (progress) => onEvent({ type: "progress", id: step.id, ...progress }));
        if (result && Object.keys(result).length) results.push({ step: step.id, op: op.op, ...result });
      } catch (error) {
        const failed = { step: step.id, op: op.op, error: error?.message ?? String(error) };
        onEvent({ type: "step", id: step.id, state: "failed", error: failed.error });
        return { status: "failed", done, failed, results };
      }
    }
    done.push(step.id);
    onEvent({ type: "step", id: step.id, state: "done" });
  }
  return { status: "done", done, results };
}

/** A worker that records the operations it is sent and does nothing: a rehearsal. */
function dryRun() {
  const ops = [];
  return {
    ops,
    apply: async (op) => {
      ops.push(op);
      return {};
    },
    close() {},
  };
}

/** Whether this process already runs as administrator: then the worker needs no UAC prompt. */
function isElevated() {
  return new Promise((resolve) =>
    // High Mandatory Level: only an elevated token has it.
    execFile("whoami", ["/groups"], { windowsHide: true }, (error, stdout) =>
      resolve(!error && /S-1-16-12288/.test(String(stdout))),
    ),
  );
}

/** Quote one argument for Start-Process's ArgumentList, which Windows splits again. */
function winArg(arg) {
  if (/["\r\n]/.test(arg)) throw new Error(`An argument cannot hold quotes: ${arg}`);
  return `"${arg.replace(/\\+$/, (s) => s + s)}"`;
}

/**
 * Start `file args` as administrator: through UAC (Start-Process -Verb RunAs),
 * or directly when this process already is one. Rejects when the owner says
 * no to UAC.
 */
async function launchElevated({ file, args }) {
  if (await isElevated()) {
    spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  const literal = (text) => `'${text.replace(/'/g, "''")}'`;
  const line = `Start-Process -FilePath ${literal(file)} -ArgumentList ${literal(args.map(winArg).join(" "))} -Verb RunAs -WindowStyle Hidden`;
  await new Promise((resolve, reject) =>
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(line, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 10 * 60_000 },
      (error) =>
        error ? reject(new Error("Windows did not give Swiff Host administrator rights.")) : resolve(),
    ),
  );
}

/** The other end of the pipe's side, for each side. */
const PEER = { app: "worker", worker: "app" };

/**
 * Prove to the peer on `socket` that this end (`side`: "app" or "worker")
 * holds `token`, and have the peer prove the same, without either sending
 * it: each end sends a random nonce and answers the other's with
 * HMAC-SHA256(token, nonce and its own side), before anything else. Resolves
 * with what came after the peer's proof once both proofs are in; a peer
 * without the token is hung up on, and the promise rejects.
 */
function handshake(socket, token, side) {
  const mine = crypto.randomBytes(32).toString("hex");
  const proofOf = (nonce, who) => crypto.createHmac("sha256", token).update(`${nonce}:${who}`).digest();
  const send = (msg) => socket.write(`${JSON.stringify(msg)}\n`);
  return new Promise((resolve, reject) => {
    let buffered = "";
    let answered = false;
    const done = () => {
      socket.off("data", onData);
      socket.off("close", fail);
    };
    function fail() {
      done();
      socket.destroy();
      reject(new Error("The installer's pipe was not Swiff Host's."));
    }
    function onData(chunk) {
      buffered += chunk;
      let at;
      while ((at = buffered.indexOf("\n")) >= 0) {
        let msg;
        try {
          msg = JSON.parse(buffered.slice(0, at));
        } catch {
          msg = null;
        }
        buffered = buffered.slice(at + 1);
        if (!answered && typeof msg?.nonce === "string") {
          answered = true;
          send({ proof: proofOf(msg.nonce, side).toString("hex") });
          continue;
        }
        const proof = answered && typeof msg?.proof === "string" ? Buffer.from(msg.proof, "hex") : null;
        const expected = proofOf(mine, PEER[side]);
        if (!proof || proof.length !== expected.length || !crypto.timingSafeEqual(proof, expected))
          return fail();
        done();
        return resolve(buffered);
      }
    }
    socket.on("data", onData);
    socket.on("close", fail);
    send({ nonce: mine });
  });
}

/**
 * Start the elevated worker for the image set in `imageDir`, and resolve with
 * its client once it has proved it holds the token (handshake) and said
 * hello: `apply(op, progress)` sends one operation and resolves with its
 * result, `close()` lets it exit. `command(pipe, token, imageDir)` is how to
 * start the worker (Swiff Host itself in worker mode, or node with
 * rental-worker.cjs). `pipe` is a fresh random name unless given (a UNIX
 * socket, in tests).
 */
async function startWorker({
  imageDir,
  command,
  launch = launchElevated,
  timeout = 5 * 60_000,
  pipe = `\\\\.\\pipe\\swiff-rental-${crypto.randomBytes(16).toString("hex")}`,
}) {
  const token = crypto.randomBytes(32).toString("hex");
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(pipe, resolve));
  let socket;
  try {
    socket = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The installer did not start in time.")), timeout);
      server.on("connection", async (s) => {
        let buffered;
        try {
          // Only the process started with this token is the worker: anything else is hung up on.
          buffered = await handshake(s, token, "app");
        } catch {
          return;
        }
        const onData = (chunk) => {
          buffered += chunk;
          const at = buffered.indexOf("\n");
          if (at < 0) return;
          s.off("data", onData);
          let hello;
          try {
            hello = JSON.parse(buffered.slice(0, at));
          } catch {
            hello = null;
          }
          if (!hello) return void s.destroy();
          clearTimeout(timer);
          if (at + 1 < buffered.length) s.unshift(buffered.slice(at + 1));
          if (hello.ok) resolve(s);
          else reject(new Error(hello.error || "The installer could not start."));
        };
        s.on("data", onData);
        onData("");
      });
      launch(command(pipe, token, imageDir)).catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } finally {
    // One worker: no one else connects once it has.
    server.close();
  }
  return clientOf(socket);
}

/** The app's end of the pipe: one operation at a time, matched to its answer by id. */
function clientOf(socket) {
  const pending = new Map();
  let next = 0;
  let buffered = "";
  let closed = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const call = pending.get(msg.id);
      if (!call) continue;
      if (msg.progress) {
        call.progress(msg.progress);
        continue;
      }
      pending.delete(msg.id);
      if (msg.ok) call.resolve(msg.result ?? {});
      else call.reject(new Error(msg.error));
    }
  });
  // A broken pipe ends in "close", which fails what is still waiting.
  socket.on("error", () => {});
  socket.on("close", () => {
    closed = true;
    for (const call of pending.values()) call.reject(new Error("The installer stopped."));
    pending.clear();
  });
  return {
    apply(op, progress = () => {}) {
      if (closed) return Promise.reject(new Error("The installer stopped."));
      const id = ++next;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, progress });
        socket.write(`${JSON.stringify({ id, op })}\n`);
      });
    },
    close: () => socket.end(),
  };
}

module.exports = { runPlan, dryRun, isElevated, winArg, launchElevated, handshake, startWorker, clientOf };
