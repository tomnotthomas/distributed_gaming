// Taking in what the owner's app provisions: its record, read as the app
// writes it (desktop/provision.cjs), opened, sealed to the TPM and kept on the
// keep partition, and this boot's swiff-hostd config written from it. The
// TPM's part of the hand-over is handover.test.ts's.

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decrypt, parseBody } from "./handover.ts";
import {
  checkProvisioning,
  iwdNetwork,
  linuxKeep,
  parseRecord,
  payloadOf,
  provision,
  ProvisionError,
  RECORD_BYTES,
  RECORD_MAGIC,
  tpmSeal,
  tpmUnseal,
  type Keep,
  type Provisioning,
} from "./provision.ts";

const require = createRequire(import.meta.url);
type Sealed = { public: Buffer; private: Buffer };
/** The owner's app's own encoder: what it writes is what this reads. */
const { provisionRecord } = require("../../../desktop/provision.cjs") as {
  provisionRecord: (p: Provisioning, seal: (key: Buffer) => Promise<Sealed>) => Promise<Buffer>;
};

/** A TPM stand-in for the hand-over: it seals a key by keeping it, and opens only what it sealed. */
const kept = new Map<string, Buffer>();
const standIn = {
  seal: async (key: Buffer): Promise<Sealed> => {
    const pub = randomBytes(16);
    kept.set(pub.toString("hex"), Buffer.from(key));
    return { public: pub, private: Buffer.from("private") };
  },
  open: async (body: Buffer): Promise<Buffer> => {
    const sealed = parseBody(body);
    const key = kept.get(sealed.public.toString("hex"));
    if (!key) throw new ProvisionError("the TPM refuses to open the provisioning record");
    return decrypt(sealed, Buffer.from(key));
  },
};
const sealedRecord = (p: Provisioning) => provisionRecord(p, standIn.seal);

/** A version 1 record, as the owner's app wrote one before it sealed them: the payload in the clear. */
function plaintextRecord(p: Provisioning): Buffer {
  const payload = Buffer.from(JSON.stringify(p));
  const record = Buffer.alloc(RECORD_BYTES);
  RECORD_MAGIC.copy(record);
  record.writeUInt32BE(1, 8);
  record.writeUInt32BE(payload.length, 12);
  createHash("sha256").update(payload).digest().copy(record, 16);
  payload.copy(record, 48);
  return record;
}

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
  it("reads what the owner's app writes, which holds no machine key in the clear", async () => {
    const record = await sealedRecord(GIVEN);
    expect(record.length).toBe(RECORD_BYTES);
    expect(record.includes(GIVEN.machineKey)).toBe(false);
    expect(payloadOf(await standIn.open(parseRecord(record)!))).toEqual(GIVEN);
  });

  it("finds none where there is no record: zeros, or the keep's own filesystem", () => {
    expect(parseRecord(Buffer.alloc(RECORD_BYTES))).toBeNull();
    const ext4 = Buffer.alloc(RECORD_BYTES);
    ext4.writeUInt16LE(0xef53, 1024 + 56);
    expect(parseRecord(ext4)).toBeNull();
  });

  it("refuses a record cut short, changed, or of another version, the plaintext version 1 among them", async () => {
    const torn = await sealedRecord(GIVEN);
    torn.fill(0, 60);
    expect(() => parseRecord(torn)).toThrow(/checksum/);
    const long = await sealedRecord(GIVEN);
    long.writeUInt32BE(RECORD_BYTES, 12);
    expect(() => parseRecord(long)).toThrow(/cut short/);
    const newer = await sealedRecord(GIVEN);
    newer.writeUInt32BE(3, 8);
    expect(() => parseRecord(newer)).toThrow(/version 3/);
    expect(() => parseRecord(plaintextRecord(GIVEN))).toThrow(/version 1/);
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

  it("is named as iwd names it, its passphrase escaped as iwd reads it", () => {
    expect(iwdNetwork({ ssid: "Home Net_5G-2", security: "sae", passphrase: "correct horse" })).toEqual({
      name: "Home Net_5G-2.psk",
      contents: "[Security]\nPassphrase=correct horse\n\n[Settings]\nAutoConnect=true\n",
    });
    expect(iwdNetwork(ON_WIFI.wifi!)).toEqual({
      name: "=436166c3a92057692d4669.psk",
      contents: "[Security]\nPassphrase=\\s\\\\back slash\n\n[Settings]\nAutoConnect=true\n",
    });
    expect(iwdNetwork({ ssid: "Home", security: "psk", passphrase: "AB".repeat(32) }).contents).toBe(
      `[Security]\nPreSharedKey=${"ab".repeat(32)}\n\n[Settings]\nAutoConnect=true\n`,
    );
    expect(iwdNetwork({ ssid: "Guest", security: "open" })).toEqual({
      name: "Guest.open",
      contents: "[Settings]\nAutoConnect=true\n",
    });
  });
});

describe("provisioning a boot", () => {
  /**
   * A keep partition in memory, the TPM stand-in that opens the hand-over, a
   * TPM that seals by prefixing, and the files in a directory of their own.
   */
  async function machine(
    head: Buffer,
    {
      hasFilesystem = false,
      sealFails = false,
      formatFails = false,
      credentialFails = false,
      open = standIn.open,
    } = {},
  ) {
    const dir = await mkdtemp(join(tmpdir(), "swiff-provision-"));
    const paths = {
      // In a directory that is not there: the credential cannot be written.
      credential: join(dir, credentialFails ? "gone" : "", "provision.cred"),
      imageConfig: join(dir, "image-hostd.json"),
      config: join(dir, "hostd.json"),
      machineKey: join(dir, "machine-key"),
      wifi: join(dir, "iwd"),
      goLive: join(dir, "go-live"),
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
    const opened: Buffer[] = [];
    const run = () =>
      provision({
        keep,
        open: async (body) => {
          const payload = await open(body);
          opened.push(payload);
          return payload;
        },
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
    return { dir, paths, disk, sealed, opened, logs, run };
  }

  it("opens a fresh record, seals it, zeroes it, formats the keep, and writes this boot's config and key", async () => {
    const m = await machine(await sealedRecord(GIVEN));
    expect(await m.run()).toBe(true);
    expect(m.sealed.map((p) => JSON.parse(p.toString()))).toEqual([GIVEN]);
    // The opened payload is zeroed once it is read.
    expect(m.opened).toHaveLength(1);
    expect(m.opened[0]!.equals(Buffer.alloc(m.opened[0]!.length))).toBe(true);
    // The record is gone from the disk before the keep is formatted.
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
    // A fresh record is the owner's Go live: swiff-hostd offers the PC in this boot.
    expect(await readFile(m.paths.goLive, "utf8")).toBe("");
    // Root's alone.
    for (const file of [m.paths.config, m.paths.machineKey, m.paths.credential, m.paths.goLive])
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(m.logs.join("\n")).not.toContain(GIVEN.machineKey);
  });

  it("seals the Wi-Fi network with the rest and writes it for iwd, root's alone, never logging it", async () => {
    const record = await sealedRecord(ON_WIFI);
    expect(record.includes("back slash")).toBe(false);
    const m = await machine(record);
    expect(await m.run()).toBe(true);
    expect(m.sealed.map((p) => JSON.parse(p.toString()))).toEqual([ON_WIFI]);
    const network = join(m.paths.wifi, "=436166c3a92057692d4669.psk");
    // WPA2 given, the passphrase all the same: a WPA2/WPA3 network is joined with SAE, which needs it.
    expect(await readFile(network, "utf8")).toBe(
      "[Security]\nPassphrase=\\s\\\\back slash\n\n[Settings]\nAutoConnect=true\n",
    );
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
    const m = await machine(await sealedRecord(ON_WIFI));
    // A directory where the network file goes: the rename over it fails.
    await mkdir(join(m.paths.wifi, "=436166c3a92057692d4669.psk"));
    await expect(m.run()).rejects.toThrow();
    expect(await readdir(m.paths.wifi)).toEqual(["=436166c3a92057692d4669.psk"]);
    await expect(stat(m.paths.config)).rejects.toThrow();
  });

  it("writes no Wi-Fi network for a PC on a cable", async () => {
    const m = await machine(await sealedRecord(GIVEN));
    expect(await m.run()).toBe(true);
    expect(await readdir(m.paths.wifi)).toEqual([]);
  });

  it("writes the config from the sealed provisioning at every later boot", async () => {
    const m = await machine(await sealedRecord(GIVEN));
    await m.run();
    // A new boot: /var/lib/swiff is a tmpfs again.
    await writeFile(m.paths.config, "");
    await rm(m.paths.goLive);
    m.disk.mounted = false;
    m.sealed.length = 0;
    expect(await m.run()).toBe(true);
    expect(m.sealed).toEqual([]);
    expect(m.disk.mounted).toBe(true);
    expect(JSON.parse(await readFile(m.paths.config, "utf8")).machineId).toBe(GIVEN.machineId);
    // No Go live came with this boot: the agent offers only what it took off offer itself.
    expect(existsSync(m.paths.goLive)).toBe(false);
  });

  it("zeroes the record when the TPM cannot seal it", async () => {
    const m = await machine(await sealedRecord(GIVEN), { sealFails: true });
    await expect(m.run()).rejects.toThrow(/systemd-creds/);
    expect(m.disk.wiped).toBe(1024 * 1024);
    expect(m.disk.head.equals(Buffer.alloc(m.disk.head.length))).toBe(true);
    expect(m.disk.formatted).toBe(false);
  });

  it("zeroes the record when the keep cannot be formatted", async () => {
    const m = await machine(await sealedRecord(GIVEN), { formatFails: true });
    await expect(m.run()).rejects.toThrow(/mkfs/);
    expect(m.disk.head.equals(Buffer.alloc(m.disk.head.length))).toBe(true);
    await expect(stat(m.paths.config)).rejects.toThrow();
  });

  it("zeroes the record when the sealed provisioning cannot be kept", async () => {
    const m = await machine(await sealedRecord(GIVEN), { credentialFails: true });
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
    const torn = await sealedRecord(GIVEN);
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
    const damaged = await sealedRecord(GIVEN);
    damaged.fill(0, 0, 8);
    const m = await machine(damaged);
    expect(await m.run()).toBe(false);
    expect(m.logs[0]).toMatch(/magic/);
    expect(m.disk.wiped).toBe(1024 * 1024);
    expect(m.disk.head.equals(Buffer.alloc(m.disk.head.length))).toBe(true);
    expect(m.logs.join("\n")).not.toContain(GIVEN.machineKey);
  });

  it("refuses and zeroes a plaintext record of version 1", async () => {
    const m = await machine(plaintextRecord(GIVEN));
    expect(await m.run()).toBe(false);
    expect(m.logs).toEqual([
      "the provisioning record is version 1: restart into Lanterel OS from the Lanterel app again",
    ]);
    expect(m.opened).toEqual([]);
    expect(m.disk.wiped).toBe(1024 * 1024);
    expect(m.disk.head.equals(Buffer.alloc(m.disk.head.length))).toBe(true);
    expect(m.disk.formatted).toBe(false);
  });

  it("zeroes a record the TPM does not open", async () => {
    const m = await machine(await sealedRecord(GIVEN), {
      open: async () => {
        throw new ProvisionError(
          "this boot is not one Lanterel signed, so the provisioning record cannot be opened",
        );
      },
    });
    expect(await m.run()).toBe(false);
    expect(m.logs).toEqual([
      "this boot is not one Lanterel signed, so the provisioning record cannot be opened: restart into Lanterel OS from the Lanterel app again",
    ]);
    expect(m.disk.wiped).toBe(1024 * 1024);
    expect(m.disk.head.equals(Buffer.alloc(m.disk.head.length))).toBe(true);
    expect(m.disk.formatted).toBe(false);
    expect(m.sealed).toEqual([]);
    await expect(stat(m.paths.config)).rejects.toThrow();
  });

  it("zeroes a record when the TPM cannot be reached", async () => {
    const m = await machine(await sealedRecord(GIVEN), {
      open: async () => {
        throw new Error("ENOENT: no such file or directory, open '/dev/tpmrm0'");
      },
    });
    expect(await m.run()).toBe(false);
    expect(m.logs[0]).toMatch(/cannot be opened \(ENOENT.*tpmrm0'\): restart into Lanterel OS/);
    expect(m.disk.head.equals(Buffer.alloc(m.disk.head.length))).toBe(true);
  });

  it("zeroes a record that opens to no provisioning, and zeroes what it opened to", async () => {
    const m = await machine(await sealedRecord(GIVEN), {
      open: async () => Buffer.from(`not ${GIVEN.machineKey}`),
    });
    expect(await m.run()).toBe(false);
    expect(m.logs[0]).toMatch(/not JSON/);
    expect(m.opened[0]!.equals(Buffer.alloc(m.opened[0]!.length))).toBe(true);
    expect(m.disk.head.equals(Buffer.alloc(m.disk.head.length))).toBe(true);
    expect(m.logs.join("\n")).not.toContain(GIVEN.machineKey);
  });
});

describe("the machine's side", () => {
  it("reads and zeroes the start of the keep, makes its filesystem and mounts it once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiff-keep-"));
    const device = join(dir, "keep");
    const record = await sealedRecord(GIVEN);
    await writeFile(device, Buffer.concat([record, Buffer.alloc(RECORD_BYTES, 1)]));
    const runs: string[][] = [];
    let mounted = false;
    const keep = linuxKeep({ device, mountpoint: "/var/lib/swiff/keep" }, async (command, args) => {
      runs.push([command, ...args]);
      if (command === "mountpoint" && !mounted) throw new Error("not a mountpoint");
      if (command === "mount") mounted = true;
      return "";
    });
    expect(parseRecord(await keep.head(RECORD_BYTES))).toEqual(parseRecord(record));
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

  it("seals and unseals with systemd-creds under the signed PCR policy and PCRs 12 and 13 at zero, the payload on stdin", async () => {
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
        "--tpm2-pcrs=12+13",
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
