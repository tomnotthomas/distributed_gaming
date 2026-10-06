import { describe, expect, it } from "vitest";
import { ConfigError, parseGrant, readConfig } from "./config";

const ENV = { SWIFF_SERVER_URL: "wss://swiff.example", SWIFF_HOST_ID: "gaming-pc-1" };

describe("readConfig", () => {
  it("takes hostd's environment and defaults the rest to the desktop host's settings", () => {
    expect(readConfig(ENV, [], "/helpers")).toMatchObject({
      serverUrl: "wss://swiff.example",
      hostId: "gaming-pc-1",
      video: "pipewire",
      audio: "pipewire",
      encoder: "auto",
      pipewireTarget: "gamescope",
      width: 1920,
      height: 1080,
      frameRate: 60,
      bitrate: 10_000_000,
      helperDir: "/helpers",
    });
  });

  it("serves Steam's sign-in only when the image names the agent's socket, for hostd's SWIFF_APPID", () => {
    const steam = ["--steam-socket", "/run/swiff/steam/login.sock"];
    expect(readConfig(ENV, [], "/helpers").steam).toBeNull();
    expect(readConfig({ ...ENV, SWIFF_APPID: "1245620" }, [], "/helpers").steam).toBeNull();
    expect(readConfig({ ...ENV, SWIFF_APPID: "1245620" }, steam, "/helpers").steam).toEqual({
      socket: "/run/swiff/steam/login.sock",
      appid: 1245620,
    });
    expect(() =>
      readConfig({ ...ENV, SWIFF_APPID: "1245620" }, ["--steam-socket", "login.sock"], "/helpers"),
    ).toThrow(/absolute/);
  });

  it("refuses the Steam agent's socket without a valid SWIFF_APPID", () => {
    const steam = ["--steam-socket", "/run/swiff/steam/login.sock"];
    for (const appid of [undefined, "", "abc", "0", "012", "12345678901"]) {
      expect(() => readConfig({ ...ENV, SWIFF_APPID: appid }, steam, "/helpers")).toThrow(ConfigError);
      expect(() => readConfig({ ...ENV, SWIFF_APPID: appid }, steam, "/helpers")).toThrow(/SWIFF_APPID/);
    }
  });

  it("reads the image's arguments", () => {
    const config = readConfig(
      ENV,
      [
        "--video", "test", "--audio", "off", "--encoder", "x264", "--size", "1280x720", "--fps", "30",
        "--bitrate", "4000000", "--pipewire-remote", "/run/user/1000/pipewire-0", "--helpers", "/opt/h",
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
      helperDir: "/opt/h",
    });
  });

  it.each([
    [{}, [], /SWIFF_SERVER_URL is not set/],
    [{ ...ENV, SWIFF_SERVER_URL: "https://swiff.example" }, [], /ws:\/\/ or wss:\/\//],
    // The session key would cross the network in the clear.
    [
      { ...ENV, SWIFF_SERVER_URL: "ws://swiff.example" },
      [],
      /must be wss:\/\/ for a server off this machine/,
    ],
    [{ ...ENV, SWIFF_SERVER_URL: "ws://10.0.2.2:8080" }, [], /must be wss:\/\//],
    [{ SWIFF_SERVER_URL: "ws://x" }, [], /SWIFF_HOST_ID is not set/],
    [ENV, ["--video", "x11"], /--video must be one of/],
    [ENV, ["--size", "1921x1080"], /even/],
    [ENV, ["--fps"], /needs a value/],
    [ENV, ["--pipewire-remote", "pipewire-0"], /absolute/],
    // Into the pipeline text it goes, so nothing that could start another property.
    [ENV, ["--pipewire-target", "gamescope ! filesink location=/tmp/x"], /node name/],
    [ENV, ["--session-key", "k"], /unknown option/],
  ])("refuses %o %o", (env, argv, message) => {
    expect(() => readConfig(env, argv as string[], "/h")).toThrow(ConfigError);
    expect(() => readConfig(env, argv as string[], "/h")).toThrow(message);
  });
});

describe("signaling encryption", () => {
  it("takes plain ws:// only to this machine, or where a test asks for it", () => {
    for (const url of [
      "ws://127.0.0.1:8080",
      "ws://localhost:8080",
      "ws://[::1]:8080",
      "wss://swiff.example",
    ])
      expect(readConfig({ ...ENV, SWIFF_SERVER_URL: url }, [], "/h").serverUrl).toBe(url);
    expect(
      readConfig({ ...ENV, SWIFF_SERVER_URL: "ws://10.0.2.2:8080" }, ["--insecure-signaling"], "/h")
        .serverUrl,
    ).toBe("ws://10.0.2.2:8080");
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
