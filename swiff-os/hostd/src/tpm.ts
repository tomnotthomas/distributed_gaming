// The TPM 2.0 commands the attestation client sends (attest.ts), raw, with
// Node's own crypto and nothing else: no tpm2-tools in the image. Ported from
// the fixture recorder that the server's verifier tests replay
// (server/scripts/tpm-fixtures.mjs), so a real TPM is driven exactly as the
// recorded swtpm was. Names follow the TCG TPM 2.0 Library specification
// (Part 2 Structures, Part 3 Commands): every structure is big-endian, every
// TPM2B a 16-bit size followed by that many bytes.
//
// The kernel's resource manager (/dev/tpmrm0) flushes whatever a connection
// leaves loaded when it closes, so a crash mid-attestation leaks nothing.

import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";

/** One command in, its response out. */
export type Transport = { send(command: Buffer): Promise<Buffer>; close(): void };

/** A TPM command that answered with a response code other than success. */
export class TpmError extends Error {
  readonly rc: number;
  constructor(command: number, rc: number) {
    super(`TPM command 0x${command.toString(16)} failed: rc 0x${rc.toString(16)}`);
    this.rc = rc;
  }
}

/** The largest response a TPM 2.0 sends (TPM_MAX_COMMAND_SIZE is 4096 on every TPM in practice). */
const MAX_RESPONSE = 8192;

/** The kernel's TPM resource manager: a write is one command, the next read its whole response. */
export function deviceTransport(path = "/dev/tpmrm0"): Transport {
  const fd = openSync(path, "r+");
  return {
    async send(command) {
      writeSync(fd, command);
      const buf = Buffer.alloc(MAX_RESPONSE);
      const n = readSync(fd, buf, 0, buf.length, null);
      return buf.subarray(0, n);
    },
    close: () => closeSync(fd),
  };
}

/** A TPM on a TCP command channel, as swtpm serves one (`swtpm socket --server type=tcp`). */
export async function tcpTransport(host: string, port: number): Promise<Transport> {
  const socket = await new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
    const s = createConnection(port, host, () => resolve(s));
    s.once("error", reject);
  });
  let pending = Buffer.alloc(0);
  let waiting: { resolve: (response: Buffer) => void; reject: (error: Error) => void } | null = null;
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    if (!waiting || pending.length < 6 || pending.length < pending.readUInt32BE(2)) return;
    const size = pending.readUInt32BE(2);
    const response = pending.subarray(0, size);
    pending = pending.subarray(size);
    const { resolve } = waiting;
    waiting = null;
    resolve(response);
  });
  socket.on("error", (error) => waiting?.reject(error));
  return {
    send: (command) =>
      new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        socket.write(command);
      }),
    close: () => socket.destroy(),
  };
}

// --- Marshalling --------------------------------------------------------------

const u8 = (n: number) => Buffer.from([n]);
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
/** A TPM2B: the bytes with their 16-bit size in front. */
export const b2 = (data: Buffer) => Buffer.concat([u16(data.length), data]);
const EMPTY = Buffer.alloc(0);

export const ALG = {
  RSA: 0x0001,
  AES: 0x0006,
  SHA256: 0x000b,
  NULL: 0x0010,
  RSASSA: 0x0014,
  ECDSA: 0x0018,
  ECC: 0x0023,
  CFB: 0x0043,
} as const;

const TPM_RS_PW = 0x40000009;
const TPM_RH_NULL = 0x40000007;
export const TPM_RH_ENDORSEMENT = 0x4000000b;
/** Where Windows and the TCG's provisioning guidance persist the RSA EK. */
export const RSA_EK_HANDLE = 0x81010001;
const TPM_SE_POLICY = 0x01;

const CC = {
  CreatePrimary: 0x131,
  Create: 0x153,
  Load: 0x157,
  ActivateCredential: 0x147,
  PolicySecret: 0x151,
  Quote: 0x158,
  FlushContext: 0x165,
  ReadPublic: 0x173,
  StartAuthSession: 0x176,
  PCR_Read: 0x17e,
  PCR_Extend: 0x182,
} as const;

/** The EK templates' authPolicy: PolicySecret(TPM_RH_ENDORSEMENT). */
const EK_POLICY = Buffer.from("837197674484b3f81a90cc8d46a5d724fd52d76e06520b64f2a1da1b331469aa", "hex");
/** fixedTPM fixedParent sensitiveDataOrigin adminWithPolicy restricted decrypt. */
const EK_ATTRIBUTES = 0x000300b2;

/** TCG EK Credential Profile template L-1: RSA 2048, without its unique field (256 zero bytes). */
const RSA_EK_HEAD = Buffer.concat([
  u16(ALG.RSA),
  u16(ALG.SHA256),
  u32(EK_ATTRIBUTES),
  b2(EK_POLICY),
  u16(ALG.AES),
  u16(128),
  u16(ALG.CFB),
  u16(ALG.NULL),
  u16(2048),
  u32(0),
]);
/** TCG EK Credential Profile template L-2: ECC NIST P-256, without its unique field (two 32-byte zeros). */
const ECC_EK_HEAD = Buffer.concat([
  u16(ALG.ECC),
  u16(ALG.SHA256),
  u32(EK_ATTRIBUTES),
  b2(EK_POLICY),
  u16(ALG.AES),
  u16(128),
  u16(ALG.CFB),
  u16(ALG.NULL),
  u16(0x0003),
  u16(ALG.NULL),
]);
export const EK_TEMPLATES = {
  rsa: { head: RSA_EK_HEAD, template: Buffer.concat([RSA_EK_HEAD, b2(Buffer.alloc(256))]) },
  ecc: {
    head: ECC_EK_HEAD,
    template: Buffer.concat([ECC_EK_HEAD, b2(Buffer.alloc(32)), b2(Buffer.alloc(32))]),
  },
} as const;
export type EkType = keyof typeof EK_TEMPLATES;

/**
 * The AK: an ECC NIST P-256 restricted signing key, fixed to ECDSA with
 * SHA-256 (fixedTPM fixedParent sensitiveDataOrigin userWithAuth restricted
 * sign). ECC, since a TPM makes one in milliseconds and an RSA key can take it
 * seconds.
 */
export const AK_TEMPLATE = Buffer.concat([
  u16(ALG.ECC),
  u16(ALG.SHA256),
  u32(0x00050072),
  b2(EMPTY),
  u16(ALG.NULL),
  u16(ALG.ECDSA),
  u16(ALG.SHA256),
  u16(0x0003),
  u16(ALG.NULL),
  b2(EMPTY),
  b2(EMPTY),
]);
/** The AK's signing scheme, as TPM2_Quote takes it. */
export const AK_SCHEME = Buffer.concat([u16(ALG.ECDSA), u16(ALG.SHA256)]);

/** A password session with an empty password. */
const pw = () => Buffer.concat([u32(TPM_RS_PW), b2(EMPTY), u8(0x01), b2(EMPTY)]);
/** A policy session, used once: the TPM flushes it after the command. */
const policy = (handle: number) => Buffer.concat([u32(handle), b2(EMPTY), u8(0x00), b2(EMPTY)]);

/** A TPML_PCR_SELECTION of SHA-256 PCRs. */
export function selection(pcrs: readonly number[]): Buffer {
  const bits = Buffer.alloc(3);
  for (const pcr of pcrs) bits[pcr >> 3]! |= 1 << (pcr & 7);
  return Buffer.concat([u32(1), u16(ALG.SHA256), u8(3), bits]);
}

class Response {
  private at = 10;
  private readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  u16() {
    const v = this.buf.readUInt16BE(this.at);
    this.at += 2;
    return v;
  }
  u32() {
    const v = this.buf.readUInt32BE(this.at);
    this.at += 4;
    return v;
  }
  bytes(n: number) {
    if (this.at + n > this.buf.length) throw new Error("TPM response truncated");
    const v = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return Buffer.from(v);
  }
  b2() {
    return this.bytes(this.u16());
  }
  get position() {
    return this.at;
  }
}

/** TPM_RC_YIELDED, TPM_RC_TESTING and TPM_RC_RETRY: warnings that ask for the same command again. */
const RETRY = new Set([0x908, 0x90a, 0x922]);
const RETRIES = 50;

/** A loaded key: its handle and its TPMT_PUBLIC. */
export type Loaded = { handle: number; public: Buffer };

/** The TPM, one command at a time. */
export class Tpm {
  private readonly transport: Transport;
  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** Run command `code` with `handles`, `auths` (session areas) and `params`; the response past its header. */
  async run(
    code: number,
    {
      handles = [],
      auths = [],
      params = EMPTY,
    }: { handles?: number[]; auths?: Buffer[]; params?: Buffer } = {},
  ): Promise<Response> {
    const body = Buffer.concat([
      ...handles.map(u32),
      ...(auths.length ? [u32(Buffer.concat(auths).length), ...auths] : []),
      params,
    ]);
    const tag = auths.length ? 0x8002 : 0x8001;
    const command = Buffer.concat([u16(tag), u32(10 + body.length), u32(code), body]);
    for (let tries = 1; ; tries++) {
      const response = await this.transport.send(command);
      if (response.length < 10) throw new Error(`TPM command 0x${code.toString(16)}: short response`);
      const rc = response.readUInt32BE(6);
      if (rc === 0) return new Response(response);
      // The TPM did not start the command (it consumed no session): send it again.
      if (!RETRY.has(rc) || tries >= RETRIES) throw new TpmError(code, rc);
      await new Promise((resolve) => setTimeout(resolve, 20 * tries));
    }
  }

  /** A policy session satisfying the EK templates' PolicySecret(TPM_RH_ENDORSEMENT). */
  async ekPolicy(): Promise<number> {
    const r = await this.run(CC.StartAuthSession, {
      handles: [TPM_RH_NULL, TPM_RH_NULL],
      params: Buffer.concat([
        b2(randomBytes(32)),
        b2(EMPTY),
        u8(TPM_SE_POLICY),
        u16(ALG.NULL),
        u16(ALG.SHA256),
      ]),
    });
    const session = r.u32();
    try {
      await this.run(CC.PolicySecret, {
        handles: [TPM_RH_ENDORSEMENT, session],
        auths: [pw()],
        params: Buffer.concat([b2(EMPTY), b2(EMPTY), b2(EMPTY), u32(0)]),
      });
    } catch (error) {
      await this.flush(session).catch(() => {});
      throw error;
    }
    return session;
  }

  /** The TPMT_PUBLIC of the object at `handle`. */
  async readPublic(handle: number): Promise<Buffer> {
    const r = await this.run(CC.ReadPublic, { handles: [handle] });
    return r.b2();
  }

  /**
   * The EK of `type`, as the TCG's default template makes it from the TPM's
   * endorsement seed: the key the TPM's EK certificate certifies. The RSA EK
   * persisted where Windows keeps it is used as is when it was made from that
   * template; anything else is made afresh (`persistent` false: flush it after).
   */
  async ek(type: EkType): Promise<Loaded & { persistent: boolean }> {
    const { head, template } = EK_TEMPLATES[type];
    if (type === "rsa") {
      const persisted = await this.readPublic(RSA_EK_HANDLE).catch(() => null);
      if (persisted && persisted.subarray(0, head.length).equals(head)) {
        return { handle: RSA_EK_HANDLE, public: persisted, persistent: true };
      }
    }
    const r = await this.run(CC.CreatePrimary, {
      handles: [TPM_RH_ENDORSEMENT],
      auths: [pw()],
      params: Buffer.concat([b2(Buffer.concat([b2(EMPTY), b2(EMPTY)])), b2(template), b2(EMPTY), u32(0)]),
    });
    const handle = r.u32();
    r.u32(); // parameterSize
    return { handle, public: r.b2(), persistent: false };
  }

  /** A key from `template` made and loaded under the EK at `ek`: its handle and TPMT_PUBLIC. */
  async createUnderEk(ek: number, template: Buffer): Promise<Loaded> {
    const created = await this.run(CC.Create, {
      handles: [ek],
      auths: [policy(await this.ekPolicy())],
      params: Buffer.concat([b2(Buffer.concat([b2(EMPTY), b2(EMPTY)])), b2(template), b2(EMPTY), u32(0)]),
    });
    created.u32(); // parameterSize
    const priv = created.b2();
    const pub = created.b2();
    const loaded = await this.run(CC.Load, {
      handles: [ek],
      auths: [policy(await this.ekPolicy())],
      params: Buffer.concat([b2(priv), b2(pub)]),
    });
    return { handle: loaded.u32(), public: pub };
  }

  /** TPM2_ActivateCredential: the credential the server wrapped to the EK, for the key at `object`. */
  async activateCredential(
    object: number,
    ek: number,
    credentialBlob: Buffer,
    secret: Buffer,
  ): Promise<Buffer> {
    const r = await this.run(CC.ActivateCredential, {
      handles: [object, ek],
      auths: [pw(), policy(await this.ekPolicy())],
      params: Buffer.concat([credentialBlob, secret]),
    });
    r.u32(); // parameterSize
    return r.b2();
  }

  /** TPM2_Quote by the key at `ak` over `qualifyingData`: the TPMS_ATTEST and its TPMT_SIGNATURE. */
  async quote(
    ak: number,
    qualifyingData: Buffer,
    pcrs: readonly number[],
    scheme: Buffer,
  ): Promise<{ attest: Buffer; signature: Buffer }> {
    const r = await this.run(CC.Quote, {
      handles: [ak],
      auths: [pw()],
      params: Buffer.concat([b2(qualifyingData), scheme, selection(pcrs)]),
    });
    const end = r.u32() + r.position; // the parameters end where the session's response begins
    const attest = r.b2();
    return { attest, signature: r.bytes(end - r.position) };
  }

  /** SHA-256 PCRs `pcrs`, by number, as hex. */
  async readPcrs(pcrs: readonly number[]): Promise<Record<string, string>> {
    const values: Record<string, string> = {};
    for (let i = 0; i < pcrs.length; i += 8) {
      const chunk = [...pcrs.slice(i, i + 8)].sort((a, b) => a - b);
      const r = await this.run(CC.PCR_Read, { params: selection(chunk) });
      r.u32(); // update counter
      const banks = r.u32();
      for (let b = 0; b < banks; b++) {
        r.u16();
        r.bytes(r.bytes(1)[0]!);
      }
      const count = r.u32();
      if (count !== chunk.length) throw new Error("the TPM has no SHA-256 bank for every PCR asked");
      for (let d = 0; d < count; d++) values[chunk[d]!] = r.b2().toString("hex");
    }
    return values;
  }

  /** TPM2_PCR_Extend of the SHA-256 bank: for tests, standing in for firmware and systemd. */
  async extend(pcr: number, digest: Buffer): Promise<void> {
    await this.run(CC.PCR_Extend, {
      handles: [pcr],
      auths: [pw()],
      params: Buffer.concat([u32(1), u16(ALG.SHA256), digest]),
    });
  }

  async flush(handle: number): Promise<void> {
    await this.run(CC.FlushContext, { params: u32(handle) });
  }
}
