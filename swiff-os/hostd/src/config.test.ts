import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig, readMachineKey } from "./config.ts";

const VALID = {
  serverUrl: "wss://swiff.example",
  machineId: "gaming-pc-1",
  machineKeyFile: "/var/lib/swiff/machine-key",
  streamer: { command: "/usr/lib/swiff/swiff-streamer", uid: 961, gid: 961 },
};

const dir = () => mkdtemp(join(tmpdir(), "swiff-hostd-"));

describe("config", () => {
  it("fills in the state and control paths", () => {
    expect(parseConfig(VALID)).toEqual({
      ...VALID,
      stateDir: "/var/lib/swiff/hostd",
      controlSocket: "/run/swiff-hostd/control.sock",
      streamer: { ...VALID.streamer, args: [] },
      state: null,
    });
  });

  it("reads the persistent state partition, and names its field that is missing", () => {
    const state = {
      device: "/dev/disk/by-partlabel/swiff-state",
      mountpoint: "/var/lib/swiff/state",
      localShare: "/var/lib/swiff/state-u.cred",
      attestCommand: "/usr/libexec/swiff/attest",
    };
    expect(parseConfig({ ...VALID, state }).state).toEqual(state);
    expect(() => parseConfig({ ...VALID, state: { ...state, localShare: "" } })).toThrow(/state.localShare/);
    expect(() => parseConfig({ ...VALID, state: "yes" })).toThrow(/state must be an object/);
  });

  it("names the field that is wrong", () => {
    expect(() => parseConfig({ ...VALID, serverUrl: "https://swiff.example" })).toThrow(/serverUrl/);
    expect(() => parseConfig({ ...VALID, machineId: "" })).toThrow(/machineId/);
    expect(() => parseConfig({ ...VALID, streamer: { ...VALID.streamer, args: [1] } })).toThrow(
      /streamer.args/,
    );
    expect(() => parseConfig([])).toThrow(ConfigError);
  });

  it("takes plain ws:// only for a server on this machine", () => {
    for (const url of ["ws://localhost:8080", "ws://127.0.0.1:8080", "ws://127.4.5.6", "ws://[::1]:8080"]) {
      expect(parseConfig({ ...VALID, serverUrl: url }).serverUrl).toBe(url);
    }
    for (const url of [
      "ws://swiff.example",
      "ws://10.0.0.2",
      "ws://127.0.0.1.example.com",
      "wss://",
      "not a url",
    ]) {
      expect(() => parseConfig({ ...VALID, serverUrl: url }), url).toThrow(ConfigError);
    }
  });

  it("never runs the streamer as root", () => {
    expect(() => parseConfig({ ...VALID, streamer: { ...VALID.streamer, uid: 0 } })).toThrow(/streamer.uid/);
    expect(() => parseConfig({ ...VALID, streamer: { ...VALID.streamer, gid: 0 } })).toThrow(/streamer.gid/);
  });

  it("reads the file, and says when it cannot", async () => {
    const path = join(await dir(), "hostd.json");
    await writeFile(path, JSON.stringify(VALID));
    expect((await loadConfig(path)).machineId).toBe("gaming-pc-1");
    await expect(loadConfig(`${path}.missing`)).rejects.toThrow(ConfigError);
  });
});

describe("the machine key file", () => {
  it("is read when its owner alone can read it", async () => {
    const path = join(await dir(), "machine-key");
    await writeFile(path, "the-key\n", { mode: 0o600 });
    expect(await readMachineKey(path)).toBe("the-key");
  });

  it("is refused when another user owns it", async () => {
    const path = join(await dir(), "machine-key");
    await writeFile(path, "the-key\n", { mode: 0o600 });
    await expect(readMachineKey(path, process.getuid!() + 1)).rejects.toThrow(/owned by/);
  });

  it("is refused when anyone else can read it, or it is empty", async () => {
    const path = join(await dir(), "machine-key");
    await writeFile(path, "the-key\n");
    await chmod(path, 0o644);
    await expect(readMachineKey(path)).rejects.toThrow(/chmod 600/);
    await writeFile(path, "\n");
    await chmod(path, 0o600);
    await expect(readMachineKey(path)).rejects.toThrow(/empty/);
  });
});
