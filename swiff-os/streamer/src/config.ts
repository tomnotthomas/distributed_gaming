// What the streamer is told, and by whom.
//
// swiff-hostd starts one streamer per renter session, as the unprivileged
// swiff-stream user, and gives it three kinds of input (hostd's streamer.ts):
//
//   environment  SWIFF_SERVER_URL, SWIFF_HOST_ID, SWIFF_APPID — not secret
//   stdin        one JSON line { "sessionKey": "...", "expiresAt": <Unix s> }, then closed
//   arguments    hostd's `streamer.args`, set by the image — not secret
//
// The session key is the only secret and comes on stdin alone: a command line
// or an environment variable can be read through /proc. Everything about the
// capture is an argument, so the image decides it and the agent stays out of it.

import { DEFAULT_CAPTURE } from "@swiff/rtc";

/** Where the picture comes from: gamescope's PipeWire stream, or a synthetic one for VMs and tests. */
export type VideoSource = "pipewire" | "test";
/** Where the sound comes from: what the renter's session plays, a test tone, or nothing. */
export type AudioSource = "pipewire" | "test" | "off";
/** Which H.264 encoder to use. `auto` takes the first that works, GPU first. */
export type EncoderChoice = "auto" | "nvenc" | "vaapi" | "x264";

export type StreamerConfig = {
  serverUrl: string;
  hostId: string;
  appid: number | null;
  video: VideoSource;
  audio: AudioSource;
  encoder: EncoderChoice;
  /** The renter's PipeWire socket, an absolute path. Unset: this user's own. */
  pipewireRemote: string | null;
  /** The PipeWire node to capture: gamescope names its stream "gamescope". */
  pipewireTarget: string;
  width: number;
  height: number;
  frameRate: number;
  /** Video bits per second. */
  bitrate: number;
  /** Opus bits per second. */
  audioBitrate: number;
  /** Inject the renter's input through uinput. Off, input is received and dropped. */
  input: boolean;
  /** UDP ports for ICE, so a firewall can allow exactly these. */
  icePortRange: [number, number] | null;
  forceRelay: boolean;
  /** The helpers, so a test or a dev checkout can point at its own. */
  python: string;
  helperDir: string;
};

export type SessionGrant = { sessionKey: string; expiresAt: number };

/** A setting that is missing or wrong. The streamer exits without connecting. */
export class ConfigError extends Error {}

const DEFAULTS = {
  video: "pipewire",
  audio: "pipewire",
  encoder: "auto",
  pipewireTarget: "gamescope",
  width: DEFAULT_CAPTURE.width,
  height: 1080,
  frameRate: DEFAULT_CAPTURE.frameRate,
  bitrate: DEFAULT_CAPTURE.maxBitrate,
  audioBitrate: DEFAULT_CAPTURE.audioBitrate,
} as const;

const USAGE = `swiff-streamer [options] < grant.json
  --video pipewire|test        picture source (pipewire)
  --audio pipewire|test|off    sound source (pipewire)
  --encoder auto|nvenc|vaapi|x264   H.264 encoder (auto: GPU first, then x264)
  --pipewire-remote <path>     the renter's PipeWire socket
  --pipewire-target <name>     the node to capture (gamescope)
  --size <w>x<h>               picture size (1920x1080)
  --fps <n>                    frame rate (60)
  --bitrate <bits/s>           video bitrate (10000000)
  --audio-bitrate <bits/s>     Opus bitrate (128000)
  --no-input                   receive input but inject nothing
  --ice-ports <min>-<max>      UDP ports for ICE
  --force-relay                TURN only
  --python <path>              python3 for the helpers
  --helpers <dir>              directory of swiff-gst.py and swiff-uinput.py`;

/** Read the environment and the arguments. Throws ConfigError naming the bad setting. */
export function readConfig(
  env: Record<string, string | undefined>,
  argv: string[],
  helperDir: string,
): StreamerConfig {
  const serverUrl = required(env.SWIFF_SERVER_URL, "SWIFF_SERVER_URL");
  if (!/^wss?:\/\//.test(serverUrl)) throw new ConfigError("SWIFF_SERVER_URL must be ws:// or wss://");
  const hostId = required(env.SWIFF_HOST_ID, "SWIFF_HOST_ID");
  const appid = env.SWIFF_APPID ? whole(env.SWIFF_APPID, "SWIFF_APPID") : null;

  const config: StreamerConfig = {
    serverUrl,
    hostId,
    appid,
    ...DEFAULTS,
    pipewireRemote: null,
    input: true,
    icePortRange: null,
    forceRelay: false,
    python: "python3",
    helperDir,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new ConfigError(`${flag} needs a value\n${USAGE}`);
      return v;
    };
    switch (flag) {
      case "--video":
        config.video = oneOf(value(), ["pipewire", "test"], flag);
        break;
      case "--audio":
        config.audio = oneOf(value(), ["pipewire", "test", "off"], flag);
        break;
      case "--encoder":
        config.encoder = oneOf(value(), ["auto", "nvenc", "vaapi", "x264"], flag);
        break;
      case "--pipewire-remote": {
        const path = value();
        if (!path.startsWith("/")) throw new ConfigError("--pipewire-remote must be an absolute path");
        config.pipewireRemote = path;
        break;
      }
      case "--pipewire-target": {
        // It goes into the pipeline text, so nothing that could end the property there.
        const name = value();
        if (!/^[A-Za-z0-9._:-]{1,64}$/.test(name))
          throw new ConfigError("--pipewire-target must be a PipeWire node name: letters, digits, . _ : -");
        config.pipewireTarget = name;
        break;
      }
      case "--size": {
        const m = /^(\d+)x(\d+)$/.exec(value());
        if (!m) throw new ConfigError("--size must look like 1920x1080");
        config.width = even(Number(m[1]), "--size width");
        config.height = even(Number(m[2]), "--size height");
        break;
      }
      case "--fps":
        config.frameRate = whole(value(), flag);
        break;
      case "--bitrate":
        config.bitrate = whole(value(), flag);
        break;
      case "--audio-bitrate":
        config.audioBitrate = whole(value(), flag);
        break;
      case "--no-input":
        config.input = false;
        break;
      case "--ice-ports": {
        const m = /^(\d+)-(\d+)$/.exec(value());
        const [min, max] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
        if (!m || min < 1024 || max > 65535 || min >= max)
          throw new ConfigError("--ice-ports must be <min>-<max>, from 1024 to 65535, min below max");
        config.icePortRange = [min, max];
        break;
      }
      case "--force-relay":
        config.forceRelay = true;
        break;
      case "--python":
        config.python = value();
        break;
      case "--helpers":
        config.helperDir = value();
        break;
      case "--help":
        throw new ConfigError(USAGE);
      default:
        throw new ConfigError(`unknown option ${flag}\n${USAGE}`);
    }
  }
  return config;
}

/**
 * The grant hostd writes on stdin. Throws ConfigError without echoing the
 * input: it carries the session key.
 */
export function parseGrant(text: string): SessionGrant {
  let grant: unknown;
  try {
    grant = JSON.parse(text);
  } catch {
    throw new ConfigError("stdin is not the session grant JSON");
  }
  const { sessionKey, expiresAt } = (grant ?? {}) as Record<string, unknown>;
  if (typeof sessionKey !== "string" || !sessionKey) throw new ConfigError("the grant has no sessionKey");
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))
    throw new ConfigError("the grant has no expiresAt");
  return { sessionKey, expiresAt };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new ConfigError(`${name} is not set`);
  return value;
}

function whole(value: string, name: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n <= 0)
    throw new ConfigError(`${name} must be a whole number above 0`);
  return n;
}

function even(n: number, name: string): number {
  // 4:2:0 encoders need even sizes; an odd one fails deep inside GStreamer.
  if (n <= 0 || n % 2) throw new ConfigError(`${name} must be even and above 0`);
  return n;
}

function oneOf<T extends string>(value: string, options: readonly T[], name: string): T {
  if (!(options as readonly string[]).includes(value))
    throw new ConfigError(`${name} must be one of ${options.join(", ")}`);
  return value as T;
}
