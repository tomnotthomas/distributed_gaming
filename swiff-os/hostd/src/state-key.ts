// The key to the persistent rental state, split in two (rental-mode report §5.3,
// Keylime's U/V pattern; the server's side is server/src/state-key.ts). The
// state is a LUKS2 partition holding what must outlive a reboot; its key is
// U XOR V:
//
//   U  32 random bytes made here when the partition is formatted, sealed to
//      this PC's TPM (systemd-creds) under Swiff's signed PCR 11 policy, so only
//      a signed Swiff OS boot of this PC can unseal it. The id of the V it pairs
//      with is kept beside it.
//   V  the server's share, released only to a fresh, unused host certificate
//      from this machine's latest attested boot.
//
// Once per boot, before anything market-facing:
//
//   attest ──► POST state-key ──► 200 { keyId, share }  keyId is U's: open with U XOR V;
//                                                       if U does not unseal or the key
//                                                       does not open, renew on a fresh
//                                                       certificate
//                                                       another: a format cut short, so
//                                                       renew on a fresh certificate
//                             ──► 404 no-state-key      renew: PUT state-key with the
//                             ──► 409 continuity-gap    same certificate, and format
//                                                       the partition anew with a fresh U
//                             ──► 401 stale-host-cert   attest again at once, once
//                             ──► anything else         this try fails; the agent tries
//                                                       again later, off the market
//
// A renewal formats first and seals U last, with its key id written after it:
// the key id is what says the format finished, so one cut short is renewed
// again rather than opened with a U that does not match. A seal that fails
// closes the partition again, so the next try renews rather than finding it open.
//
// The combined key lives only in memory, for the cryptsetup calls that format
// or open the state, and is zeroed after them, as are both shares. It is never
// written to disk, a log or the environment.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import type { StateKeyError, StateKeyGrant } from "../../../server/src/protocol.ts";
import type { Run } from "./system.ts";

/** Bytes in each share, and in the key. */
export const SHARE_BYTES = 32;

/** How long the attestation client, and each state-key call, may take. */
export const ATTEST_TIMEOUT_MS = 60_000;
export const CALL_TIMEOUT_MS = 30_000;

/** A host certificate from an attestation of this boot. */
export type HostCertificate = { hostCert: string; expiresAt: number };

/** A state-key call the server refused. */
export class StateKeyRefused extends Error {
  readonly status: number;
  readonly code: StateKeyError["error"] | null;
  /** The server's retry-after, for `rate-limited`. */
  readonly retryAfterMs: number | null;
  constructor(
    call: string,
    status: number,
    code: StateKeyError["error"] | null,
    retryAfterMs: number | null,
  ) {
    super(`${call} answered ${status}${code ? ` ${code}` : ""}`);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** U did not unseal, or U XOR V did not open the state, and renewing it failed too. */
export class UnsealFailed extends Error {}

/** The server's state-key calls, each made with a host certificate. */
export type StateKeyApi = {
  /** POST: the machine's current V. */
  release(hostCert: string): Promise<StateKeyGrant>;
  /** PUT: a new V; the old one is gone. */
  replace(hostCert: string): Promise<StateKeyGrant>;
};

/** U, sealed to the TPM, with the id of the V it pairs with. */
export type LocalShare = {
  /** The id of the V that U pairs with; null when no format has finished. */
  keyId(): Promise<string | null>;
  unseal(): Promise<Buffer>;
  /** Seal `u` for the V named `keyId`, replacing any U before. */
  seal(keyId: string, u: Uint8Array): Promise<void>;
};

/** The state partition. */
export type StateDisk = {
  /** Open and mounted in this boot already. */
  opened(): Promise<boolean>;
  /** Open and mount it with `key`. */
  open(key: Uint8Array): Promise<void>;
  /** Format it anew for `key`, then open and mount it: whatever it held is gone. */
  format(key: Uint8Array): Promise<void>;
  /** Unmount and close it. */
  close(): Promise<void>;
};

export type StateKeyDeps = {
  /** Attest this boot and get a fresh host certificate. */
  attest(): Promise<HostCertificate>;
  api: StateKeyApi;
  local: LocalShare;
  disk: StateDisk;
  log?: (message: string) => void;
};

/** One try to open the state: resolves once it is open, throws why not. */
export type StateUnlock = { unlock(): Promise<void> };

/** Opens the state with U XOR V: V from the server for a fresh certificate, U sealed in the TPM; the combined key is never stored. */
export function stateUnlock({ attest, api, local, disk, log = () => {} }: StateKeyDeps): StateUnlock {
  const fresh = async () => (await attest()).hostCert;

  /** V for this certificate, attesting again once when it is stale; or the certificate to renew the state on. */
  async function release(hostCert: string): Promise<{ grant: StateKeyGrant } | { renew: string }> {
    for (let again = false; ; again = true) {
      try {
        return { grant: await api.release(hostCert) };
      } catch (cause) {
        if (!(cause instanceof StateKeyRefused)) throw cause;
        if (cause.code === "no-state-key" || cause.code === "continuity-gap") {
          log(
            cause.code === "no-state-key"
              ? "the server has no state key for this PC yet: making one"
              : "something else booted since this PC last attested: its state is formatted anew",
          );
          // The refusal did not spend the certificate: the PUT goes on it.
          return { renew: hostCert };
        }
        if (cause.code !== "stale-host-cert" || again) throw cause;
        hostCert = await fresh();
      }
    }
  }

  /** A new V, and the partition formatted anew for it with a fresh U. */
  async function renew(hostCert: string): Promise<void> {
    const v = share(await api.replace(hostCert));
    const u = randomBytes(SHARE_BYTES);
    let key: Buffer | null = null;
    try {
      key = combineShares(u, v.bytes);
      await disk.format(key);
      try {
        await local.seal(v.keyId, u);
      } catch (cause) {
        await disk.close();
        throw cause;
      }
    } finally {
      v.bytes.fill(0);
      u.fill(0);
      key?.fill(0);
    }
  }

  return {
    unlock: async () => {
      // The agent restarted within this boot: the state is open already, and V is not asked for again.
      if (await disk.opened()) return;
      const released = await release(await fresh());
      if ("renew" in released) return renew(released.renew);
      const v = share(released.grant);
      let u: Buffer | null = null;
      let key: Buffer | null = null;
      let unsealFailed = false;
      try {
        if ((await local.keyId()) !== v.keyId) {
          // U is for another V (a renewal cut short before it sealed U).
          log("the state's sealed share is not for the server's: it is formatted anew");
        } else {
          try {
            u = await local.unseal();
            key = combineShares(u, v.bytes);
            await disk.open(key);
            return;
          } catch (cause) {
            // The same unseal would fail again: enrol anew rather than retry it.
            log(`the state's sealed share did not open it (${message(cause)}): it is formatted anew`);
            unsealFailed = true;
          }
        }
      } finally {
        v.bytes.fill(0);
        u?.fill(0);
        key?.fill(0);
      }
      // Renewed on a fresh certificate, since this one got its share.
      try {
        await renew(await fresh());
      } catch (cause) {
        if (!unsealFailed || cause instanceof StateKeyRefused) throw cause;
        throw new UnsealFailed(`the state did not open, nor could it be renewed (${message(cause)})`);
      }
    },
  };
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** A grant's share, decoded. */
function share(grant: StateKeyGrant): { keyId: string; bytes: Buffer } {
  const bytes = Buffer.from(grant.share, "base64");
  if (bytes.length !== SHARE_BYTES || typeof grant.keyId !== "string" || !grant.keyId) {
    bytes.fill(0);
    throw new Error("the server's state key share is malformed");
  }
  return { keyId: grant.keyId, bytes };
}

/** U XOR V, in a new buffer. */
export function combineShares(u: Uint8Array, v: Uint8Array): Buffer {
  if (u.length !== SHARE_BYTES || v.length !== SHARE_BYTES) {
    throw new Error(`the state key's shares must be ${SHARE_BYTES} bytes each`);
  }
  const key = Buffer.alloc(SHARE_BYTES);
  for (let i = 0; i < SHARE_BYTES; i++) key[i] = u[i]! ^ v[i]!;
  return key;
}

/**
 * The server's state-key calls, over HTTPS to its own origin. One try each: the
 * agent tries again later, on a fresh attestation.
 */
export function stateKeyApi(serverUrl: string, machineId: string): StateKeyApi {
  const origin = new URL(serverUrl);
  origin.protocol = origin.protocol === "wss:" ? "https:" : "http:";
  const url = new URL(`/api/machines/${encodeURIComponent(machineId)}/state-key`, origin);

  /** One request on the host certificate; anything but a grant with status `expected` is thrown as the refusal. */
  async function call(method: "POST" | "PUT", expected: number, hostCert: string): Promise<StateKeyGrant> {
    const name = `state key ${method === "POST" ? "release" : "replace"}`;
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${hostCert}` },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    let body: Partial<StateKeyGrant & StateKeyError> = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // No JSON body: the status says enough.
    }
    if (res.status === expected && typeof body.share === "string" && typeof body.keyId === "string") {
      return { keyId: body.keyId, share: body.share };
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new StateKeyRefused(
      name,
      res.status,
      typeof body.error === "string" ? body.error : null,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
    );
  }

  return {
    release: (hostCert) => call("POST", 200, hostCert),
    replace: (hostCert) => call("PUT", 201, hostCert),
  };
}

/**
 * Attestation by the attestation client, until it is part of the agent: a
 * command that attests this boot and prints `{ "hostCert": ..., "expiresAt": ... }`.
 * `exec` should give up after ATTEST_TIMEOUT_MS.
 */
export function commandAttestation(command: string, exec: Run): () => Promise<HostCertificate> {
  return async () => {
    const printed = await exec(command, []);
    let parsed: Partial<HostCertificate> = {};
    try {
      parsed = JSON.parse(printed) as Partial<HostCertificate>;
    } catch {
      // Not JSON: the parser's message would quote the output, certificate and all.
    }
    const { hostCert, expiresAt } = parsed ?? {};
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
  /** U: a systemd-creds credential sealed to the TPM; its key id is kept beside it, in `<localShare>.key-id`. */
  localShare: string;
  /** The attestation client: attests this boot and prints a fresh host certificate. */
  attestCommand: string;
};

/** The device-mapper name the open state gets. */
export const STATE_MAPPER = "swiff-state";

/** The name U's credential is sealed under. */
const CREDENTIAL_NAME = "swiff-state-u";

/**
 * Where systemd puts the booted UKI's .pcrpkey and .pcrsig: the public key of
 * Swiff's PCR 11 policy, and its signatures over this image's PCR 11 values.
 */
export const PCR_POLICY = {
  publicKey: "/run/systemd/tpm2-pcr-public-key.pem",
  signature: "/run/systemd/tpm2-pcr-signature.json",
};

/**
 * U in a systemd-creds credential sealed to the TPM under Swiff's signed PCR 11
 * policy, and its key id in a file beside it.
 */
export function tpmLocalShare(
  credential: string,
  exec: RunBytes = runBytes,
  feed: RunWithInput = runWithInput,
  policy: typeof PCR_POLICY = PCR_POLICY,
): LocalShare {
  const keyIdFile = `${credential}.key-id`;
  return {
    keyId: async () => (await readFile(keyIdFile, "utf8").catch(() => "")).trim() || null,
    unseal: () =>
      exec("systemd-creds", [
        "decrypt",
        `--name=${CREDENTIAL_NAME}`,
        `--tpm2-signature=${policy.signature}`,
        credential,
        "-",
      ]),
    seal: async (keyId, u) => {
      await feed(
        "systemd-creds",
        [
          "encrypt",
          `--name=${CREDENTIAL_NAME}`,
          "--with-key=tpm2-with-public-key",
          `--tpm2-public-key=${policy.publicKey}`,
          "-",
          `${credential}.tmp`,
        ],
        u,
      );
      await rename(`${credential}.tmp`, credential);
      // Written last: the key id says the U beside it is the one for that V.
      await writeFile(`${keyIdFile}.tmp`, `${keyId}\n`, { mode: 0o600 });
      await rename(`${keyIdFile}.tmp`, keyIdFile);
    },
  };
}

/** The state partition on this machine: cryptsetup takes the key on stdin, never from a file or its arguments. */
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
  const openWith = (key: Uint8Array) =>
    feed("cryptsetup", ["open", "--type", "luks2", "--key-file=-", config.device, STATE_MAPPER], key);
  const close = async () => {
    if (await mounted()) await exec("umount", [config.mountpoint]);
    if (await exists(mapped)) await exec("cryptsetup", ["close", STATE_MAPPER]);
  };
  return {
    opened: async () => (await exists(mapped)) && (await mounted()),
    open: async (key) => {
      if (!(await exists(mapped))) await openWith(key);
      if (!(await mounted())) await exec("mount", [mapped, config.mountpoint]);
    },
    format: async (key) => {
      await close();
      await feed(
        "cryptsetup",
        ["luksFormat", "--type", "luks2", "--batch-mode", "--key-file=-", config.device],
        key,
      );
      try {
        await openWith(key);
        await exec("mkfs.ext4", ["-q", mapped]);
        await exec("mount", [mapped, config.mountpoint]);
      } catch (cause) {
        // A mapping left open would let the next try mount a device with no filesystem on it.
        await close().catch(() => {});
        throw cause;
      }
    },
    close,
  };
}

/** Runs a command and resolves with its stdout as bytes. */
export type RunBytes = (command: string, args: string[]) => Promise<Buffer>;

/** Runs a command with `input` on its stdin; resolves once it exits 0. */
export type RunWithInput = (command: string, args: string[], input: Uint8Array) => Promise<void>;

/** `RunBytes` on a child process; its stdout is zeroed once copied out. */
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

/** `RunWithInput` on a child process. */
const runWithInput: RunWithInput = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
    );
    child.stdin.end(input);
  });

/** Whether `path` is there. */
async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
