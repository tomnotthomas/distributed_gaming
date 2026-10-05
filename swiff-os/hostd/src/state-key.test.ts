// Opening the persistent state with the key split between this PC's TPM and the
// server, against a state-key endpoint kept in memory: it releases V only to
// the latest host certificate, once, and refuses as the server does otherwise.

import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  combineShares,
  commandAttestation,
  linuxStateDisk,
  STATE_KEY_REFUSALS,
  STATE_MAPPER,
  StateKeyRefused,
  stateKeyRelease,
  stateUnlock,
  tpmLocalShare,
  type StateDisk,
  type StateKeyRefusal,
} from "./state-key.ts";

const MACHINE = "pc-1";

/** The server's state-key release for one machine, over real HTTP. */
async function fakeStateKeyServer() {
  const v = randomBytes(32);
  const state = {
    /** Host certificates attestation has issued, in order; only the last is fresh. */
    issued: [] as string[],
    used: new Set<string>(),
    /** A refusal the server gives every request, whatever the certificate. */
    refuse: null as Exclude<StateKeyRefusal, "stale" | "replayed"> | null,
    /** Answers to give as 503 before working again. */
    failing: 0,
    requests: [] as { path: string; authorization: string | undefined }[],
  };
  const server: Server = createServer((req, res) => {
    state.requests.push({ path: req.url ?? "", authorization: req.headers.authorization });
    const answer = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== `/api/machines/${MACHINE}/state-key`) return answer(404, {});
    if (state.failing > 0) {
      state.failing--;
      return answer(503, { error: "not-configured" });
    }
    const cert = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (!state.issued.includes(cert)) return answer(401, { error: "bad-host-cert" });
    if (state.refuse) return answer(403, { error: "state-key-refused", reason: state.refuse });
    if (state.used.has(cert)) return answer(403, { error: "state-key-refused", reason: "replayed" });
    if (cert !== state.issued.at(-1)) return answer(403, { error: "state-key-refused", reason: "stale" });
    state.used.add(cert);
    answer(200, { share: v.toString("base64") });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    v,
    state,
    url,
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

/** A state partition that remembers the key it was opened with (a copy) and the buffer it was handed. */
function fakeDisk(open = false) {
  const disk = {
    open,
    keys: [] as Buffer[],
    handed: [] as Uint8Array[],
  };
  const stateDisk: StateDisk = {
    opened: async () => disk.open,
    open: async (key) => {
      disk.handed.push(key);
      disk.keys.push(Buffer.from(key));
      disk.open = true;
    },
  };
  return { disk, stateDisk };
}

function setup(
  server: Awaited<ReturnType<typeof fakeStateKeyServer>>,
  { opened = false, attest = server.attest } = {},
) {
  const u = randomBytes(32);
  const unsealed: Buffer[] = [];
  const { disk, stateDisk } = fakeDisk(opened);
  const release = stateKeyRelease(server.url, MACHINE);
  const released: Buffer[] = [];
  const unlock = stateUnlock({
    attest,
    releaseShare: async (cert) => {
      const v = await release(cert);
      released.push(v);
      return v;
    },
    unsealLocalShare: async () => {
      const copy = Buffer.from(u);
      unsealed.push(copy);
      return copy;
    },
    disk: stateDisk,
  });
  return { u, unsealed, released, disk, unlock };
}

describe("opening the persistent state", () => {
  it("opens it with U XOR V, V released to a fresh certificate, and wipes every share and the key", async () => {
    const server = await fakeStateKeyServer();
    const s = setup(server);
    await s.unlock.unlock();
    expect(s.disk.keys).toEqual([combineShares(s.u, server.v)]);
    expect(server.state.requests).toEqual([
      { path: `/api/machines/${MACHINE}/state-key`, authorization: "Bearer cert-1" },
    ]);
    // Nothing of the key is left in the buffers the agent held.
    for (const buffer of [...s.disk.handed, ...s.released, ...s.unsealed]) {
      expect(buffer.every((byte) => byte === 0)).toBe(true);
    }
  });

  it("asks for nothing when this boot opened the state already", async () => {
    const server = await fakeStateKeyServer();
    const s = setup(server, { opened: true });
    await s.unlock.unlock();
    expect(server.state.issued).toEqual([]);
    expect(server.state.requests).toEqual([]);
  });

  it("attests again for every try: a certificate is never sent twice", async () => {
    const server = await fakeStateKeyServer();
    server.state.failing = 1;
    const s = setup(server);
    await expect(s.unlock.unlock()).rejects.toThrow(/503/);
    await s.unlock.unlock();
    expect(server.state.requests.map((r) => r.authorization)).toEqual(["Bearer cert-1", "Bearer cert-2"]);
    expect(s.disk.open).toBe(true);
  });

  it("wipes V when U cannot be unsealed", async () => {
    const server = await fakeStateKeyServer();
    const { disk, stateDisk } = fakeDisk();
    const v: Buffer[] = [];
    const unlock = stateUnlock({
      attest: server.attest,
      releaseShare: async (cert) => {
        const share = await stateKeyRelease(server.url, MACHINE)(cert);
        v.push(share);
        return share;
      },
      unsealLocalShare: async () => {
        throw new Error("systemd-creds exited with 1");
      },
      disk: stateDisk,
    });
    await expect(unlock.unlock()).rejects.toThrow(/systemd-creds/);
    expect(v).toHaveLength(1);
    expect(v[0]!.every((byte) => byte === 0)).toBe(true);
    expect(disk.open).toBe(false);
  });
});

describe("the server keeping V back", () => {
  it("covers every refusal the contract names", () => {
    expect([...STATE_KEY_REFUSALS].sort()).toEqual(["cooldown", "gap", "replayed", "revoked", "stale"]);
  });

  for (const reason of ["gap", "cooldown", "revoked"] as const) {
    it(`leaves the state shut when refused as ${reason}, and says why`, async () => {
      const server = await fakeStateKeyServer();
      server.state.refuse = reason;
      const s = setup(server);
      const refused = await s.unlock.unlock().catch((cause: unknown) => cause);
      expect(refused).toBeInstanceOf(StateKeyRefused);
      expect((refused as StateKeyRefused).reason).toBe(reason);
      expect(s.disk.keys).toEqual([]);
      expect(s.unsealed).toEqual([]);
      // Not a certificate's fault: no second attestation for it.
      expect(server.state.issued).toHaveLength(1);
    });
  }

  it("attests again at once when its certificate is stale, and opens on the fresh one", async () => {
    const server = await fakeStateKeyServer();
    // Attestation hands out a certificate, then another one supersedes it before it is used.
    const attest = async () => {
      const first = await server.attest();
      await server.attest();
      return first;
    };
    let tries = 0;
    const s = setup(server, { attest: async () => (tries++ ? server.attest() : attest()) });
    await s.unlock.unlock();
    expect(server.state.requests.map((r) => r.authorization)).toEqual(["Bearer cert-1", "Bearer cert-3"]);
    expect(s.disk.keys).toEqual([combineShares(s.u, server.v)]);
  });

  it("attests again at once when its certificate was used already, and opens on the fresh one", async () => {
    const server = await fakeStateKeyServer();
    const { hostCert } = await server.attest();
    server.state.used.add(hostCert);
    let tries = 0;
    const s = setup(server, { attest: async () => (tries++ ? server.attest() : { hostCert, expiresAt: 0 }) });
    await s.unlock.unlock();
    expect(server.state.requests.map((r) => r.authorization)).toEqual(["Bearer cert-1", "Bearer cert-2"]);
    expect(s.disk.open).toBe(true);
  });

  it("attests again only once: a second stale certificate is the try's refusal", async () => {
    const server = await fakeStateKeyServer();
    const s = setup(server, {
      attest: async () => {
        const first = await server.attest();
        await server.attest();
        return first;
      },
    });
    const refused = await s.unlock.unlock().catch((cause: unknown) => cause);
    expect((refused as StateKeyRefused).reason).toBe("stale");
    expect(server.state.requests).toHaveLength(2);
    expect(s.disk.open).toBe(false);
  });

  it("takes a refusal with no reason it knows as unnamed", async () => {
    const server = await fakeStateKeyServer();
    const s = setup(server, { attest: async () => ({ hostCert: "forged", expiresAt: 0 }) });
    const refused = await s.unlock.unlock().catch((cause: unknown) => cause);
    expect(refused).toBeInstanceOf(StateKeyRefused);
    expect((refused as StateKeyRefused).reason).toBeNull();
    expect((refused as StateKeyRefused).status).toBe(401);
  });

  it("fails on the network without opening anything", async () => {
    const server = await fakeStateKeyServer();
    await new Promise((resolve) => servers.pop()!.close(resolve));
    const s = setup(server);
    await expect(s.unlock.unlock()).rejects.toThrow();
    expect(s.disk.open).toBe(false);
  });
});

describe("combineShares", () => {
  it("is U XOR V", () => {
    const u = Buffer.alloc(32, 0b1010);
    const v = Buffer.alloc(32, 0b0110);
    expect(combineShares(u, v)).toEqual(Buffer.alloc(32, 0b1100));
  });

  it("refuses shares of different or too short a length", () => {
    expect(() => combineShares(Buffer.alloc(32), Buffer.alloc(31))).toThrow(/length/);
    expect(() => combineShares(Buffer.alloc(16), Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});

describe("the machine's side", () => {
  it("opens the partition with the key on cryptsetup's stdin, never on its command line, and mounts it", async () => {
    const mapper = await mkdtemp(join(tmpdir(), "swiff-mapper-"));
    const runs: string[][] = [];
    const fed: { args: string[]; input: Buffer }[] = [];
    let mounted = false;
    const disk = linuxStateDisk(
      { device: "/dev/disk/by-partlabel/swiff-state", mountpoint: "/var/lib/swiff/state" },
      async (command, args) => {
        runs.push([command, ...args]);
        if (command === "mountpoint" && !mounted) throw new Error("not a mountpoint");
        if (command === "mount") mounted = true;
        return "";
      },
      async (command, args, input) => {
        fed.push({ args: [command, ...args], input: Buffer.from(input) });
        await writeFile(join(mapper, STATE_MAPPER), "");
      },
      mapper,
    );
    expect(await disk.opened()).toBe(false);
    const key = Buffer.alloc(32, 7);
    await disk.open(key);
    expect(fed).toEqual([
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
    expect(runs).toContainEqual(["mount", join(mapper, STATE_MAPPER), "/var/lib/swiff/state"]);
    expect(await disk.opened()).toBe(true);
  });

  it("mounts a partition this boot opened already without asking cryptsetup again", async () => {
    const mapper = await mkdtemp(join(tmpdir(), "swiff-mapper-"));
    await writeFile(join(mapper, STATE_MAPPER), "");
    const runs: string[][] = [];
    const disk = linuxStateDisk(
      { device: "/dev/sda9", mountpoint: "/mnt/state" },
      async (command, args) => {
        runs.push([command, ...args]);
        if (command === "mountpoint") throw new Error("not a mountpoint");
        return "";
      },
      async () => {
        throw new Error("cryptsetup must not run");
      },
      mapper,
    );
    expect(await disk.opened()).toBe(false);
    await disk.open(Buffer.alloc(32));
    expect(runs.at(-1)).toEqual(["mount", join(mapper, STATE_MAPPER), "/mnt/state"]);
  });

  it("unseals U with systemd-creds from its credential", async () => {
    const calls: string[][] = [];
    const u = await tpmLocalShare("/var/lib/swiff/state-u.cred", async (command, args) => {
      calls.push([command, ...args]);
      return Buffer.alloc(32, 1);
    })();
    expect(calls).toEqual([
      ["systemd-creds", "decrypt", "--name=swiff-state-u", "/var/lib/swiff/state-u.cred", "-"],
    ]);
    expect(u).toEqual(Buffer.alloc(32, 1));
  });

  it("takes the host certificate the attestation client prints, and refuses anything else", async () => {
    const attest = (stdout: string) => commandAttestation("/usr/libexec/swiff/attest", async () => stdout);
    expect(await attest('{"hostCert":"c","expiresAt":5}')()).toEqual({ hostCert: "c", expiresAt: 5 });
    await expect(attest('{"hostCert":""}')()).rejects.toThrow(/no host certificate/);
  });
});
