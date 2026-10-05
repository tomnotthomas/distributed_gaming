// Opening the persistent state with the key split between this PC's TPM and the
// server, against a state-key endpoint kept in memory that answers as
// server/src/state-key.ts does: V only to the latest boot's certificate, once,
// and each refusal by its code. integration.test.ts runs it against the real server.

import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StateKeyError } from "../../../server/src/protocol.ts";
import {
  combineShares,
  commandAttestation,
  linuxStateDisk,
  STATE_MAPPER,
  StateKeyRefused,
  stateKeyApi,
  stateUnlock,
  tpmLocalShare,
  type LocalShare,
  type StateDisk,
} from "./state-key.ts";

const MACHINE = "pc-1";

/** The server's state-key calls for one machine, over real HTTP. */
async function fakeStateKeyServer() {
  const state = {
    share: null as { keyId: string; v: Buffer } | null,
    /** Something else booted since the share was made. */
    withheld: false,
    revoked: false,
    cooldown: false,
    /** Seconds to answer rate-limited with, while set. */
    rateLimited: null as number | null,
    /** Answers to give as 503 before working again. */
    failing: 0,
    /** Host certificates attestation has issued, in order; only the last is the latest boot's. */
    issued: [] as string[],
    used: new Set<string>(),
    calls: [] as string[],
    shares: 0,
  };
  const server: Server = createServer((req, res) => {
    const cert = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    state.calls.push(`${req.method} ${cert}`);
    const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      res.end(JSON.stringify(body));
    };
    const refuse = (status: number, error: StateKeyError["error"], headers = {}) =>
      answer(status, { error }, headers);
    if (req.url !== `/api/machines/${MACHINE}/state-key`) return answer(404, {});
    if (state.failing > 0) {
      state.failing--;
      return refuse(503, "not-configured");
    }
    if (!state.issued.includes(cert)) return refuse(401, "bad-host-cert");
    if (state.rateLimited !== null)
      return refuse(429, "rate-limited", { "retry-after": String(state.rateLimited) });
    if (state.used.has(cert) || cert !== state.issued.at(-1)) return refuse(401, "stale-host-cert");
    if (state.revoked) return refuse(403, "revoked");
    if (state.cooldown) return refuse(403, "firmware-cooldown");
    if (req.method === "POST") {
      if (!state.share) return refuse(404, "no-state-key");
      if (state.withheld) return refuse(409, "continuity-gap");
      state.used.add(cert);
      return answer(200, { keyId: state.share.keyId, share: state.share.v.toString("base64") });
    }
    if (req.method === "PUT") {
      state.share = { keyId: `key-${++state.shares}`, v: randomBytes(32) };
      state.withheld = false;
      state.used.add(cert);
      return answer(201, { keyId: state.share.keyId, share: state.share.v.toString("base64") });
    }
    answer(405, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return {
    state,
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    attest: async () => {
      const hostCert = `cert-${state.issued.length + 1}`;
      state.issued.push(hostCert);
      return { hostCert, expiresAt: 0 };
    },
  };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

/** One PC: its TPM-sealed U and the state partition, kept across its boots. */
function fakeMachine() {
  const pc = {
    /** U as sealed, and the key id written beside it. */
    sealed: null as Buffer | null,
    keyId: null as string | null,
    /** The key the partition was last formatted for; what it holds. */
    luksKey: null as Buffer | null,
    contents: [] as string[],
    open: false,
    /** Every buffer the PC was handed: each must be zeroed once the try is over. */
    handed: [] as Uint8Array[],
    /** A seal that fails: a renewal cut short after it formatted. */
    sealFails: false,
  };
  const local: LocalShare = {
    keyId: async () => pc.keyId,
    unseal: async () => {
      if (!pc.sealed) throw new Error("no credential");
      const u = Buffer.from(pc.sealed);
      pc.handed.push(u);
      return u;
    },
    seal: async (keyId, u) => {
      pc.handed.push(u);
      if (pc.sealFails) throw new Error("systemd-creds exited with 1");
      pc.sealed = Buffer.from(u);
      pc.keyId = keyId;
    },
  };
  const disk: StateDisk = {
    opened: async () => pc.open,
    open: async (key) => {
      pc.handed.push(key);
      if (!pc.luksKey || !pc.luksKey.equals(key)) throw new Error("cryptsetup exited with 2");
      pc.open = true;
    },
    format: async (key) => {
      pc.handed.push(key);
      pc.luksKey = Buffer.from(key);
      pc.contents = [];
      pc.open = true;
    },
  };
  return {
    pc,
    /** A new boot: the partition closed, the TPM and the disk as they were. */
    reboot: () => void (pc.open = false),
    unlock: (server: Awaited<ReturnType<typeof fakeStateKeyServer>>, attest = server.attest) =>
      stateUnlock({ attest, api: stateKeyApi(server.url, MACHINE), local, disk }).unlock(),
    wiped: () => pc.handed.every((buffer) => buffer.every((byte) => byte === 0)),
  };
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (cause: unknown) => cause as StateKeyRefused,
  );

describe("opening the persistent state", () => {
  it("makes a state key on the first boot, then opens the same state with U XOR V on the next", async () => {
    const server = await fakeStateKeyServer();
    const m = fakeMachine();
    await m.unlock(server);
    // No share yet: the PUT goes on the same certificate, and the partition is formatted for U XOR V.
    expect(server.state.calls).toEqual(["POST cert-1", "PUT cert-1"]);
    expect(m.pc.keyId).toBe("key-1");
    expect(m.pc.luksKey).toEqual(combineShares(m.pc.sealed!, server.state.share!.v));
    m.pc.contents.push("verified-file table");

    m.reboot();
    await m.unlock(server);
    expect(server.state.calls.slice(2)).toEqual(["POST cert-2"]);
    expect(m.pc.open).toBe(true);
    expect(m.pc.contents).toEqual(["verified-file table"]);
    expect(m.wiped()).toBe(true);
  });

  it("asks for nothing when this boot opened the state already", async () => {
    const server = await fakeStateKeyServer();
    const m = fakeMachine();
    await m.unlock(server);
    await m.unlock(server);
    expect(server.state.issued).toHaveLength(1);
  });

  it("formats the state anew on a continuity gap, and the old share is never used again", async () => {
    const server = await fakeStateKeyServer();
    const m = fakeMachine();
    await m.unlock(server);
    m.pc.contents.push("planted by whatever booted in between");
    m.reboot();
    server.state.withheld = true;
    await m.unlock(server);
    expect(server.state.calls.slice(2)).toEqual(["POST cert-2", "PUT cert-2"]);
    expect(m.pc.keyId).toBe("key-2");
    expect(m.pc.contents).toEqual([]);
    expect(m.pc.luksKey).toEqual(combineShares(m.pc.sealed!, server.state.share!.v));
    expect(m.wiped()).toBe(true);
  });

  it("renews, on a fresh certificate, when a renewal was cut short before U was sealed", async () => {
    const server = await fakeStateKeyServer();
    const m = fakeMachine();
    await m.unlock(server);
    m.reboot();
    server.state.withheld = true;
    m.pc.sealFails = true;
    await expect(m.unlock(server)).rejects.toThrow(/systemd-creds/);
    // The server holds key-2 now; the PC still has key-1's U beside a partition formatted for key-2.
    expect(m.pc.keyId).toBe("key-1");
    m.reboot();
    m.pc.sealFails = false;
    await m.unlock(server);
    expect(server.state.calls.slice(4)).toEqual(["POST cert-3", "PUT cert-4"]);
    expect(m.pc.keyId).toBe("key-3");
    expect(m.pc.open).toBe(true);
    m.reboot();
    await m.unlock(server);
    expect(m.pc.open).toBe(true);
    expect(m.wiped()).toBe(true);
  });

  it("attests again at once when its certificate is stale, and opens on the fresh one", async () => {
    const server = await fakeStateKeyServer();
    const m = fakeMachine();
    await m.unlock(server);
    m.reboot();
    // Attestation hands out a certificate, then another supersedes it before it is used.
    let tries = 0;
    await m.unlock(server, async () => {
      if (tries++) return server.attest();
      const first = await server.attest();
      await server.attest();
      return first;
    });
    expect(server.state.calls.slice(2)).toEqual(["POST cert-2", "POST cert-4"]);
    expect(m.pc.open).toBe(true);
  });

  it("attests again at once when its certificate was used already", async () => {
    const server = await fakeStateKeyServer();
    const m = fakeMachine();
    await m.unlock(server);
    m.reboot();
    let tries = 0;
    await m.unlock(server, async () => (tries++ ? server.attest() : { hostCert: "cert-1", expiresAt: 0 }));
    expect(server.state.calls.slice(2)).toEqual(["POST cert-1", "POST cert-2"]);
    expect(m.pc.open).toBe(true);
  });

  it("attests again only once: a second stale certificate fails the try", async () => {
    const server = await fakeStateKeyServer();
    const m = fakeMachine();
    const stale = async () => {
      const first = await server.attest();
      await server.attest();
      return first;
    };
    const refused = await refusal(m.unlock(server, stale));
    expect(refused.code).toBe("stale-host-cert");
    expect(server.state.calls).toHaveLength(2);
    expect(m.pc.open).toBe(false);
  });

  it("wipes V when U cannot be unsealed", async () => {
    const server = await fakeStateKeyServer();
    const m = fakeMachine();
    await m.unlock(server);
    m.reboot();
    m.pc.sealed = null;
    await expect(m.unlock(server)).rejects.toThrow(/no credential/);
    expect(m.pc.open).toBe(false);
    expect(m.wiped()).toBe(true);
  });
});

describe("the server keeping V back", () => {
  for (const [code, status, set] of [
    ["revoked", 403, (s) => (s.revoked = true)],
    ["firmware-cooldown", 403, (s) => (s.cooldown = true)],
    ["not-configured", 503, (s) => (s.failing = 1)],
  ] as const satisfies readonly (readonly [string, number, (s: FakeState) => void])[]) {
    it(`leaves the state shut, and the partition as it was, when refused as ${code}`, async () => {
      const server = await fakeStateKeyServer();
      const m = fakeMachine();
      await m.unlock(server);
      m.pc.contents.push("state");
      m.reboot();
      set(server.state);
      const refused = await refusal(m.unlock(server));
      expect(refused).toBeInstanceOf(StateKeyRefused);
      expect([refused.status, refused.code]).toEqual([status, code]);
      expect(m.pc.open).toBe(false);
      expect(m.pc.contents).toEqual(["state"]);
      // Not the certificate's fault: no second attestation for it.
      expect(server.state.issued).toHaveLength(2);
    });
  }

  it("carries the server's retry-after when rate-limited", async () => {
    const server = await fakeStateKeyServer();
    server.state.rateLimited = 42;
    const refused = await refusal(fakeMachine().unlock(server));
    expect([refused.code, refused.retryAfterMs]).toEqual(["rate-limited", 42_000]);
  });

  it("takes a refusal for a certificate it does not know as bad-host-cert", async () => {
    const server = await fakeStateKeyServer();
    const refused = await refusal(
      fakeMachine().unlock(server, async () => ({ hostCert: "forged", expiresAt: 0 })),
    );
    expect([refused.status, refused.code]).toEqual([401, "bad-host-cert"]);
  });

  it("fails on the network without opening anything", async () => {
    const server = await fakeStateKeyServer();
    await new Promise((resolve) => servers.pop()!.close(resolve));
    const m = fakeMachine();
    await expect(m.unlock(server)).rejects.toThrow();
    expect(m.pc.open).toBe(false);
  });
});

type FakeState = Awaited<ReturnType<typeof fakeStateKeyServer>>["state"];

describe("combineShares", () => {
  it("is U XOR V", () => {
    expect(combineShares(Buffer.alloc(32, 0b1010), Buffer.alloc(32, 0b0110))).toEqual(
      Buffer.alloc(32, 0b1100),
    );
  });

  it("refuses shares that are not 32 bytes", () => {
    expect(() => combineShares(Buffer.alloc(32), Buffer.alloc(31))).toThrow(/32 bytes/);
  });
});

describe("the machine's side", () => {
  /** A partition behind fake cryptsetup and mount, under a mapper directory of its own. */
  async function disk(mappedAlready = false) {
    const mapper = await mkdtemp(join(tmpdir(), "swiff-mapper-"));
    if (mappedAlready) await writeFile(join(mapper, STATE_MAPPER), "");
    const runs: string[][] = [];
    const fed: { args: string[]; input: Buffer }[] = [];
    let mounted = false;
    const state = linuxStateDisk(
      { device: "/dev/disk/by-partlabel/swiff-state", mountpoint: "/var/lib/swiff/state" },
      async (command, args) => {
        runs.push([command, ...args]);
        if (command === "mountpoint" && !mounted) throw new Error("not a mountpoint");
        if (command === "mount") mounted = true;
        return "";
      },
      async (command, args, input) => {
        fed.push({ args: [command, ...args], input: Buffer.from(input) });
        if (args[0] === "open") await writeFile(join(mapper, STATE_MAPPER), "");
      },
      mapper,
    );
    return { state, runs, fed, mapped: join(mapper, STATE_MAPPER) };
  }

  it("opens the partition with the key on cryptsetup's stdin, never on its command line, and mounts it", async () => {
    const d = await disk();
    expect(await d.state.opened()).toBe(false);
    const key = Buffer.alloc(32, 7);
    await d.state.open(key);
    expect(d.fed).toEqual([
      {
        args: [
          "cryptsetup",
          "open",
          "--type",
          "luks2",
          "--key-file=-",
          "/dev/disk/by-partlabel/swiff-state",
          STATE_MAPPER,
        ],
        input: key,
      },
    ]);
    expect(d.runs).toContainEqual(["mount", d.mapped, "/var/lib/swiff/state"]);
    expect(await d.state.opened()).toBe(true);
  });

  it("mounts a partition this boot opened already without asking cryptsetup again", async () => {
    const d = await disk(true);
    await d.state.open(Buffer.alloc(32));
    expect(d.fed).toEqual([]);
    expect(d.runs.at(-1)).toEqual(["mount", d.mapped, "/var/lib/swiff/state"]);
  });

  it("formats the partition with the key on stdin, then opens, makes a filesystem and mounts it", async () => {
    const d = await disk(true);
    const key = Buffer.alloc(32, 9);
    await d.state.format(key);
    expect(d.runs).toContainEqual(["cryptsetup", "close", STATE_MAPPER]);
    expect(d.fed.map((f) => f.args.slice(0, 2))).toEqual([
      ["cryptsetup", "luksFormat"],
      ["cryptsetup", "open"],
    ]);
    expect(d.fed.every((f) => f.input.equals(key) && f.args.includes("--key-file=-"))).toBe(true);
    expect(d.runs.slice(-2)).toEqual([
      ["mkfs.ext4", "-q", d.mapped],
      ["mount", d.mapped, "/var/lib/swiff/state"],
    ]);
  });

  it("seals U with systemd-creds and writes its key id after it, and unseals it again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiff-u-"));
    const credential = join(dir, "state-u.cred");
    const calls: string[][] = [];
    const local = tpmLocalShare(
      credential,
      async (command, args) => {
        calls.push([command, ...args]);
        return readFile(credential);
      },
      async (command, args, input) => {
        calls.push([command, ...args]);
        // The key id is not written yet while U is being sealed.
        expect(await local.keyId()).toBeNull();
        await writeFile(args.at(-1)!, input);
      },
    );
    expect(await local.keyId()).toBeNull();
    await local.seal("key-1", Buffer.alloc(32, 3));
    expect(await local.keyId()).toBe("key-1");
    expect(await local.unseal()).toEqual(Buffer.alloc(32, 3));
    expect(calls).toEqual([
      ["systemd-creds", "encrypt", "--name=swiff-state-u", "--with-key=tpm2", "-", `${credential}.tmp`],
      ["systemd-creds", "decrypt", "--name=swiff-state-u", credential, "-"],
    ]);
  });

  it("takes the host certificate the attestation client prints, and refuses anything else", async () => {
    const attest = (stdout: string) => commandAttestation("/usr/libexec/swiff/attest", async () => stdout);
    expect(await attest('{"hostCert":"c","expiresAt":5}')()).toEqual({ hostCert: "c", expiresAt: 5 });
    await expect(attest('{"hostCert":""}')()).rejects.toThrow(/no host certificate/);
  });
});
