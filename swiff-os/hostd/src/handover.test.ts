// The hand-over seal, Lanterel OS's side: the key, the policies and the
// signature it picks, pinned to values worked out apart from this code; then
// the whole hand-over on a software TPM, sealed by the owner's app's own code
// (desktop/tpm-seal.cjs, desktop/provision.cjs) and opened by hostd's.
//
// The software TPM's part is skipped where swtpm is not installed (apt install swtpm).

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authorizedPolicy,
  parseBody,
  pcrPolicy,
  signatureFor,
  signingKey,
  tpmOpen,
  unsealBody,
  type PcrPolicyFiles,
} from "./handover.ts";
import { parseRecord, ProvisionError, type Provisioning } from "./provision.ts";
import { tcpTransport, Tpm, type Transport } from "./tpm.ts";

const require = createRequire(import.meta.url);
type Sealed = { public: Buffer; private: Buffer };
/** The owner's app's own seal and record. */
const seal = require("../../../desktop/tpm-seal.cjs") as {
  sealKey(transport: Transport, policy: Buffer, key: Buffer): Promise<Sealed>;
  sealPolicy(key: string): Buffer;
};
const { provisionRecord } = require("../../../desktop/provision.cjs") as {
  provisionRecord(p: Provisioning, seal: (key: Buffer) => Promise<Sealed>): Promise<Buffer>;
};
/** Windows' storage root key, made as Windows makes it. */
const { makeSrk } = require("../../../desktop/vm/swtpm.cjs") as {
  makeSrk(transport: Transport): Promise<void>;
};

/** The contract's golden key, and its name and authPolicy as Python computed them. */
const GOLDEN_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuvd0rRC4ZFTuqGUvuwVw
qJ9AWGd0a4yYLc5eccopNbGTM3d2NaLVUwN/cbqXKCJNf8n1eerStT+zV95b/96V
6Mya30OigfUFJ7XneW12fJXvi1yl9YPeTdzR0QlGzSBIiY0BQPzUjdGymAwybxJo
xZ0k8D63DgFjPfAFG69wMzxurryzQo/MR2e4hhbJCO3OtmfVOY7j9mdLQ9+rOr5i
ST/FCBrNc+soy750lNH/ei8i7ExGOuTMnxTm8WcUi/09iDKAxemL5nFTQVGGlKKO
8KWeb/jQ7B4/3AUOOmseav5QjFVQi4bHHFuLeqBjQpB2hXhWsSXd/lP2KtQt4tgW
KwIDAQAB
-----END PUBLIC KEY-----
`;
const GOLDEN_NAME = "000bb0609f4f2dcf176400b8725546a2aa1239e0a5116a97003cbb6930d2cb974afb";
const GOLDEN_POLICY = "e67aa50e13cec368618678569ae8d48b604d1ec2551c608c2078910390ac66ca";

const GIVEN: Provisioning = {
  serverUrl: "wss://lanterel.example",
  machineId: "gaming-pc-1",
  machineKey: "k3y-0f-the-owners-machine-1234567890",
};

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();

/** A tpm2-pcr-signature.json as systemd-measure writes it: `key` signing the PCR 11 policy of each of `values`. */
function signatures(key: KeyObject, values: Buffer[]): string {
  return JSON.stringify({
    sha1: [],
    sha256: values.map((value) => {
      const pol = pcrPolicy(value);
      return {
        pcrs: [11],
        pkfp: sha256(createPublicKey(key).export({ format: "der", type: "spki" })).toString("hex"),
        pol: pol.toString("hex"),
        sig: sign("sha256", pol, key).toString("base64"),
      };
    }),
  });
}

describe("the hand-over seal", () => {
  it("names Lanterel's PCR signing key and the policy it authorizes as the owner's app does", () => {
    const key = signingKey(GOLDEN_PEM);
    expect(key.name.toString("hex")).toBe(GOLDEN_NAME);
    expect(authorizedPolicy(key.name).toString("hex")).toBe(GOLDEN_POLICY);
    expect(seal.sealPolicy(GOLDEN_PEM).toString("hex")).toBe(GOLDEN_POLICY);
  });

  it("refuses a PCR signing key that is not RSA", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(() => signingKey(publicKey.export({ format: "pem", type: "spki" }).toString())).toThrow(
      ProvisionError,
    );
  });

  it("computes the PolicyPCR digest Lanterel signs for a PCR 11 value", () => {
    const pcr11 = Buffer.from("d15b0e8e244e65c40f024e95773f2347ce4ef3ffe6b597c9a14b50bbab6df319", "hex");
    expect(pcrPolicy(pcr11).toString("hex")).toBe(
      "7c8486f61cc1d88a28d6ab87850bee07c467ce6311340219e43a7a6e6521e543",
    );
  });

  it("picks the signature over this boot's PCR 11 policy, and none for a boot Lanterel did not sign", () => {
    const pol = (n: number) => Buffer.alloc(32, n);
    const json = JSON.stringify({
      sha1: [{ pcrs: [11], pol: pol(1).toString("hex"), sig: "c2hhMQ==" }],
      sha256: [
        { pcrs: [11], pol: pol(2).toString("hex"), sig: "ZW50ZXItaW5pdHJk" },
        { pcrs: [7, 11], pol: pol(3).toString("hex"), sig: "c2VjdXJlLWJvb3Q=" },
        { pcrs: [11], pol: pol(3).toString("hex").toUpperCase(), sig: "c3lzaW5pdA==" },
      ],
    });
    expect(signatureFor(json, pol(2)).toString()).toBe("enter-initrd");
    expect(signatureFor(json, pol(3)).toString()).toBe("sysinit");
    expect(() => signatureFor(json, pol(1))).toThrow(/not one Lanterel signed/);
    expect(() => signatureFor(json, pol(4))).toThrow(ProvisionError);
    expect(() => signatureFor("not json", pol(2))).toThrow(ProvisionError);
  });

  it("refuses a body cut short", () => {
    const tpm2b = (n: number) => Buffer.concat([Buffer.from([0, n]), Buffer.alloc(n, n)]);
    const body = Buffer.concat([
      tpm2b(46),
      tpm2b(80),
      Buffer.alloc(12, 1),
      Buffer.alloc(16, 2),
      Buffer.from("{}"),
    ]);
    const parsed = parseBody(body);
    expect([parsed.public.length, parsed.private.length, parsed.nonce.length, parsed.tag.length]).toEqual([
      46, 80, 12, 16,
    ]);
    expect(parsed.ciphertext.toString()).toBe("{}");
    for (let length = 0; length < body.length - 1; length++) {
      expect(() => parseBody(body.subarray(0, length))).toThrow(ProvisionError);
    }
    expect(() => parseBody(Buffer.concat([tpm2b(0), tpm2b(80), Buffer.alloc(40)]))).toThrow(/damaged/);
  });
});

const has = (tool: string) => {
  try {
    execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const SWTPM = has("swtpm");

/** Two TPMs' TCP ports, each with its control port after it; apart from attest.test.ts's. */
const TPM_PORT = 25000 + Math.floor(Math.random() * 400) * 4;

describe.skipIf(!SWTPM)("the hand-over on a software TPM", () => {
  let work: string;
  const spawned: ChildProcess[] = [];
  const transports: Transport[] = [];
  let tpm: Tpm;
  let files: PcrPolicyFiles;
  let record: Buffer;
  /** The PCR 11 values of this boot's phases, as the UKI's .pcrsig signs them. */
  const phases: Buffer[] = [];
  const lanterel = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = lanterel.publicKey.export({ format: "pem", type: "spki" }).toString();

  /** A fresh software TPM, its storage root key made as Windows makes it. */
  async function softwareTpm(name: string, port: number): Promise<Tpm> {
    const state = join(work, name);
    mkdirSync(state);
    spawned.push(
      spawn(
        "swtpm",
        [
          "socket",
          "--tpm2",
          "--tpmstate",
          `dir=${state}`,
          "--server",
          `type=tcp,port=${port},bindaddr=127.0.0.1`,
          "--ctrl",
          `type=tcp,port=${port + 1},bindaddr=127.0.0.1`,
          "--flags",
          "not-need-init,startup-clear",
        ],
        { stdio: "ignore" },
      ),
    );
    let transport: Transport | undefined;
    for (let tries = 0; !transport; tries++) {
      try {
        transport = await tcpTransport("127.0.0.1", port);
      } catch (error) {
        if (tries > 50) throw error;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    transports.push(transport);
    await makeSrk(transport);
    return new Tpm(transport);
  }

  /** systemd-stub measuring the UKI into PCR 11, then systemd-pcrphase up to sysinit. */
  async function boot(on: Tpm): Promise<Buffer[]> {
    for (const section of [".linux", ".osrel", ".cmdline", ".initrd", ".pcrpkey"]) {
      await on.extend(11, sha256(section));
    }
    const values: Buffer[] = [];
    for (const phase of ["enter-initrd", "leave-initrd", "sysinit"]) {
      await on.extend(11, sha256(phase));
      values.push(Buffer.from((await on.readPcrs([11]))[11]!, "hex"));
    }
    return values;
  }

  /** The transient objects and sessions loaded in `on`. */
  async function held(on: Tpm): Promise<number[]> {
    const handles: number[] = [];
    for (const first of [0x80000000, 0x02000000, 0x03000000]) {
      const r = await on.run(0x17a, {
        params: Buffer.from([0, 0, 0, 1, first >>> 24, 0, 0, 0, 0, 0, 0, 64]),
      }); // TPM2_GetCapability(TPM_CAP_HANDLES)
      r.bytes(1);
      r.u32();
      for (let n = r.u32(); n > 0; n--) handles.push(r.u32());
    }
    return handles;
  }

  const open = (sealed: Buffer, policy: PcrPolicyFiles = files, on: Tpm = tpm) =>
    unsealBody(on, parseBody(parseRecord(sealed)!), policy);

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "swiff-handover-test-"));
    tpm = await softwareTpm("this-pc", TPM_PORT);
    phases.push(...(await boot(tpm)));
    files = { publicKeyPem: pem, signatureJson: signatures(lanterel.privateKey, phases) };
    record = await provisionRecord(GIVEN, (key) => seal.sealKey(transports[0]!, seal.sealPolicy(pem), key));
    // Windows' RSA SRK is made in software here: seconds on a loaded machine.
  }, 120_000);

  afterEach(async () => {
    expect(await held(tpm)).toEqual([]);
  });

  afterAll(() => {
    for (const transport of transports) transport.close();
    for (const child of spawned) child.kill();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it("opens what the owner's app sealed, on this PC in a boot Lanterel signed, and yields its exact payload", async () => {
    expect(record.includes(GIVEN.machineKey)).toBe(false);
    writeFileSync(join(work, "pcr-public-key.pem"), files.publicKeyPem);
    writeFileSync(join(work, "pcr-signature.json"), files.signatureJson);
    const shared = transports[0]!;
    const openOnThisPc = tpmOpen(
      { publicKey: join(work, "pcr-public-key.pem"), signature: join(work, "pcr-signature.json") },
      () => ({ send: (command) => shared.send(command), close: () => {} }),
    );
    const payload = await openOnThisPc(parseRecord(record)!);
    expect(payload.toString()).toBe(JSON.stringify(GIVEN));
  });

  it("refuses PCR policies Lanterel's key did not sign", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await expect(
      open(record, { publicKeyPem: pem, signatureJson: signatures(other.privateKey, phases) }),
    ).rejects.toThrow(/TPM refuses to open/);
  });

  it("refuses a boot that another key signed, its own public key and all", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const policy = {
      publicKeyPem: other.publicKey.export({ format: "pem", type: "spki" }).toString(),
      signatureJson: signatures(other.privateKey, phases),
    };
    await expect(open(record, policy)).rejects.toThrow(/TPM refuses to open/);
  });

  it("refuses a record changed after it was sealed", async () => {
    const body = Buffer.from(parseRecord(record)!);
    body[body.length - 1]! ^= 0x01;
    await expect(unsealBody(tpm, parseBody(body), files)).rejects.toThrow(/changed after it was sealed/);
  });

  it("refuses it on another PC, booted the same", async () => {
    const other = await softwareTpm("another-pc", TPM_PORT + 2);
    expect(await boot(other)).toEqual(phases);
    await expect(open(record, files, other)).rejects.toThrow(/TPM refuses to open/);
    expect(await held(other)).toEqual([]);
  }, 120_000);

  it("opens it while systemd-pcrphase moves PCR 11 on to the next phase Lanterel signed", async () => {
    const ready = sha256(Buffer.concat([phases.at(-1)!, sha256("ready")]));
    const policy = { publicKeyPem: pem, signatureJson: signatures(lanterel.privateKey, [...phases, ready]) };
    let moved = false;
    const racing = Object.assign(Object.create(tpm) as Tpm, {
      policyPcr: async (session: number, pcrs: readonly number[]) => {
        await tpm.policyPcr(session, pcrs);
        if (!moved) await tpm.extend(11, sha256("ready"));
        moved = true;
      },
    });
    expect((await open(record, policy, racing)).toString()).toBe(JSON.stringify(GIVEN));
    expect(moved).toBe(true);
  });

  it("refuses a boot with a command line from outside its UKI, PCR 11 signed and all", async () => {
    const now = Buffer.from((await tpm.readPcrs([11]))[11]!, "hex");
    const policy = { publicKeyPem: pem, signatureJson: signatures(lanterel.privateKey, [now]) };
    expect((await open(record, policy)).toString()).toBe(JSON.stringify(GIVEN));
    await tpm.extend(12, sha256("systemd.debug_shell=1"));
    await expect(open(record, policy)).rejects.toThrow(/TPM refuses to open/);
  });

  it("refuses a boot Lanterel did not sign", async () => {
    await tpm.extend(11, sha256("not Lanterel's"));
    await expect(open(record)).rejects.toThrow(/this boot is not one Lanterel signed/);
  });

  it("is refused by the TPM itself when told a signed PCR 11 value that is not this boot's", async () => {
    const signed = phases.at(-1)!.toString("hex");
    const told = Object.assign(Object.create(tpm) as Tpm, { readPcrs: async () => ({ 11: signed }) });
    await expect(open(record, files, told)).rejects.toThrow(/TPM refuses to open/);
  });
});
