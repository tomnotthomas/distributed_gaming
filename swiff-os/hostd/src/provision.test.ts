// Taking in what the owner's app provisions: its record, read as the app
// writes it (desktop/provision.cjs), sealed to the TPM and kept on the keep
// partition, and this boot's swiff-hostd config written from it.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkProvisioning,
  iwdNetwork,
  linuxKeep,
  parseRecord,
  provision,
  ProvisionError,
  RECORD_BYTES,
  RECORD_MAGIC,
  RECORD_VERSION,
  tpmSeal,
  tpmUnseal,
  type Keep,
  type Provisioning,
} from "./provision.ts";

const require = createRequire(import.meta.url);
/** The owner's app's own encoder: what it writes is what this reads. */
const { provisionRecord } = require("../../../desktop/provision.cjs") as {
  provisionRecord: (p: Provisioning) => Buffer;
};

const GIVEN: Provisioning = {
  serverUrl: "wss://lanterel.example",
  machineId: "gaming-pc-1",
  machineKey: "k3y-0f-the-owners-machine-1234567890",
};

/** A PC on Wi-Fi: the same, and the network it is on. */
const ON_WIFI: Provisioning = {
  ...GIVEN,
  wifi: { ssid: "Café Wi-Fi", security: "psk", passphrase: " \\back slash" },
};

/** The record around any payload, framed as desktop/provision.cjs frames it. */
function recordOf(payload: object): Buffer {
  const json = Buffer.from(JSON.stringify(payload));
  const record = Buffer.alloc(RECORD_BYTES);
  RECORD_MAGIC.copy(record, 0);
  record.writeUInt32BE(RECORD_VERSION, 8);
  record.writeUInt32BE(json.length, 12);
  createHash("sha256").update(json).digest().copy(record, 16);
  json.copy(record, 48);
  return record;
}

/** The image's own settings: everything but this machine's server, id and key. */
const IMAGE = {
  stateDir: "/var/lib/swiff/state/hostd",
  streamer: {
    command: "/usr/bin/node",
    args: ["/usr/lib/swiff/streamer/dist/swiff-streamer.mjs"],
    uid: 961,
    gid: 961,
  },
  state: {
    device: "/dev/disk/by-partlabel/swiff-state",
    mountpoint: "/var/lib/swiff/state",
    localShare: "/var/lib/swiff/keep/state-u.cred",
    attestCommand: "/usr/libexec/swiff/swiff-attest",
  },
};

describe("the record", () => {
  it("reads what the owner's app writes", () => {
    const record = provisionRecord(GIVEN);
    expect(record.length).toBe(RECORD_BYTES);
    expect(parseRecord(record)).toEqual(GIVEN);
  });

  it("finds none where there is no record: zeros, or the keep's own filesystem", () => {
    expect(parseRecord(Buffer.alloc(RECORD_BYTES))).toBeNull();
    const ext4 = Buffer.alloc(RECORD_BYTES);
    ext4.writeUInt16LE(0xef53, 1024 + 56);
    expect(parseRecord(ext4)).toBeNull();
  });

  it("refuses a record cut short, changed, or of another version", () => {
    const torn = provisionRecord(GIVEN);
    torn.fill(0, 60);
    expect(() => parseRecord(torn)).toThrow(/checksum/);
    const long = provisionRecord(GIVEN);
    long.writeUInt32BE(RECORD_BYTES, 12);
    expect(() => parseRecord(long)).toThrow(/cut short/);
    const newer = provisionRecord(GIVEN);
    newer.writeUInt32BE(2, 8);
    expect(() => parseRecord(newer)).toThrow(/version 2/);
  });

  it("takes only a wss:// server, a machine id and a machine key, and never quotes the key", () => {
    expect(() => checkProvisioning({ ...GIVEN, serverUrl: "ws://lanterel.example" })).toThrow(/wss:\/\//);
    expect(checkProvisioning({ ...GIVEN, serverUrl: "ws://127.0.0.1:8080" }).serverUrl).toBe(
      "ws://127.0.0.1:8080",
    );
    expect(() => checkProvisioning({ ...GIVEN, machineId: "a:b" })).toThrow(/machineId/);
    const short = { ...GIVEN, machineKey: "short key" };
    expect(() => checkProvisioning(short)).toThrow(ProvisionError);
    expect(() => checkProvisioning(short)).not.toThrow(/short key/);
    // Anything else in it is dropped: the record carries data, never a program or a path.
    expect(checkProvisioning({ ...GIVEN, streamer: { command: "/bin/sh" } })).toEqual(GIVEN);
  });
});

describe("the Wi-Fi network", () => {
  it("takes an open, WPA2 or WPA3 network, and a WPA2 key given as 64 hex digits", () => {
    expect(checkProvisioning(ON_WIFI)).toEqual(ON_WIFI);
    const open = { ssid: "Guest", security: "open" };
    expect(checkProvisioning({ ...GIVEN, wifi: open }).wifi).toEqual(open);
    const sae = { ssid: "Home", security: "sae", passphrase: "correct horse" };
    expect(checkProvisioning({ ...GIVEN, wifi: sae }).wifi).toEqual(sae);
    const psk = { ssid: "Home", security: "psk", passphrase: "ab".repeat(32) };
    expect(checkProvisioning({ ...GIVEN, wifi: psk }).wifi).toEqual(psk);
    expect(() => checkProvisioning({ ...GIVEN, wifi: { ...psk, security: "sae" } })).toThrow(
      "the provisioning's wifi.passphrase is not a sae passphrase",
    );
  });

  it("refuses a network iwd could not join, naming the field and never quoting the passphrase", () => {
    const wifi = { ssid: "Home", security: "psk", passphrase: "correct horse" };
    const refusals: [object, string][] = [
      [{ ...wifi, ssid: "" }, "wifi.ssid"],
      [{ ...wifi, ssid: "é".repeat(17) }, "wifi.ssid"],
      [{ ...wifi, ssid: "Home\n[Security]" }, "wifi.ssid"],
      [{ ...wifi, security: "8021x" }, "wifi.security"],
      [{ ...wifi, passphrase: "seven77" }, "wifi.passphrase"],
      [{ ...wifi, passphrase: "x".repeat(64) }, "wifi.passphrase"],
      [{ ...wifi, passphrase: "secret\n[Settings]" }, "wifi.passphrase"],
      [{ ssid: "Home", security: "psk" }, "wifi.passphrase"],
    ];
    for (const [bad, field] of refusals) {
      expect(() => checkProvisioning({ ...GIVEN, wifi: bad })).toThrow(`the provisioning's ${field}`);
      expect(() => checkProvisioning({ ...GIVEN, wifi: bad })).not.toThrow(/secret|seven77/);
    }
    expect(() => checkProvisioning({ ...GIVEN, wifi: "Home" })).toThrow(
      "the provisioning's wifi is not an object",
    );
  });

  it("is named as iwd names it, a WPA3 passphrase escaped as iwd reads it", () => {
    expect(iwdNetwork({ ssid: "Home Net_5G-2", security: "sae", passphrase: "correct horse" })).toEqual({
      name: "Home Net_5G-2.psk",
      contents: "[Security]\nPassphrase=correct horse\n\n[Settings]\nAutoConnect=true\n",
    });
    expect(iwdNetwork({ ssid: "Café Wi-Fi", security: "sae", passphrase: " \\back slash" })).toEqual({
      name: "=436166c3a92057692d4669.psk",
      contents: "[Security]\nPassphrase=\\s\\\\back slash\n\n[Settings]\nAutoConnect=true\n",
    });
    expect(iwdNetwork({ ssid: "Home", security: "psk", passphrase: "AB".repeat(32) }).contents).toBe(
      `[Security]\nPreSharedKey=${"ab".repeat(32)}\n\n[Settings]\nAutoConnect=true\n`,
    );
    // IEEE 802.11 Annex M's test vector: a WPA2 network gets the key derived from the passphrase, never the passphrase.
    expect(iwdNetwork({ ssid: "IEEE", security: "psk", passphrase: "password" })).toEqual({
      name: "IEEE.psk",
      contents:
        "[Security]\nPreSharedKey=f42c6fc52df0ebef9ebb4b90b38a5f902e83fe1b135a70e23aed762e9710a12e\n\n[Settings]\nAutoConnect=true\n",
    });
    expect(iwdNetwork({ ssid: "Guest", security: "open" })).toEqual({
      name: "Guest.open",
      contents: "[Settings]\nAutoConnect=true\n",
    });
  });
});

describe("provisioning a boot", () => {
  /** A keep partition in memory, a TPM that seals by prefixing, and the files in a directory of their own. */
  async function machine(
    head: Buffer,
    { hasFilesystem = false, sealFails = false, formatFails = false, credentialFails = false } = {},
  ) {
    const dir = await mkdtemp(join(tmpdir(), "swiff-provision-"));
    const paths = {
      // In a directory that is not there: the credential cannot be written.
      credential: join(dir, credentialFails ? "gone" : "", "provision.cred"),
      imageConfig: join(dir, "image-hostd.json"),
      config: join(dir, "hostd.json"),
      machineKey: join(dir, "machine-key"),
      wifi: join(dir, "iwd"),
    };
    await writeFile(paths.imageConfig, JSON.stringify(IMAGE));
    await mkdir(paths.wifi);
    const disk = {
      head: Buffer.from(head),
      wiped: 0,
      formatted: false,
      mounted: false,
      filesystem: hasFilesystem,
    };
    const keep: Keep = {
      head: async (bytes) => disk.head.subarray(0, bytes),
      wipe: async (bytes) => {
        disk.wiped = bytes;
        disk.head.fill(0);
      },
      format: async () => {
        if (formatFails) throw new Error("mkfs.ext4 exited with 1");
        disk.formatted = disk.filesystem = disk.mounted = true;
      },
      mount: async () => (disk.mounted = disk.filesystem),
    };
    const sealed: Buffer[] = [];
    const run = () =>
      provision({
        keep,
        seal: async (payload) => {
          if (sealFails) throw new Error("systemd-creds exited with 1");
          sealed.push(Buffer.from(payload));
          return Buffer.concat([Buffer.from("SEALED:"), payload]);
        },
        unseal: async (file) => {
          const credential = await readFile(file);
          if (!credential.subarray(0, 7).equals(Buffer.from("SEALED:"))) throw new Error("does not unseal");
          return credential.subarray(7);
        },
        paths,
        log: (message) => logs.push(message),
      });
    const logs: string[] = [];
    return { dir, paths, disk, sealed, logs, run };
  }

  it("seals a fresh record, zeroes it, formats the keep, and writes this boot's config and key", async () => {
    const m = await machine(provisionRecord(GIVEN));
    expect(await m.run()).toBe(true);
    expect(m.sealed.map((p) => JSON.parse(p.toString()))).toEqual([GIVEN]);
    // The plaintext record is gone from the disk before the keep is formatted.
    expect(m.disk.wiped).toBe(1024 * 1024);
    expect(m.disk.head.equals(Buffer.alloc(m.disk.head.length))).toBe(true);
    expect(m.disk.formatted).toBe(true);
    expect((await readFile(m.paths.credential)).subarray(0, 7).toString()).toBe("SEALED:");

    const config = JSON.parse(await readFile(m.paths.config, "utf8"));
    expect(config).toEqual({
      ...IMAGE,
      serverUrl: GIVEN.serverUrl,
      machineId: GIVEN.machineId,
      machineKeyFile: m.paths.machineKey,
    });
    expect(JSON.stringify(config)).not.toContain(GIVEN.machineKey);
    expect(await readFile(m.paths.machineKey, "utf8")).toBe(`${GIVEN.machineKey}\n`);
    // Root's alone.
    for (const file of [m.paths.config, m.paths.machineKey, m.paths.credential])
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(m.logs.join("\n")).not.toContain(GIVEN.machineKey);
  });

  it("seals the Wi-Fi network with the rest and writes it for iwd, root's alone, never logging it", async () => {
    const m = await machine(recordOf(ON_WIFI));
    expect(await m.run()).toBe(true);
    expect(m.sealed.map((p) => JSON.parse(p.toString()))).toEqual([ON_WIFI]);
    const network = join(m.paths.wifi, "=436166c3a92057692d4669.psk");
    expect(await readFile(network, "utf8")).toBe(iwdNetwork(ON_WIFI.wifi!).contents);
    expect(await readFile(network, "utf8")).toMatch(/^\[Security\]\nPreSharedKey=[0-9a-f]{64}\n/);
    expect(await readFile(network, "utf8")).not.toContain("back slash");
    expect((await stat(network)).mode & 0o777).toBe(0o600);
    expect(await readFile(m.paths.config, "utf8")).not.toContain("back slash");
    expect(m.logs.join("\n")).not.toContain("back slash");

    // Every later boot writes it again from the sealed provisioning, on a fresh /var.
    await writeFile(network, "");
    m.disk.mounted = false;
    expect(await m.run()).toBe(true);
    expect(await readFile(network, "utf8")).toBe(iwdNetwork(ON_WIFI.wifi!).contents);
  });

  it("leaves no temporary file behind when a file cannot be written", async () => {
    const m = await machine(recordOf(ON_WIFI));
    // A directory where the network file goes: the rename over it fails.
    await mkdir(join(m.paths.wifi, "=436166c3a92057692d4669.psk"));
    await expect(m.run()).rejects.toThrow();
    expect(await readdir(m.paths.wifi)).toEqual(["=436166c3a92057692d4669.psk"]);
    await expect(stat(m.paths.config)).rejects.toThrow();
  });

  it("writes no Wi-Fi network for a PC on a cable", async () => {
    const m = await machine(provisionRecord(GIVEN));
    expect(await m.run()).toBe(true);
    expect(await readdir(m.paths.wifi)).toEqual([]);
  });

  it("writes the config from the sealed provisioning at every later boot", async () => {
    const m = await machine(provisionRecord(GIVEN));
    await m.run();
    await writeFile(m.paths.config, "");
    m.disk.mounted = false;
    m.sealed.length = 0;
    expect(await m.run()).toBe(true);
    expect(m.sealed).toEqual([]);
    expect(m.disk.mounted).toBe(true);
    expect(JSON.parse(await readFile(m.paths.config, "utf8")).machineId).toBe(GIVEN.machineId);
  });

  it("zeroes the record when the TPM cannot seal it", async () => {
    const m = await machine(provisionRecord(GIVEN), { sealFails: true });
    await expect(m.run()).rejects.toThrow(/systemd-creds/);
    expect(m.disk.wiped).toBe(1024 * 1024);
    expect(m.disk.head.equals(Buffer.alloc(m.disk.head.length))).toBe(true);
    expect(m.disk.formatted).toBe(false);
  });

  it("zeroes the record when the keep cannot be formatted", async () => {
    const m = await machine(provisionRecord(GIVEN), { formatFails: true });
    await expect(m.run()).rejects.toThrow(/mkfs/);
    expect(m.disk.head.equals(Buffer.alloc(m.disk.head.length))).toBe(true);
    await expect(stat(m.paths.config)).rejects.toThrow();
  });

  it("zeroes the record when the sealed provisioning cannot be kept", async () => {
    const m = await machine(provisionRecord(GIVEN), { credentialFails: true });
    await expect(m.run()).rejects.toThrow(/ENOENT/);
    expect(m.disk.formatted).toBe(true);
    expect(m.disk.head.equals(Buffer.alloc(m.disk.head.length))).toBe(true);
    expect(m.logs.join("\n")).not.toContain(GIVEN.machineKey);
  });

  it("is not provisioned on a keep with neither a record nor a filesystem", async () => {
    const m = await machine(Buffer.alloc(RECORD_BYTES));
    expect(await m.run()).toBe(false);
    expect(m.logs).toEqual([
      "not provisioned: the owner's app has not restarted this PC into Lanterel OS yet",
    ]);
    await expect(stat(m.paths.config)).rejects.toThrow();
  });

  it("is not provisioned when the sealed provisioning no longer unseals", async () => {
    const m = await machine(Buffer.alloc(RECORD_BYTES), { hasFilesystem: true });
    await writeFile(m.paths.credential, "from another TPM");
    expect(await m.run()).toBe(false);
    expect(m.logs[0]).toMatch(/no longer unseals/);
    await expect(stat(m.paths.machineKey)).rejects.toThrow();
  });

  it("is not provisioned by a damaged record", async () => {
    const torn = provisionRecord(GIVEN);
    torn.fill(0xff, 100, 120);
    const m = await machine(torn);
    expect(await m.run()).toBe(false);
    expect(m.logs[0]).toMatch(/checksum/);
    expect(m.disk.formatted).toBe(false);
    expect(m.disk.wiped).toBe(1024 * 1024);
    expect(m.disk.head.equals(Buffer.alloc(m.disk.head.length))).toBe(true);
    expect(m.logs.join("\n")).not.toContain(GIVEN.machineKey);
  });

  it("zeroes a record whose magic alone is damaged", async () => {
    const damaged = provisionRecord(GIVEN);
    damaged.fill(0, 0, 8);
    const m = await machine(damaged);
    expect(await m.run()).toBe(false);
    expect(m.logs[0]).toMatch(/magic/);
    expect(m.disk.wiped).toBe(1024 * 1024);
    expect(m.disk.head.equals(Buffer.alloc(m.disk.head.length))).toBe(true);
    expect(m.logs.join("\n")).not.toContain(GIVEN.machineKey);
  });

  it("zeroes a record of another version", async () => {
    const other = provisionRecord(GIVEN);
    other.writeUInt32BE(2, 8);
    const m = await machine(other);
    expect(await m.run()).toBe(false);
    expect(m.logs[0]).toMatch(/version 2/);
    expect(m.disk.head.equals(Buffer.alloc(m.disk.head.length))).toBe(true);
  });
});

describe("the machine's side", () => {
  it("reads and zeroes the start of the keep, makes its filesystem and mounts it once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiff-keep-"));
    const device = join(dir, "keep");
    await writeFile(device, Buffer.concat([provisionRecord(GIVEN), Buffer.alloc(RECORD_BYTES, 1)]));
    const runs: string[][] = [];
    let mounted = false;
    const keep = linuxKeep({ device, mountpoint: "/var/lib/swiff/keep" }, async (command, args) => {
      runs.push([command, ...args]);
      if (command === "mountpoint" && !mounted) throw new Error("not a mountpoint");
      if (command === "mount") mounted = true;
      return "";
    });
    expect(parseRecord(await keep.head(RECORD_BYTES))).toEqual(GIVEN);
    await keep.wipe(RECORD_BYTES);
    expect((await readFile(device)).subarray(0, RECORD_BYTES).equals(Buffer.alloc(RECORD_BYTES))).toBe(true);
    await keep.format();
    expect(runs).toEqual([
      ["mkfs.ext4", "-q", "-F", "-L", "swiff-keep", device],
      ["mountpoint", "-q", "/var/lib/swiff/keep"],
      ["mount", "-t", "ext4", "-o", "nosuid,nodev,noexec", device, "/var/lib/swiff/keep"],
    ]);
    // Mounted already: not again.
    expect(await keep.mount()).toBe(true);
    expect(runs.filter(([c]) => c === "mount")).toHaveLength(1);
  });

  it("seals and unseals with systemd-creds under the signed PCR policy, the payload on stdin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiff-creds-"));
    const policy = { publicKey: join(dir, "pcr-public-key.pem"), signature: join(dir, "pcr-signature.json") };
    const calls: string[][] = [];
    const seal = tpmSeal(async (command, args, input) => {
      calls.push([command, ...args]);
      return Buffer.from(input);
    }, policy);
    expect((await seal(Buffer.from("payload"))).toString()).toBe("payload");
    const credential = join(dir, "provision.cred");
    const unseal = tpmUnseal(async (command, args) => {
      calls.push([command, ...args]);
      return Buffer.from("payload");
    }, policy);
    await expect(unseal(credential)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(credential, "sealed");
    await unseal(credential);
    expect(calls).toEqual([
      [
        "systemd-creds",
        "encrypt",
        "--name=swiff-provision",
        "--with-key=tpm2-with-public-key",
        `--tpm2-public-key=${policy.publicKey}`,
        "-",
        "-",
      ],
      [
        "systemd-creds",
        "decrypt",
        "--name=swiff-provision",
        `--tpm2-signature=${policy.signature}`,
        credential,
        "-",
      ],
    ]);
  });
});
