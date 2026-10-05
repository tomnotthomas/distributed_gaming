import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { readConfig } from "./config";
import { CaptureError, startCapture, type MediaKind } from "./capture";

/** A helper process the test plays: it answers probes and checks, and streams on demand. */
class FakeHelper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  commands: string[] = [];
  constructor(readonly args: string[]) {
    super();
    this.stdin.setEncoding("utf8").on("data", (d: string) => this.commands.push(...d.trim().split("\n")));
  }
  /** One RTP packet, length-framed as rtpstreampay writes it. */
  packet(body: string) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(body.length);
    this.stdout.write(Buffer.concat([len, Buffer.from(body)]));
  }
  exit(code: number) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.stdout.end();
    setImmediate(() => this.emit("close", code));
  }
  kill() {
    this.exit(143);
    return true;
  }
}

function fakeSpawn({ elements = [] as string[], working = [] as string[], hangChecks = false } = {}) {
  const started: FakeHelper[] = [];
  const spawnFn = ((_cmd: string, args: string[]) => {
    const helper = new FakeHelper(args.slice(1));
    started.push(helper);
    const [mode, arg] = helper.args;
    if (mode === "--probe") {
      setImmediate(() => {
        helper.stdout.write(elements.map((e) => `${e}\n`).join(""));
        helper.exit(0);
      });
    } else if (mode === "--check") {
      // A hung check (a GPU driver that never answers) ends only when killed.
      if (!hangChecks) setImmediate(() => helper.exit(working.some((e) => arg!.includes(e)) ? 0 : 1));
    }
    return helper;
  }) as unknown as typeof spawn;
  const running = (kind: "video" | "audio") =>
    started.filter(
      (h) =>
        h.exitCode === null &&
        !h.args[0]!.startsWith("--") &&
        h.args[0]!.includes(kind === "video" ? "rtph264pay" : "rtpopuspay"),
    );
  return { spawnFn, started, running };
}

const config = (...argv: string[]) =>
  readConfig({ SWIFF_SERVER_URL: "ws://127.0.0.1:8080", SWIFF_HOST_ID: "pc" }, argv, "/helpers");
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("startCapture", () => {
  it("encodes with the first encoder that passes its check, GPU first", async () => {
    const fake = fakeSpawn({
      elements: ["nvh264enc", "vah264enc", "x264enc"],
      working: ["vah264enc", "x264enc"],
    });
    const logs: string[] = [];
    const capture = await startCapture({
      config: config(),
      onPacket: () => {},
      spawn: fake.spawnFn,
      log: (m) => logs.push(m),
    });
    expect(capture.encoder).toBe("vaapi");
    expect(logs).toContain("[swiff-streamer] the nvenc encoder does not work here");
    expect(fake.running("video")[0]!.args[0]).toContain("vah264enc name=enc");
    await capture.stop();
  });

  it("refuses to start with no working encoder: the renter would get no picture", async () => {
    const fake = fakeSpawn({ elements: ["x264enc"], working: [] });
    await expect(
      startCapture({ config: config(), onPacket: () => {}, spawn: fake.spawnFn, log: () => {} }),
    ).rejects.toThrow(CaptureError);
  });

  it("passes on each packet with its medium, and points PipeWire at the renter's socket", async () => {
    const fake = fakeSpawn({ elements: ["x264enc"], working: ["x264enc"] });
    const seen: [MediaKind, string][] = [];
    let env: NodeJS.ProcessEnv | undefined;
    const spawnFn = ((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      env = opts.env;
      return (fake.spawnFn as unknown as (c: string, a: string[]) => FakeHelper)(cmd, args);
    }) as unknown as typeof spawn;
    const capture = await startCapture({
      config: config("--audio", "test", "--pipewire-remote", "/run/user/1000/pipewire-0"),
      onPacket: (kind, p) => seen.push([kind, p.toString()]),
      spawn: spawnFn,
      log: () => {},
    });
    fake.running("video")[0]!.packet("v1");
    fake.running("audio")[0]!.packet("a1");
    await settle();
    expect(seen).toEqual([
      ["video", "v1"],
      ["audio", "a1"],
    ]);
    expect(env?.PIPEWIRE_REMOTE).toBe("/run/user/1000/pipewire-0");
    await capture.stop();
  });

  it("starts the picture again when it stops, as when gamescope restarts", async () => {
    const fake = fakeSpawn({ elements: ["x264enc"], working: ["x264enc"] });
    const capture = await startCapture({
      config: config("--audio", "off"),
      onPacket: () => {},
      spawn: fake.spawnFn,
      log: () => {},
      restartDelayMs: 5,
    });
    const first = fake.running("video")[0]!;
    first.packet("v");
    await settle();
    first.exit(1);
    await settle();
    const second = fake.running("video")[0]!;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    await capture.stop();
    expect(fake.running("video")).toHaveLength(0);
  });

  it("asks for one keyframe per burst of requests", async () => {
    const fake = fakeSpawn({ elements: ["x264enc"], working: ["x264enc"] });
    const capture = await startCapture({
      config: config("--audio", "off"),
      onPacket: () => {},
      spawn: fake.spawnFn,
      log: () => {},
    });
    capture.requestKeyframe();
    capture.requestKeyframe();
    capture.requestKeyframe();
    await settle();
    expect(fake.running("video")[0]!.commands).toEqual(["keyframe"]);
    await capture.stop();
  });

  it("says when the picture starts, and fails when the source never gives one", async () => {
    const fake = fakeSpawn({ elements: ["x264enc"], working: ["x264enc"] });
    const silent = await startCapture({
      config: config("--audio", "off"),
      onPacket: () => {},
      spawn: fake.spawnFn,
      log: () => {},
      firstVideoTimeoutMs: 50,
    });
    await expect(silent.videoStarted).rejects.toThrow(/no picture from the source/);
    await silent.stop();

    const flowing = await startCapture({
      config: config("--audio", "off"),
      onPacket: () => {},
      spawn: fake.spawnFn,
      log: () => {},
      firstVideoTimeoutMs: 5_000,
    });
    fake.running("video")[0]!.packet("v");
    await expect(flowing.videoStarted).resolves.toBeUndefined();
    await flowing.stop();
  });

  it("stops starting up when aborted: the hung check is killed and no helper starts", async () => {
    const fake = fakeSpawn({ elements: ["x264enc"], hangChecks: true });
    const startup = new AbortController();
    const starting = startCapture({
      config: config("--audio", "test"),
      onPacket: () => {},
      spawn: fake.spawnFn,
      log: () => {},
      signal: startup.signal,
    });
    await settle();
    const check = fake.started.find((h) => h.args[0] === "--check")!;
    expect(check.exitCode).toBeNull();
    startup.abort();
    await expect(starting).rejects.toThrow(CaptureError);
    expect(check.exitCode).not.toBeNull();
    expect(fake.running("video")).toHaveLength(0);
    expect(fake.running("audio")).toHaveLength(0);
  });
});
