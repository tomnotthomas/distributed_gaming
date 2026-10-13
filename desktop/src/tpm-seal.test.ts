// @vitest-environment node
// Sealing the hand-over record's key to this PC's TPM (tpm-seal.cjs) and the
// record it opens (provision.cjs): the signing key's Name and the sealed
// object's policy against the contract's golden vector, TPM2_Create byte for
// byte, the refusals an owner can act on, and a real seal on a software TPM
// that only a policy session could unseal.
//
// The software TPM part is skipped where swtpm is not installed (apt install swtpm).

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RECORD_BYTES, RECORD_MAGIC, provisionRecord } from "../provision.cjs";
import { SRK_HANDLE, b2, run, sealKey, sealPolicy, signingKey } from "../tpm-seal.cjs";
import { SRK_TEMPLATE, makeSrk, tcpTransport, type TcpTransport } from "../vm/swtpm.cjs";
import { fakeTpm, type SrkMode } from "./test/fakeTpm";
import { GOLDEN_CERT, GOLDEN_PEM } from "./test/goldenKey";

const NAME = "000bb0609f4f2dcf176400b8725546a2aa1239e0a5116a97003cbb6930d2cb974afb";
const AUTH_POLICY = "b38c8c71cb83e0a22696b8bb6c9aada522313f475ab1d1dff399a36c11105eab";
const NO_SRK = /^Windows has not set up this PC's TPM for Lanterel OS yet: .* then go live again\.$/;
const MACHINE = {
  serverUrl: "wss://lanterel.example",
  machineId: "gaming-pc-1",
  machineKey: "the-machine-key-of-gaming-pc-1",
};
/** A key to seal: 00 01 02 … 1f. */
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

const has = (tool: string) => {
  try {
    execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** A fake TPM whose SRK answers as `mode` says, and a transport to it. */
function fake(mode: SrkMode = "srk") {
  const tpm = fakeTpm();
  tpm.state.mode = mode;
  return { tpm, transport: tpm.transport() };
}

describe("the key that signs Lanterel OS's boots", () => {
  it("has the golden vector's Name and seal policy, from PEM, a KeyObject or a certificate's DER", () => {
    for (const key of [GOLDEN_PEM, createPublicKey(GOLDEN_PEM), GOLDEN_CERT]) {
      expect(signingKey(key).name.toString("hex")).toBe(NAME);
      expect(sealPolicy(key).toString("hex")).toBe(AUTH_POLICY);
    }
  });

  it("is loaded as the contract's TPMT_PUBLIC: RSA, SHA-256, userWithAuth decrypt sign, exponent 0 for 65537", () => {
    const { public: pub, name } = signingKey(GOLDEN_PEM);
    const modulus = createPublicKey(GOLDEN_PEM).export({ format: "jwk" }).n!;
    expect(pub.toString("hex")).toBe(
      `0001000b000600400000001000100800000000000100${Buffer.from(modulus, "base64url").toString("hex")}`,
    );
    expect(name.subarray(2).equals(createHash("sha256").update(pub).digest())).toBe(true);
  });

  it("refuses a key that is not RSA", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    expect(() => signingKey(publicKey)).toThrow(/not an RSA key/);
    expect(() => sealPolicy(generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey)).toThrow(
      /not an RSA key/,
    );
  });
});

describe("sealing a key to this PC's TPM", () => {
  it("reads the SRK at 0x81000001, then sends TPM2_Create byte for byte as the contract lays it out", async () => {
    const { tpm, transport } = fake();
    const sealed = await sealKey(transport, Buffer.from(AUTH_POLICY, "hex"), KEY);
    expect(tpm.state.sent.map((c) => c.toString("hex"))).toEqual([
      "80010000000e0000017381000001",
      [
        "8002 00000077 00000153 81000001",
        "00000009 40000009 0000 01 0000",
        `0024 0000 0020 ${KEY.toString("hex")}`,
        `002e 0008 000b 00000492 0020 ${AUTH_POLICY} 0010 0000`,
        "0000",
        "00000000",
      ]
        .join("")
        .replace(/ /g, ""),
    ]);
    // The command that carried the key is zeroed once the TPM answered.
    expect(tpm.state.received[1]!.every((b) => b === 0)).toBe(true);
    const [made] = [...tpm.sealed.values()];
    expect(made!.key.equals(KEY)).toBe(true);
    expect(sealed.private).toHaveLength(32);
    expect(sealed.public.toString("hex")).toBe(
      `0008000b000004920020${AUTH_POLICY}00100020${"ab".repeat(32)}`,
    );
  });

  it("refuses a PC whose TPM has no storage root key, or another kind of key, where Windows keeps it", async () => {
    for (const mode of ["absent", "signing"] as const) {
      const { tpm, transport } = fake(mode);
      await expect(sealKey(transport, Buffer.from(AUTH_POLICY, "hex"), KEY)).rejects.toThrow(NO_SRK);
      expect(tpm.state.sent).toHaveLength(1);
      expect(tpm.sealed.size).toBe(0);
    }
    // Through Windows' TPM Base Services an empty handle answers TPM_RC_HANDLE without its handle number.
    const tbs = { send: async () => Buffer.from("80010000000a0000008b", "hex") };
    await expect(sealKey(tbs, Buffer.from(AUTH_POLICY, "hex"), KEY)).rejects.toThrow(NO_SRK);
  });

  it("names the command and its response code when the TPM refuses one", async () => {
    const { transport: srk } = fake();
    const transport = {
      send: async (command: Buffer) =>
        command.readUInt32BE(6) === 0x173 ? srk.send(command) : Buffer.from("80010000000a00000902", "hex"),
    };
    await expect(sealKey(transport, Buffer.from(AUTH_POLICY, "hex"), KEY)).rejects.toThrow(
      "TPM command 0x153 failed: rc 0x902",
    );
  });

  it("takes only a 32-byte key and a 32-byte policy", async () => {
    const { tpm, transport } = fake();
    await expect(sealKey(transport, Buffer.alloc(31), KEY)).rejects.toThrow(/policy/);
    await expect(sealKey(transport, Buffer.from(AUTH_POLICY, "hex"), Buffer.alloc(16))).rejects.toThrow(
      /key/,
    );
    expect(tpm.state.sent).toHaveLength(0);
  });
});

describe("the sealed provisioning record", () => {
  it("lays out version 2: the sealed key, then the payload encrypted with it, never in the clear", async () => {
    const { tpm, transport } = fake();
    let given: Buffer | null = null;
    const record = await provisionRecord(MACHINE, (key) => {
      given = key;
      return sealKey(transport, sealPolicy(GOLDEN_CERT), key);
    });
    expect(record).toHaveLength(RECORD_BYTES);
    expect(record.subarray(0, 8).equals(RECORD_MAGIC)).toBe(true);
    expect(record.readUInt32BE(8)).toBe(2);
    const length = record.readUInt32BE(12);
    const body = record.subarray(48, 48 + length);
    expect(createHash("sha256").update(body).digest().equals(record.subarray(16, 48))).toBe(true);
    expect(record.subarray(48 + length).every((b) => b === 0)).toBe(true);
    const [made] = [...tpm.sealed.values()];
    expect(made!.policy.toString("hex")).toBe(AUTH_POLICY);
    // The sealed object's public, then its private, then nonce, tag and ciphertext to the end.
    const pub = body.subarray(2, 2 + body.readUInt16BE(0));
    expect(pub.toString("hex")).toMatch(new RegExp(`^0008000b000004920020${AUTH_POLICY}`));
    const priv = body.subarray(4 + pub.length, 4 + pub.length + body.readUInt16BE(2 + pub.length));
    expect(tpm.sealed.has(priv.toString("hex"))).toBe(true);
    expect(length).toBe(4 + pub.length + priv.length + 12 + 16 + JSON.stringify(MACHINE).length);
    expect(tpm.open(record)).toEqual(MACHINE);
    expect(record.includes(Buffer.from(MACHINE.machineKey))).toBe(false);
    expect(record.includes(made!.key)).toBe(false);
    // The key is zeroed once used.
    expect(given!.every((b) => b === 0)).toBe(true);
  });

  it("gets a fresh key and nonce each time", async () => {
    const { tpm, transport } = fake();
    const seal = (key: Buffer) => sealKey(transport, sealPolicy(GOLDEN_CERT), key);
    const [one, two] = [await provisionRecord(MACHINE, seal), await provisionRecord(MACHINE, seal)];
    const [a, b] = [...tpm.sealed.values()];
    expect(a!.key.equals(b!.key)).toBe(false);
    expect(one.subarray(48).equals(two.subarray(48))).toBe(false);
    expect([tpm.open(one), tpm.open(two)]).toEqual([MACHINE, MACHINE]);
  });

  it("checks the provisioning before the TPM is asked, and refuses one too long for the record", async () => {
    let asked = 0;
    const seal = async () => {
      asked++;
      return { public: Buffer.alloc(48), private: Buffer.alloc(126) };
    };
    await expect(provisionRecord({ ...MACHINE, serverUrl: "ws://lanterel.example" }, seal)).rejects.toThrow(
      /must be encrypted/,
    );
    await expect(provisionRecord({ ...MACHINE, machineKey: "short" }, seal)).rejects.toThrow(
      /no machine key/,
    );
    expect(asked).toBe(0);
    const long = { ...MACHINE, serverUrl: `wss://lanterel.example/${"x".repeat(3900)}` };
    await expect(provisionRecord(long, seal)).rejects.toThrow("The provisioning is too long.");
  });

  it("is never made when the TPM cannot seal", async () => {
    const { transport } = fake("absent");
    await expect(
      provisionRecord(MACHINE, (key) => sealKey(transport, sealPolicy(GOLDEN_CERT), key)),
    ).rejects.toThrow(NO_SRK);
  });
});

describe.skipIf(!has("swtpm"))("sealing on a software TPM", () => {
  const PORT = 25000 + Math.floor(Math.random() * 400) * 2;
  let work: string;
  let swtpm: ChildProcess | undefined;
  let transport: TcpTransport | undefined;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "swiff-tpm-seal-test-"));
    swtpm = spawn(
      "swtpm",
      [
        "socket",
        "--tpm2",
        "--server",
        `type=tcp,port=${PORT},bindaddr=127.0.0.1`,
        "--ctrl",
        `type=tcp,port=${PORT + 1},bindaddr=127.0.0.1`,
        "--flags",
        "not-need-init,startup-clear",
        "--tpmstate",
        `dir=${work}`,
      ],
      { stdio: "ignore" },
    );
    for (let tries = 0; !transport; tries++) {
      try {
        transport = await tcpTransport("127.0.0.1", PORT);
      } catch (error) {
        if (tries > 50) throw error;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  afterAll(() => {
    transport?.close();
    swtpm?.kill();
    rmSync(work, { recursive: true, force: true });
  });

  it("refuses before Windows made the SRK, then seals under it so that only a policy session could unseal", async () => {
    const tpm = transport!;
    const policy = sealPolicy(GOLDEN_PEM);
    await expect(sealKey(tpm, policy, KEY)).rejects.toThrow(NO_SRK);

    await makeSrk(tpm);
    await makeSrk(tpm);
    const srk = (await run(tpm, 0x173, { handles: [SRK_HANDLE] })).b2();
    expect(srk.subarray(0, 26).equals(SRK_TEMPLATE.subarray(0, 26))).toBe(true);

    const sealed = await sealKey(tpm, policy, KEY);
    expect(sealed.public.toString("hex")).toMatch(new RegExp(`^0008000b000004920020${AUTH_POLICY}00100020`));
    expect(sealed.private.includes(KEY)).toBe(false);

    const loaded = await run(tpm, 0x157, {
      handles: [SRK_HANDLE],
      auth: true,
      params: Buffer.concat([b2(sealed.private), b2(sealed.public)]),
    });
    const handle = loaded.u32();
    try {
      // userWithAuth is clear: a password session cannot unseal it, only the policy.
      await expect(run(tpm, 0x15e, { handles: [handle], auth: true })).rejects.toThrow(
        "TPM command 0x15e failed: rc 0x12f",
      );
    } finally {
      const flush = Buffer.alloc(4);
      flush.writeUInt32BE(handle);
      await run(tpm, 0x165, { params: flush });
    }
  });
});
