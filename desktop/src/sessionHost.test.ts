// @vitest-environment node
// Where a renter's session runs (session-host.cjs): the lines to and from the
// streamer, a streamer started here with its key on stdin, and the session
// service's pipe.

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  lineReader,
  localHost,
  serviceHost,
  serviceInstalled,
  streamerCommand,
  streamerEvent,
  streamerInit,
} from "../session-host.cjs";
import type { StreamerEvent } from "./handoff";

const INIT = { url: "wss://signal.test", hostId: "pc-1", sessionKey: "sk", appid: 730 };

describe("the streamer's lines", () => {
  it("are read whole, across chunks, and anything not JSON is dropped", () => {
    const lines: unknown[] = [];
    const read = lineReader((value) => lines.push(value));
    read('{"type":"regis');
    read('tered"}\nnot json\n\n{"type":"first-frame"}\n{"type"');
    expect(lines).toEqual([{ type: "registered" }, { type: "first-frame" }]);
  });

  it("carry only the events the handoff knows", () => {
    expect(streamerEvent({ type: "peer-left", grace: 120 })).toEqual({ type: "peer-left", grace: 120 });
    expect(streamerEvent({ type: "peer-left" })).toEqual({ type: "peer-left", grace: null });
    expect(streamerEvent({ type: "game-started", appid: 730 })).toEqual({ type: "game-started", appid: 730 });
    expect(streamerEvent({ type: "game-started" })).toBeNull();
    expect(streamerEvent({ type: "denied", reason: "session-ended" })).toEqual({
      type: "denied",
      reason: "session-ended",
    });
    expect(streamerEvent({ type: "exit", code: 0 })).toBeNull(); // only the host says that
    expect(streamerEvent({ type: "launch-game" })).toBeNull();
  });

  it("start the streamer only with a room, a key and a game", () => {
    expect(streamerInit({ ...INIT, extra: 1 })).toEqual(INIT);
    expect(() => streamerInit({ ...INIT, url: "https://signal.test" })).toThrow();
    expect(() => streamerInit({ ...INIT, sessionKey: "" })).toThrow();
    expect(() => streamerInit({ ...INIT, appid: 0 })).toThrow();
  });

  it("tell a running streamer only what it can do", () => {
    expect(streamerCommand({ type: "key", sessionKey: "k2" })).toEqual({ type: "key", sessionKey: "k2" });
    expect(streamerCommand({ type: "launch-game", appid: 1 })).toEqual({ type: "launch-game" });
    expect(streamerCommand({ type: "stop" })).toEqual({ type: "stop" });
    expect(streamerCommand({ type: "run", file: "cmd.exe" })).toBeNull();
  });
});

/** A child process: what was written to its stdin, and a way to speak on its stdout. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    written: string[];
    stdin: { write(data: string): void };
    stdout: EventEmitter;
    kill: () => void;
  };
  child.written = [];
  child.stdin = { write: (data) => child.written.push(data) };
  child.stdout = new EventEmitter();
  child.kill = vi.fn(() => child.emit("exit", null));
  return child;
}

describe("a streamer started here", () => {
  function local() {
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawnProcess = vi.fn((_file: string, _args: string[], _options: unknown) => {
      const child = fakeChild();
      children.push(child);
      return child;
    });
    const host = localHost({ command: { file: "/app/electron", args: ["/app"] }, spawnProcess });
    const events: StreamerEvent[] = [];
    host.onEvent((event) => events.push(event));
    return { host, spawnProcess, children, events };
  }

  it("is this app with --streamer, its key on stdin and never on the command line", async () => {
    const { host, spawnProcess, children } = local();
    const init = { ...INIT, sessionKey: "session-key-7f3a" };
    await host.logon();
    await host.launch(init);
    const [file, args] = spawnProcess.mock.calls[0]!;
    expect(file).toBe("/app/electron");
    expect(args).toEqual(["/app", "--streamer"]);
    expect(JSON.stringify(spawnProcess.mock.calls[0])).not.toContain("session-key-7f3a");
    expect(children[0]!.written).toEqual([`${JSON.stringify(init)}\n`]);
  });

  it("reports what the streamer says, and its exit", async () => {
    const { host, children, events } = local();
    await host.launch(INIT);
    children[0]!.stdout.emit(
      "data",
      Buffer.from('{"type":"registered"}\n{"type":"peer-left","grace":120}\n'),
    );
    children[0]!.emit("exit", 3);
    expect(events).toEqual([
      { type: "registered" },
      { type: "peer-left", grace: 120 },
      { type: "exit", code: 3 },
    ]);
  });

  it("passes commands on, and stops the streamer when the session ends", async () => {
    const { host, children, events } = local();
    await host.launch(INIT);
    host.send({ type: "launch-game" });
    host.send({ type: "nonsense" } as never);
    const ended = host.end();
    expect(children[0]!.written.slice(1)).toEqual(['{"type":"launch-game"}\n', '{"type":"stop"}\n']);
    children[0]!.emit("exit", 0);
    await ended;
    // A streamer stopped on purpose is not reported as having exited.
    expect(events).toEqual([]);
  });

  it("replaces a streamer already running", async () => {
    const { host, children } = local();
    await host.launch(INIT);
    const second = host.launch({ ...INIT, sessionKey: "sk2" });
    children[0]!.emit("exit", 0);
    await second;
    expect(children).toHaveLength(2);
  });
});

/** The service's end of the pipe: what the app wrote, and a way to answer. */
function fakePipe() {
  const pipe = new EventEmitter() as EventEmitter & {
    written: Record<string, unknown>[];
    write(data: string): void;
    destroy(): void;
    answer(value: unknown): void;
  };
  pipe.written = [];
  pipe.write = (data) => pipe.written.push(JSON.parse(data));
  pipe.destroy = vi.fn();
  pipe.answer = (value) => pipe.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
  return pipe;
}

describe("the session service", () => {
  function service() {
    const pipe = fakePipe();
    const host = serviceHost({ connect: () => (setTimeout(() => pipe.emit("connect")), pipe) });
    const events: StreamerEvent[] = [];
    host.onEvent((event) => events.push(event));
    return { host, pipe, events };
  }

  it("signs the renter in, launches the streamer and ends, one request at a time", async () => {
    const { host, pipe } = service();
    const logon = host.logon();
    await vi.waitFor(() => expect(pipe.written).toEqual([{ op: "logon" }]));
    pipe.answer({ ev: "reply", ok: true, session: 2 });
    await logon;

    const launch = host.launch(INIT);
    await vi.waitFor(() => expect(pipe.written.at(-1)).toEqual({ op: "launch", init: INIT }));
    pipe.answer({ ev: "reply", ok: true });
    await launch;

    const end = host.end();
    await vi.waitFor(() => expect(pipe.written.at(-1)).toEqual({ op: "end" }));
    pipe.answer({ ev: "reply", ok: true });
    await end;
  });

  it("fails a request the service refuses, with its reason", async () => {
    const { host, pipe } = service();
    const logon = host.logon();
    await vi.waitFor(() => expect(pipe.written).toHaveLength(1));
    pipe.answer({ ev: "reply", ok: false, error: "no renter session within 60 s" });
    await expect(logon).rejects.toThrow("no renter session within 60 s");
  });

  it("reports the streamer's events, its exit, and the renter's session being lost", async () => {
    const { host, pipe, events } = service();
    const logon = host.logon();
    await vi.waitFor(() => expect(pipe.written).toHaveLength(1));
    pipe.answer({ ev: "streamer", event: { type: "first-frame" } });
    pipe.answer({ ev: "streamer", event: { type: "rm -rf" } });
    pipe.answer({ ev: "streamer-exit", code: 1 });
    pipe.answer({ ev: "lost", why: "the renter signed out" });
    pipe.answer({ ev: "reply", ok: true });
    await logon;
    pipe.emit("close");
    expect(events).toEqual([
      { type: "first-frame" },
      { type: "exit", code: 1 },
      { type: "lost", why: "the renter signed out" },
      { type: "lost", why: "the session service went away" },
    ]);
  });

  it("is looked for only on Windows", async () => {
    const connect = vi.fn(() => {
      const pipe = fakePipe();
      setTimeout(() => pipe.emit("connect"));
      return pipe;
    });
    expect(await serviceInstalled({ platform: "linux", connect })).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    expect(await serviceInstalled({ platform: "win32", connect })).toBe(true);
    const missing = () => {
      const pipe = fakePipe();
      setTimeout(() => pipe.emit("error", new Error("ENOENT")));
      return pipe;
    };
    expect(await serviceInstalled({ platform: "win32", connect: missing })).toBe(false);
  });
});
