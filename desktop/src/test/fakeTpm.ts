// A TPM in JS for the seal's and the installer's tests (tpm-seal.cjs): it
// answers TPM2_ReadPublic of the storage root key with the public Windows
// persists there, or an error, or a key that is no storage key, and seals in
// TPM2_Create by remembering the key under a private of its own, so a test can
// open the record that key encrypted.

import { createDecipheriv, createHash } from "node:crypto";

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
const b2 = (data: Buffer) => Buffer.concat([u16(data.length), data]);

/** Windows' storage root key at 0x81000001 on the captain's PC: the TCG SRK template, its modulus stood in for. */
export const SRK_PUBLIC = Buffer.from(
  `0001000b00030472000000060080004300100800000000000100${"c5".repeat(256)}`,
  "hex",
);
/** An RSA key that is no storage key: userWithAuth decrypt sign, not restricted. */
export const SIGNING_PUBLIC = Buffer.from(
  `0001000b000600400000001000100800000000000100${"c5".repeat(256)}`,
  "hex",
);

const SRK_HANDLE = 0x81000001;
/** TPM_RC_HANDLE for the first handle: no object there. */
export const RC_NO_OBJECT = 0x18b;

/** What the fake's ReadPublic of the SRK answers: the SRK, an error, or a key that is no storage key. */
export type SrkMode = "srk" | "absent" | "signing";

const response = (tag: number, rc: number, body: Buffer = Buffer.alloc(0)) =>
  Buffer.concat([u16(tag), u32(10 + body.length), u32(rc), body]);

export function fakeTpm() {
  /** What each Create sealed, by the private it answered with. */
  const sealed = new Map<string, { key: Buffer; policy: Buffer }>();
  /** `sent`: a copy of each command; `received`: each command itself, which its sender may zero after. */
  const state = {
    mode: "srk" as SrkMode,
    opened: 0,
    closed: 0,
    sent: [] as Buffer[],
    received: [] as Buffer[],
  };

  function answer(command: Buffer): Buffer {
    const code = command.readUInt32BE(6);
    if (code === 0x173) {
      if (command.readUInt32BE(10) !== SRK_HANDLE || state.mode === "absent")
        return response(0x8001, RC_NO_OBJECT);
      const pub = state.mode === "srk" ? SRK_PUBLIC : SIGNING_PUBLIC;
      const name = Buffer.concat([u16(0x000b), createHash("sha256").update(pub).digest()]);
      return response(0x8001, 0, Buffer.concat([b2(pub), b2(name), b2(name)]));
    }
    if (code === 0x153 && command.readUInt32BE(10) === SRK_HANDLE) {
      let at = 18 + command.readUInt32BE(14);
      const take = () => {
        const size = command.readUInt16BE(at);
        const v = Buffer.from(command.subarray(at + 2, at + 2 + size));
        at += 2 + size;
        return v;
      };
      const sensitive = take();
      const template = take();
      const key = sensitive.subarray(2 + sensitive.readUInt16BE(0) + 2);
      const policy = template.subarray(10, 10 + template.readUInt16BE(8));
      const priv = createHash("sha256").update(`sealed ${sealed.size}`).digest();
      sealed.set(priv.toString("hex"), { key: Buffer.from(key), policy: Buffer.from(policy) });
      const pub = Buffer.concat([template.subarray(0, template.length - 2), b2(Buffer.alloc(32, 0xab))]);
      const params = Buffer.concat([
        b2(priv),
        b2(pub),
        b2(Buffer.alloc(0)),
        b2(Buffer.alloc(0)),
        u16(0x8021),
        u32(0x40000001),
        b2(Buffer.alloc(0)),
      ]);
      const session = Buffer.from([0, 0, 1, 0, 0]);
      return response(0x8002, 0, Buffer.concat([u32(params.length), params, session]));
    }
    return response(0x8001, 0x143);
  }

  return {
    state,
    sealed,
    /** A transport to it, as Windows' TPM Base Services would give one. */
    transport() {
      state.opened++;
      return {
        send: async (command: Buffer) => {
          state.sent.push(Buffer.from(command));
          state.received.push(command);
          return answer(command);
        },
        close: () => void state.closed++,
      };
    },
    /** The payload a record (provision.cjs) holds, opened with the key this TPM sealed for it. */
    open(record: Buffer): unknown {
      const body = record.subarray(48, 48 + record.readUInt32BE(12));
      let at = 0;
      const take = (n: number) => body.subarray(at, (at += n));
      take(body.readUInt16BE(at) + 2);
      const priv = take(body.readUInt16BE(at) + 2).subarray(2);
      const nonce = take(12);
      const tag = take(16);
      const { key } = sealed.get(priv.toString("hex"))!;
      const decipher = createDecipheriv("aes-256-gcm", key, nonce).setAuthTag(tag);
      return JSON.parse(
        Buffer.concat([decipher.update(body.subarray(at)), decipher.final()]).toString("utf8"),
      );
    },
  };
}
