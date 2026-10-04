import { describe, expect, it } from "vitest";
import { ConfigError, parseGrant, readConfig } from "./config";

const ENV = { SWIFF_SERVER_URL: "wss://swiff.example", SWIFF_HOST_ID: "gaming-pc-1" };

describe("readConfig", () => {
  it("takes hostd's environment and defaults the rest to the desktop host's settings", () => {
    expect(readConfig({ ...ENV, SWIFF_APPID: "730" }, [], "/helpers")).toMatchObject({
      serverUrl: "wss://swiff.example",
      hostId: "gaming-pc-1",
      appid: 730,
      video: "pipewire",
      audio: "pipewire",
      encoder: "auto",
      pipewireTarget: "gamescope",
      width: 1920,
      height: 1080,
      frameRate: 60,
      bitrate: 10_000_000,
      input: true,
      helperDir: "/helpers",
    });
  });

  it("reads the image's arguments", () => {
    const config = readConfig(
      ENV,
      [
        "--video", "test", "--audio", "off", "--encoder", "x264", "--size", "1280x720", "--fps", "30",
        "--bitrate", "4000000", "--pipewire-remote", "/run/user/1000/pipewire-0", "--no-input",
        "--ice-ports", "40000-40100", "--force-relay", "--helpers", "/opt/h",
      ],
      "/helpers",
    ); // prettier-ignore
    expect(config).toMatchObject({
      video: "test",
      audio: "off",
      encoder: "x264",
      width: 1280,
      height: 720,
      frameRate: 30,
      bitrate: 4_000_000,
      pipewireRemote: "/run/user/1000/pipewire-0",
      input: false,
      icePortRange: [40000, 40100],
      forceRelay: true,
      helperDir: "/opt/h",
    });
  });

  it.each([
    [{}, [], /SWIFF_SERVER_URL is not set/],
    [{ ...ENV, SWIFF_SERVER_URL: "https://swiff.example" }, [], /ws:\/\/ or wss:\/\//],
    [{ SWIFF_SERVER_URL: "ws://x" }, [], /SWIFF_HOST_ID is not set/],
    [{ ...ENV, SWIFF_APPID: "abc" }, [], /SWIFF_APPID/],
    [ENV, ["--video", "x11"], /--video must be one of/],
    [ENV, ["--size", "1921x1080"], /even/],
    [ENV, ["--fps"], /needs a value/],
    [ENV, ["--pipewire-remote", "pipewire-0"], /absolute/],
    // Into the pipeline text it goes, so nothing that could start another property.
    [ENV, ["--pipewire-target", "gamescope ! filesink location=/tmp/x"], /node name/],
    [ENV, ["--ice-ports", "50000-40000"], /min below max/],
    [ENV, ["--session-key", "k"], /unknown option/],
  ])("refuses %o %o", (env, argv, message) => {
    expect(() => readConfig(env, argv as string[], "/h")).toThrow(ConfigError);
    expect(() => readConfig(env, argv as string[], "/h")).toThrow(message);
  });
});

describe("parseGrant", () => {
  it("reads hostd's grant line", () => {
    expect(parseGrant('{"sessionKey":"k.1","expiresAt":1700000000}\n')).toEqual({
      sessionKey: "k.1",
      expiresAt: 1_700_000_000,
    });
  });

  it("never repeats what it was given when it refuses it", () => {
    for (const text of ["sessionKey=secret-key", '{"sessionKey":"secret-key"}', '{"expiresAt":1}', "null"]) {
      expect(() => parseGrant(text)).toThrow(ConfigError);
      try {
        parseGrant(text);
      } catch (e) {
        expect((e as Error).message).not.toContain("secret-key");
      }
    }
  });
});
