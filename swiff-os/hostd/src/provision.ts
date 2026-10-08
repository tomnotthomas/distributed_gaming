// What the owner's app hands rental mode, and how this PC keeps it: the
// platform's address, this machine's id and its machine key. No secret is in
// the image; the owner's app (desktop/provision.cjs) writes one record raw at
// the start of the keep partition when it installs Lanterel OS and each time it
// restarts the PC into it:
//
//   offset  bytes
//        0      8  "SWIFFPRV"
//        8      4  version, 1 (big-endian)
//       12      4  length of the payload (big-endian)
//       16     32  SHA-256 of the payload
//       48      …  the payload: JSON { "serverUrl", "machineId", "machineKey" }
//                  then zeros, to 4096 bytes
//
// At every boot, before swiff-hostd (swiff-provision.service runs
// `swiff-hostd provision`):
//
//   a record there   seal its payload to this PC's TPM under Swiff's signed
//                    PCR 11 policy (systemd-creds, as the state's U share), so
//                    only a signed Lanterel OS boot of this PC opens it; zero the
//                    record; format the keep as ext4 and keep the sealed payload
//                    there (provision.cred). The keep held the old U share,
//                    which goes with it: the state is renewed, as it is anyway
//                    after Windows ran. Should the keep not take it, the
//                    record goes back for the next boot to take in again.
//   none             mount the keep.
//
// then unseal provision.cred and write this boot's swiff-hostd config (the
// image's own settings, /usr/lib/swiff/hostd.json, with this machine's server
// and id) and its machine key into /var/lib/swiff, root's alone, on the tmpfs
// /var. The record carries data only: everything that names a program, a
// device or a user comes from the image, so a record cannot make the agent run
// anything. The payload is never logged, and the plaintext record lives on the
// disk only from the owner's restart into Lanterel OS to its first boot.

import { createHash } from "node:crypto";
import { access, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { checkServerUrl, parseConfig } from "./config.ts";
import { PCR_POLICY, runBytes, runFilter, type RunBytes, type RunFilter } from "./state-key.ts";
import type { Run } from "./system.ts";

export const RECORD_MAGIC = Buffer.from("SWIFFPRV", "ascii");
export const RECORD_VERSION = 1;
/** The whole record, padding included: one 4 KiB block, whole sectors on any disk. */
export const RECORD_BYTES = 4096;
const HEADER_BYTES = 48;

/** What the owner's app provisions. */
export type Provisioning = { serverUrl: string; machineId: string; machineKey: string };

/** A record that is there but cannot be used, or a payload that is not a provisioning. */
export class ProvisionError extends Error {}

/**
 * The provisioning a record block holds; null when the block holds no record
 * (no magic: a keep already formatted, or never written). Throws
 * ProvisionError for a record cut short or of another version.
 */
export function parseRecord(block: Buffer): Provisioning | null {
  if (block.length < HEADER_BYTES || !block.subarray(0, 8).equals(RECORD_MAGIC)) return null;
  const version = block.readUInt32BE(8);
  if (version !== RECORD_VERSION) throw new ProvisionError(`the provisioning record is version ${version}`);
  const length = block.readUInt32BE(12);
  if (length > RECORD_BYTES - HEADER_BYTES || HEADER_BYTES + length > block.length) {
    throw new ProvisionError("the provisioning record is cut short");
  }
  const payload = block.subarray(HEADER_BYTES, HEADER_BYTES + length);
  if (!createHash("sha256").update(payload).digest().equals(block.subarray(16, 48))) {
    throw new ProvisionError("the provisioning record does not match its checksum");
  }
  return payloadOf(payload);
}

/** The provisioning in a JSON payload, each field checked. Throws ProvisionError, never quoting the payload. */
export function payloadOf(payload: Buffer): Provisioning {
  let raw: unknown;
  try {
    raw = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new ProvisionError("the provisioning is not JSON");
  }
  return checkProvisioning(raw);
}

/** A machine id the server can name (`npm run machine-key`: no commas, colons or spaces). */
const MACHINE_ID = /^[^\s,:/\\]{1,128}$/;
/** A machine key: printable ASCII, no spaces. */
const MACHINE_KEY = /^[\x21-\x7e]{16,512}$/;

/** The three fields of a provisioning, checked. Throws ProvisionError naming the field. */
export function checkProvisioning(raw: unknown): Provisioning {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProvisionError("the provisioning is not an object");
  }
  const { serverUrl, machineId, machineKey } = raw as Record<string, unknown>;
  if (typeof serverUrl !== "string") throw new ProvisionError("the provisioning has no serverUrl");
  try {
    checkServerUrl(serverUrl);
  } catch (cause) {
    throw new ProvisionError(`the provisioning's ${cause instanceof Error ? cause.message : cause}`);
  }
  if (typeof machineId !== "string" || !MACHINE_ID.test(machineId)) {
    throw new ProvisionError("the provisioning's machineId is not a machine id");
  }
  if (typeof machineKey !== "string" || !MACHINE_KEY.test(machineKey)) {
    throw new ProvisionError("the provisioning's machineKey is not a machine key");
  }
  return { serverUrl, machineId, machineKey };
}

/** The keep partition. */
export type Keep = {
  /** The first `bytes` bytes of the partition, raw. */
  head(bytes: number): Promise<Buffer>;
  /** Zero the first `bytes` bytes, on the disk before it resolves. */
  wipe(bytes: number): Promise<void>;
  /** Make a new ext4 on it and mount it: whatever it held is gone. */
  format(): Promise<void>;
  /** Mount it; false when it holds no filesystem (never provisioned, or a record that was damaged). */
  mount(): Promise<boolean>;
  /** Write `record` back at the start, the keep unmounted first, on the disk before it resolves. */
  restore(record: Buffer): Promise<void>;
};

export type ProvisionDeps = {
  keep: Keep;
  /** Seal a payload to this PC's TPM; resolves with the credential. */
  seal(payload: Buffer): Promise<Buffer>;
  /** Unseal the credential in `file`; resolves with the payload. */
  unseal(file: string): Promise<Buffer>;
  paths: ProvisionPaths;
  log?: (message: string) => void;
};

export type ProvisionPaths = {
  /** The sealed provisioning, on the mounted keep. */
  credential: string;
  /** The image's own swiff-hostd settings: everything but the server, the machine id and the key. */
  imageConfig: string;
  /** Where this boot's swiff-hostd config goes, and the machine key it names. */
  config: string;
  machineKey: string;
};

export const PATHS: ProvisionPaths = {
  credential: "/var/lib/swiff/keep/provision.cred",
  imageConfig: "/usr/lib/swiff/hostd.json",
  config: "/var/lib/swiff/hostd.json",
  machineKey: "/var/lib/swiff/machine-key",
};

/** The keep partition and where it is mounted. */
export const KEEP = { device: "/dev/disk/by-partlabel/swiff-keep", mountpoint: "/var/lib/swiff/keep" };

/** Bytes zeroed over a record once it is sealed: the record, and whatever a torn write left after it. */
const WIPE_BYTES = 1024 * 1024;

/**
 * Take in a record the owner's app left, then write this boot's swiff-hostd
 * config from the sealed provisioning. Resolves true once the config and the
 * machine key are written; false when this PC is not provisioned (or its
 * provisioning no longer unseals), and swiff-hostd then does not start.
 */
export async function provision({
  keep,
  seal,
  unseal,
  paths,
  log = () => {},
}: ProvisionDeps): Promise<boolean> {
  // A copy: put back should the keep not take the sealed provisioning.
  const block = Buffer.from(await keep.head(RECORD_BYTES));
  let fresh: Provisioning | null;
  try {
    fresh = parseRecord(block);
  } catch (cause) {
    block.fill(0);
    if (!(cause instanceof ProvisionError)) throw cause;
    // Its write overwrote the keep's filesystem: nothing on it can be used either.
    log(`${cause.message}: restart into Lanterel OS from the Lanterel app again`);
    return false;
  }
  if (fresh) {
    const payload = Buffer.from(JSON.stringify(fresh));
    let sealed: Buffer;
    try {
      // Sealed before anything is erased: a TPM that cannot seal leaves the record for the next boot.
      sealed = await seal(payload);
    } finally {
      payload.fill(0);
    }
    try {
      await keep.wipe(WIPE_BYTES);
      await keep.format();
      await writeDurably(paths.credential, sealed);
    } catch (cause) {
      // Nothing kept yet: the record goes back, so the next boot takes it in
      // again rather than finding this PC unprovisioned.
      await keep.restore(block).catch(() => {
        log(
          "could not put the provisioning record back: restart into Lanterel OS from the Lanterel app again",
        );
      });
      throw cause;
    } finally {
      block.fill(0);
    }
    log(`provisioned by the owner's app for machine ${fresh.machineId}`);
  } else if (!(await keep.mount())) {
    log("not provisioned: the owner's app has not restarted this PC into Lanterel OS yet");
    return false;
  }

  let payload: Buffer;
  try {
    payload = await unseal(paths.credential);
  } catch (cause) {
    const missing = (cause as NodeJS.ErrnoException)?.code === "ENOENT";
    log(
      missing
        ? "not provisioned: the keep holds no provisioning"
        : "the provisioning no longer unseals (the TPM was cleared, or this is not a Lanterel OS boot): restart into Lanterel OS from the Lanterel app again",
    );
    return false;
  }
  let given: Provisioning;
  try {
    given = payloadOf(payload);
  } finally {
    payload.fill(0);
  }
  const image = JSON.parse(await readFile(paths.imageConfig, "utf8")) as Record<string, unknown>;
  const config = {
    ...image,
    serverUrl: given.serverUrl,
    machineId: given.machineId,
    machineKeyFile: paths.machineKey,
  };
  // The agent would refuse it at start: refused here, before anything is written.
  parseConfig(config);
  await writeDurably(paths.machineKey, Buffer.from(`${given.machineKey}\n`));
  // Written last: the config is what starts swiff-hostd (ConditionPathExists).
  await writeDurably(paths.config, Buffer.from(`${JSON.stringify(config, null, 2)}\n`));
  return true;
}

/** Written whole or not at all, readable by root alone, and on the disk before it resolves. */
async function writeDurably(path: string, data: Buffer): Promise<void> {
  const tmp = `${path}.tmp`;
  await rm(tmp, { force: true });
  const file = await open(tmp, "wx", 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tmp, path);
  const dir = await open(dirname(path), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

/** The name the provisioning is sealed under. */
const CREDENTIAL_NAME = "swiff-provision";

/** Seal with systemd-creds under Swiff's signed PCR 11 policy, as the state's U share is. */
export function tpmSeal(filter: RunFilter = runFilter, policy: typeof PCR_POLICY = PCR_POLICY) {
  return (payload: Buffer) =>
    filter(
      "systemd-creds",
      [
        "encrypt",
        `--name=${CREDENTIAL_NAME}`,
        "--with-key=tpm2-with-public-key",
        `--tpm2-public-key=${policy.publicKey}`,
        "-",
        "-",
      ],
      payload,
    );
}

/** Unseal what tpmSeal sealed; only a boot whose PCR 11 Swiff signed can. */
export function tpmUnseal(exec: RunBytes = runBytes, policy: typeof PCR_POLICY = PCR_POLICY) {
  return async (file: string) => {
    // Its absence is told apart from a refusal: the first never was, the second is a changed TPM.
    await access(file);
    return exec("systemd-creds", [
      "decrypt",
      `--name=${CREDENTIAL_NAME}`,
      `--tpm2-signature=${policy.signature}`,
      file,
      "-",
    ]);
  };
}

/** The keep partition on this machine. */
export function linuxKeep(
  { device, mountpoint }: typeof KEEP,
  exec: Run,
  files: { open: typeof open } = { open },
): Keep {
  const mount = async () => {
    // Mounted already: swiff-provision ran before in this boot.
    const mounted = await exec("mountpoint", ["-q", mountpoint]).then(
      () => true,
      () => false,
    );
    if (!mounted) await exec("mount", ["-t", "ext4", "-o", "nosuid,nodev,noexec", device, mountpoint]);
  };
  return {
    head: async (bytes) => {
      const disk = await files.open(device, "r");
      try {
        const block = Buffer.alloc(bytes);
        const { bytesRead } = await disk.read(block, 0, bytes, 0);
        return block.subarray(0, bytesRead);
      } finally {
        await disk.close();
      }
    },
    wipe: async (bytes) => {
      const disk = await files.open(device, "r+");
      try {
        await disk.write(Buffer.alloc(bytes), 0, bytes, 0);
        await disk.sync();
      } finally {
        await disk.close();
      }
    },
    format: async () => {
      await exec("mkfs.ext4", ["-q", "-F", "-L", "swiff-keep", device]);
      await mount();
    },
    mount: () =>
      mount().then(
        () => true,
        () => false,
      ),
    restore: async (record) => {
      // Not under a mounted filesystem: it would write its superblock over the record.
      const mounted = await exec("mountpoint", ["-q", mountpoint]).then(
        () => true,
        () => false,
      );
      if (mounted) await exec("umount", [mountpoint]);
      const disk = await files.open(device, "r+");
      try {
        await disk.write(record, 0, record.length, 0);
        await disk.sync();
      } finally {
        await disk.close();
      }
    },
  };
}
