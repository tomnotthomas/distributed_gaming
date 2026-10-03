// Where a renter's session runs, for the handoff in the app window
// (src/handoff.ts). The app holds the machine key and the platform calls; this
// only starts, talks to and stops the streamer, and nothing else:
//
//   renter   The Windows session service (service/SwiffSession.cs) is
//            installed: it signs the swiff-renter account in at the console
//            through the credential provider, launches the streamer in that
//            account with the session key on its stdin, and on end signs it
//            out, wipes the profile and hands the console back to the owner.
//            This side speaks to it over its named pipe, one JSON line each way.
//   local    No service: the streamer is a second copy of this app, in this
//            Windows session, the key on its stdin. Nothing to sign in or
//            wipe. Development, other platforms, and the end-to-end tests.
//
// Both speak the same lines to the streamer (main.cjs --streamer): commands
// down, events up. The renderer can only ever launch this app's own streamer.

const { spawn } = require("node:child_process");
const net = require("node:net");
const { StringDecoder } = require("node:string_decoder");

/** The session service's pipe. Its ACL lets SYSTEM and the owner who installed it in. */
const SERVICE_PIPE = "\\\\.\\pipe\\swiff-session";
/** The most a line from the streamer or the service may be; anything longer is not one of ours. */
const MAX_LINE = 16 * 1024;
/** How long the service has to sign the renter in. */
const LOGON_TIMEOUT_MS = 90_000;
/** How long the service has to give the PC back. */
const END_TIMEOUT_MS = 180_000;

const STREAMER_EVENTS = new Set([
  "registered",
  "peer-joined",
  "peer-left",
  "first-frame",
  "game-started",
  "denied",
]);

/** Split a stream into lines, calling `onLine` with each parsed JSON object; bad lines are dropped. */
function lineReader(onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return (chunk) => {
    buffer += decoder.write(chunk);
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line || line.length > MAX_LINE) continue;
      try {
        const value = JSON.parse(line);
        if (value && typeof value === "object") onLine(value);
      } catch {
        // Not JSON: a log line the streamer printed, or noise.
      }
    }
    if (buffer.length > MAX_LINE) buffer = "";
  };
}

/** A streamer event as the handoff takes it, or null for anything else. */
function streamerEvent(value) {
  if (!value || !STREAMER_EVENTS.has(value.type)) return null;
  switch (value.type) {
    case "peer-left":
      return {
        type: "peer-left",
        grace: Number.isFinite(value.grace) && value.grace >= 0 ? value.grace : null,
      };
    case "game-started":
      return Number.isInteger(value.appid) ? { type: "game-started", appid: value.appid } : null;
    case "denied":
      return { type: "denied", ...(typeof value.reason === "string" ? { reason: value.reason } : {}) };
    default:
      return { type: value.type };
  }
}

/** The streamer's first line: what it registers with and the game it launches. Throws on anything else. */
function streamerInit(init) {
  const ok =
    init &&
    typeof init.url === "string" &&
    /^wss?:\/\//.test(init.url) &&
    typeof init.hostId === "string" &&
    init.hostId.length > 0 &&
    init.hostId.length <= 200 &&
    typeof init.sessionKey === "string" &&
    init.sessionKey.length > 0 &&
    init.sessionKey.length <= 4096 &&
    Number.isInteger(init.appid) &&
    init.appid > 0;
  if (!ok) throw new Error("bad streamer init");
  return { url: init.url, hostId: init.hostId, sessionKey: init.sessionKey, appid: init.appid };
}

/** A command for a running streamer, or null for anything else. */
function streamerCommand(command) {
  if (!command || typeof command !== "object") return null;
  if (command.type === "key" && typeof command.sessionKey === "string" && command.sessionKey.length <= 4096)
    return { type: "key", sessionKey: command.sessionKey };
  if (command.type === "launch-game" || command.type === "stop") return { type: command.type };
  return null;
}

/**
 * The streamer as a second copy of this app in this Windows session.
 * `command` is how to start it: this executable, and the app's path when
 * it runs unpackaged.
 */
function localHost({ command, env = process.env, spawnProcess = spawn }) {
  const listeners = new Set();
  const emit = (event) => listeners.forEach((listener) => listener(event));
  let child = null;

  const stopChild = () => {
    const running = child;
    child = null;
    if (!running) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        running.kill();
        resolve();
      }, 5_000);
      running.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        running.stdin.write(`${JSON.stringify({ type: "stop" })}\n`);
      } catch {
        running.kill();
      }
    });
  };

  return {
    kind: "local",
    logon: async () => {},
    launch: async (init) => {
      const line = JSON.stringify(streamerInit(init));
      await stopChild();
      const started = spawnProcess(command.file, [...command.args, "--streamer"], {
        env,
        stdio: ["pipe", "pipe", "inherit"],
        windowsHide: true,
      });
      child = started;
      started.stdout.on(
        "data",
        lineReader((value) => child === started && emitEvent(value)),
      );
      started.on("exit", (code) => {
        if (child !== started) return;
        child = null;
        emit({ type: "exit", code });
      });
      started.on("error", () => {});
      // The session key goes on stdin, never the command line, where any process could read it.
      started.stdin.write(`${line}\n`);
    },
    send: (command) => {
      const valid = streamerCommand(command);
      if (valid && child) child.stdin.write(`${JSON.stringify(valid)}\n`);
    },
    end: stopChild,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  function emitEvent(value) {
    const event = streamerEvent(value);
    if (event) emit(event);
  }
}

/**
 * The streamer in the renter's Windows account, through the session service.
 * One request is answered at a time, in order; streamer events and a lost
 * session arrive whenever they happen.
 */
function serviceHost({ connect = () => net.connect(SERVICE_PIPE) } = {}) {
  const listeners = new Set();
  const emit = (event) => listeners.forEach((listener) => listener(event));
  let socket = null;
  /** Requests waiting for their answer, in the order they were sent. */
  const waiting = [];

  const fail = (why) => {
    for (const request of waiting.splice(0)) request.reject(new Error(why));
  };

  const open = () =>
    new Promise((resolve, reject) => {
      if (socket) return resolve(socket);
      const pipe = connect();
      pipe.once("connect", () => {
        socket = pipe;
        resolve(pipe);
      });
      pipe.once("error", (cause) => {
        if (socket !== pipe) return reject(cause);
      });
      pipe.on(
        "data",
        lineReader((value) => {
          if (value.ev === "reply") {
            const request = waiting.shift();
            if (!request) return;
            if (value.ok) request.resolve(value);
            else request.reject(new Error(typeof value.error === "string" ? value.error : "refused"));
          } else if (value.ev === "streamer") {
            const event = streamerEvent(value.event);
            if (event) emit(event);
          } else if (value.ev === "streamer-exit") {
            emit({ type: "exit", code: Number.isInteger(value.code) ? value.code : null });
          } else if (value.ev === "lost") {
            emit({
              type: "lost",
              why: typeof value.why === "string" ? value.why : "the renter's session ended",
            });
          }
        }),
      );
      pipe.on("close", () => {
        if (socket !== pipe) return;
        socket = null;
        fail("the session service closed its pipe");
        emit({ type: "lost", why: "the session service went away" });
      });
    });

  const request = async (message, timeoutMs = 30_000) => {
    const pipe = await open();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${message.op} timed out`)), timeoutMs);
      waiting.push({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (cause) => {
          clearTimeout(timer);
          reject(cause);
        },
      });
      pipe.write(`${JSON.stringify(message)}\n`);
    });
  };

  return {
    kind: "renter",
    logon: async () => {
      await request({ op: "logon" }, LOGON_TIMEOUT_MS);
    },
    launch: async (init) => {
      await request({ op: "launch", init: streamerInit(init) });
    },
    send: (command) => {
      const valid = streamerCommand(command);
      if (valid) void request({ op: "send", command: valid }).catch(() => {});
    },
    end: async () => {
      if (!socket) return;
      await request({ op: "end" }, END_TIMEOUT_MS);
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Whether the session service answers on its pipe. Never on anything but Windows. */
function serviceInstalled({ platform = process.platform, connect = () => net.connect(SERVICE_PIPE) } = {}) {
  if (platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    const pipe = connect();
    const done = (found) => {
      pipe.destroy();
      resolve(found);
    };
    pipe.once("connect", () => done(true));
    pipe.once("error", () => done(false));
    setTimeout(() => done(false), 2_000).unref?.();
  });
}

module.exports = {
  SERVICE_PIPE,
  lineReader,
  streamerEvent,
  streamerInit,
  streamerCommand,
  localHost,
  serviceHost,
  serviceInstalled,
};
