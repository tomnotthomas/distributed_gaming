// The key to the persistent rental state, split in two (rental-mode report §5.3,
// Keylime's U/V pattern). The state is a LUKS2 partition holding what must
// outlive a reboot; its key is U XOR V:
//
//   U  sealed to this PC's TPM under Swiff's signed PCR policy (systemd-creds),
//      so only a Swiff OS boot of this PC can unseal it;
//   V  held by the server, sealed with its STATE_KEY_SECRET, and released
//      (POST /api/machines/:id/state-key) only to a fresh, unused host
//      certificate from this machine's latest attested boot.
//
// Neither share opens the state alone: a disk taken away lacks V, and a host
// that is tampered with, revoked or booted something else in between is never
// sent V. Each try attests afresh for its certificate; a certificate refused as
// stale or replayed is replaced by a new attestation at once, once.
//
// The combined key lives only in memory, for the one cryptsetup call that opens
// the state, and is zeroed after it, as are both shares. It is never written to
// disk, a log or the environment.

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { Run } from "./system.ts";

/** Why the server keeps V back (session-keys.md, the state key). */
export const STATE_KEY_REFUSALS = ["gap", "cooldown", "revoked", "stale", "replayed"] as const;
export type StateKeyRefusal = (typeof STATE_KEY_REFUSALS)[number];

/** A host certificate from an attestation of this boot. */
export type HostCertificate = { hostCert: string; expiresAt: number };

/** The server refused V. `reason` is null for a refusal it did not name. */
export class StateKeyRefused extends Error {
  readonly status: number;
  readonly reason: StateKeyRefusal | null;
  constructor(status: number, reason: StateKeyRefusal | null, code: string | null) {
    super(`the state key was refused: ${status} ${reason ?? code ?? "with no reason"}`);
    this.status = status;
    this.reason = reason;
  }
}

/** The state partition: open it with a key, and whether this boot opened it already. */
export type StateDisk = {
  opened(): Promise<boolean>;
  /** Open and mount it with `key`, which never leaves memory but for cryptsetup's stdin. */
  open(key: Uint8Array): Promise<void>;
};

export type StateKeyDeps = {
  /** Attest this boot and get a fresh host certificate. */
  attest(): Promise<HostCertificate>;
  /** V, released to `hostCert`; StateKeyRefused when the server keeps it back. */
  releaseShare(hostCert: string): Promise<Buffer>;
  /** U, unsealed by the TPM. */
  unsealLocalShare(): Promise<Buffer>;
  disk: StateDisk;
};

/** One try to open the state: resolves once it is open, throws why not. */
export type StateUnlock = { unlock(): Promise<void> };

export function stateUnlock(deps: StateKeyDeps): StateUnlock {
  async function release(): Promise<Buffer> {
    try {
      return await deps.releaseShare((await deps.attest()).hostCert);
    } catch (cause) {
      if (!(cause instanceof StateKeyRefused) || (cause.reason !== "stale" && cause.reason !== "replayed"))
        throw cause;
      // The certificate was not this boot's latest, or was used already: attest again.
      return deps.releaseShare((await deps.attest()).hostCert);
    }
  }

  return {
    unlock: async () => {
      // The agent restarted within this boot: the state is open already, and V is not asked for again.
      if (await deps.disk.opened()) return;
      const v = await release();
      let u: Buffer | null = null;
      let key: Buffer | null = null;
      try {
        u = await deps.unsealLocalShare();
        key = combineShares(u, v);
        await deps.disk.open(key);
      } finally {
        v.fill(0);
        u?.fill(0);
        key?.fill(0);
      }
    },
  };
}

/** U XOR V, in a new buffer. Shares of different or too short a length are refused. */
export function combineShares(u: Uint8Array, v: Uint8Array): Buffer {
  if (u.length !== v.length) throw new Error("the state key's shares differ in length");
  if (u.length < 32) throw new Error("the state key's shares are shorter than 32 bytes");
  const key = Buffer.alloc(u.length);
  for (let i = 0; i < u.length; i++) key[i] = u[i]! ^ v[i]!;
  return key;
}

/**
 * The server's state-key release, asked with the host certificate as
 * `Authorization: Bearer`. One try: the agent tries again with a fresh attestation.
 */
export function stateKeyRelease(serverUrl: string, machineId: string): (hostCert: string) => Promise<Buffer> {
  const origin = new URL(serverUrl);
  origin.protocol = origin.protocol === "wss:" ? "https:" : "http:";
  const url = new URL(`/api/machines/${encodeURIComponent(machineId)}/state-key`, origin);
  return async (hostCert) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${hostCert}`, "content-type": "application/json" },
      body: "{}",
    });
    let body: { share?: unknown; error?: unknown; reason?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // No JSON body: the status says enough.
    }
    if (res.status === 200 && typeof body.share === "string" && body.share) {
      return Buffer.from(body.share, "base64");
    }
    const code = typeof body.error === "string" ? body.error : null;
    const named = [body.reason, body.error].find((r): r is StateKeyRefusal =>
      (STATE_KEY_REFUSALS as readonly unknown[]).includes(r),
    );
    if (res.status === 200) throw new Error("the state key's release carried no share");
    if (res.status >= 500)
      throw new Error(`the state key's release answered ${res.status}${code ? ` ${code}` : ""}`);
    throw new StateKeyRefused(res.status, named ?? null, code);
  };
}

/**
 * Attestation by the attestation client, until it is part of the agent: a
 * command that attests this boot and prints `{ "hostCert": ..., "expiresAt": ... }`.
 */
export function commandAttestation(command: string, exec: Run): () => Promise<HostCertificate> {
  return async () => {
    const { hostCert, expiresAt } = JSON.parse(await exec(command, [])) as Partial<HostCertificate>;
    if (typeof hostCert !== "string" || !hostCert || typeof expiresAt !== "number") {
      throw new Error(`${command} printed no host certificate`);
    }
    return { hostCert, expiresAt };
  };
}

export type StateConfig = {
  /** The LUKS2 state partition. */
  device: string;
  /** Where it is mounted once open. */
  mountpoint: string;
  /** U: a systemd-creds credential sealed to the TPM under Swiff's signed PCR policy. */
  localShare: string;
  /** The attestation client: attests this boot and prints a fresh host certificate. */
  attestCommand: string;
};

/** The device-mapper name the open state gets. */
export const STATE_MAPPER = "swiff-state";

/** U, unsealed from its credential by the TPM, as raw bytes on stdout. */
export function tpmLocalShare(credential: string, exec: RunBytes = runBytes): () => Promise<Buffer> {
  return () => exec("systemd-creds", ["decrypt", "--name=swiff-state-u", credential, "-"]);
}

/** The state partition on this machine: cryptsetup takes the key on stdin, never from a file. */
export function linuxStateDisk(
  config: Pick<StateConfig, "device" | "mountpoint">,
  exec: Run,
  feed: RunWithInput = runWithInput,
  mapperDir = "/dev/mapper",
): StateDisk {
  const mapped = `${mapperDir}/${STATE_MAPPER}`;
  const mounted = () =>
    exec("mountpoint", ["-q", config.mountpoint]).then(
      () => true,
      () => false,
    );
  return {
    opened: async () => (await exists(mapped)) && (await mounted()),
    open: async (key) => {
      if (!(await exists(mapped))) {
        await feed(
          "cryptsetup",
          ["open", "--type", "luks2", "--key-file=-", config.device, STATE_MAPPER],
          key,
        );
      }
      if (!(await mounted())) await exec("mount", [mapped, config.mountpoint]);
    },
  };
}

/** Runs a command and resolves with its stdout as bytes. */
export type RunBytes = (command: string, args: string[]) => Promise<Buffer>;

/** Runs a command with `input` on its stdin; resolves once it exits 0. */
export type RunWithInput = (command: string, args: string[], input: Uint8Array) => Promise<void>;

const runBytes: RunBytes = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      if (code === 0) resolve(out);
      else {
        out.fill(0);
        reject(new Error(`${command} exited with ${code}`));
      }
    });
  });

const runWithInput: RunWithInput = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
    );
    child.stdin.end(input);
  });

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
