// TPM 2.0 structures the attestation verifier reads and writes, with Node's own
// crypto and nothing else. Names follow the TCG TPM 2.0 Library specification
// (Part 1 Architecture, Part 2 Structures), where every structure is
// big-endian and every TPM2B is a 16-bit size followed by that many bytes.
//
//   readPublic      TPMT_PUBLIC (an AK's or an EK's public area) and its name
//   readAttest      TPMS_ATTEST from TPM2_Quote: magic, signer, nonce, clock, PCR digest
//   quoteSignatureHash  TPMT_SIGNATURE over the TPMS_ATTEST bytes, by the AK
//   makeCredential  TPM2_MakeCredential done off the TPM (Part 1, 24): only the
//                   TPM holding the EK's private key can recover the credential,
//                   and only for an object with exactly that name loaded in it
//
// Every reader throws TpmFormatError on input that is not the structure it
// reads, so the verifier can refuse it as malformed.

import {
  createCipheriv,
  createECDH,
  createHash,
  createHmac,
  createPublicKey,
  constants,
  publicEncrypt,
  randomBytes,
  verify,
  type KeyObject,
} from "node:crypto";

export class TpmFormatError extends Error {
  override name = "TpmFormatError";
}

export const TPM_ALG = {
  RSA: 0x0001,
  SHA1: 0x0004,
  AES: 0x0006,
  SHA256: 0x000b,
  SHA384: 0x000c,
  SHA512: 0x000d,
  NULL: 0x0010,
  RSASSA: 0x0014,
  RSAES: 0x0015,
  RSAPSS: 0x0016,
  ECDSA: 0x0018,
  ECDAA: 0x001a,
  ECC: 0x0023,
  CFB: 0x0043,
} as const;

/** Hash algorithms by TPM_ALG_ID: Node's name and the digest size. */
const HASHES = new Map<number, { name: string; size: number }>([
  [TPM_ALG.SHA1, { name: "sha1", size: 20 }],
  [TPM_ALG.SHA256, { name: "sha256", size: 32 }],
  [TPM_ALG.SHA384, { name: "sha384", size: 48 }],
  [TPM_ALG.SHA512, { name: "sha512", size: 64 }],
]);

export const TPM_ECC_NIST_P256 = 0x0003;
export const TPM_ECC_NIST_P384 = 0x0004;
const CURVES = new Map<number, { jwk: string; node: string; size: number }>([
  [TPM_ECC_NIST_P256, { jwk: "P-256", node: "prime256v1", size: 32 }],
  [TPM_ECC_NIST_P384, { jwk: "P-384", node: "secp384r1", size: 48 }],
]);

/** TPMA_OBJECT bits. */
export const TPMA = {
  fixedTPM: 1 << 1,
  fixedParent: 1 << 4,
  sensitiveDataOrigin: 1 << 5,
  userWithAuth: 1 << 6,
  adminWithPolicy: 1 << 7,
  restricted: 1 << 16,
  decrypt: 1 << 17,
  sign: 1 << 18,
} as const;

/** TPM_RH_ENDORSEMENT: the hierarchy an AK made under the EK lives in. */
export const TPM_RH_ENDORSEMENT = 0x4000000b;
const TPM_GENERATED_VALUE = 0xff544347;
const TPM_ST_ATTEST_QUOTE = 0x8018;

/** A cursor over a big-endian buffer that throws TpmFormatError past its end. */
export class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}
  private take(n: number): Buffer {
    if (this.offset + n > this.buf.length) throw new TpmFormatError("truncated");
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  u8 = () => this.take(1).readUInt8(0);
  u16 = () => this.take(2).readUInt16BE(0);
  u32 = () => this.take(4).readUInt32BE(0);
  u64 = () => this.take(8).readBigUInt64BE(0);
  bytes = (n: number) => Buffer.from(this.take(n));
  tpm2b = () => this.bytes(this.u16());
  /** How far it has read, for slicing out the bytes a structure spans. */
  get position() {
    return this.offset;
  }
  /** Throws unless everything was read: trailing bytes mean it was not that structure. */
  end() {
    if (this.offset !== this.buf.length) throw new TpmFormatError("trailing bytes");
  }
}

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
/** A TPM2B: the bytes with their 16-bit size in front. */
export const tpm2b = (data: Buffer) => Buffer.concat([u16(data.length), data]);

/** The hash named by `alg`, or a TpmFormatError. */
export function hashAlg(alg: number): { name: string; size: number } {
  const hash = HASHES.get(alg);
  if (!hash) throw new TpmFormatError(`unsupported hash algorithm 0x${alg.toString(16)}`);
  return hash;
}

export const digest = (alg: number, ...parts: Buffer[]) => {
  const h = createHash(hashAlg(alg).name);
  for (const part of parts) h.update(part);
  return h.digest();
};

/** A TPMT_PUBLIC this verifier can use: an RSA or ECC key, with the parts it checks. */
export type TpmPublic = {
  type: "rsa" | "ecc";
  nameAlg: number;
  attributes: number;
  authPolicy: Buffer;
  /** TPMT_SYM_DEF_OBJECT: what wraps its children and credentials; null for TPM_ALG_NULL. */
  symmetric: { alg: number; keyBits: number; mode: number } | null;
  /** The signing scheme it is fixed to, or null when any is allowed (TPM_ALG_NULL). */
  scheme: { alg: number; hash: number } | null;
  /** RSA: modulus bits and public exponent (0 in the structure means 65537). */
  rsa?: { keyBits: number; exponent: number; modulus: Buffer };
  /** ECC: TPM_ECC_CURVE and the point. */
  ecc?: { curve: number; x: Buffer; y: Buffer };
  /** The marshalled TPMT_PUBLIC, as its name is computed over. */
  bytes: Buffer;
};

/** Parse a TPMT_PUBLIC. Only RSA and ECC keys: anything else is a TpmFormatError. */
export function readPublic(bytes: Buffer): TpmPublic {
  const r = new Reader(bytes);
  const type = r.u16();
  const nameAlg = r.u16();
  hashAlg(nameAlg);
  const attributes = r.u32();
  const authPolicy = r.tpm2b();
  const symAlg = r.u16();
  const symmetric = symAlg === TPM_ALG.NULL ? null : { alg: symAlg, keyBits: r.u16(), mode: r.u16() };
  const schemeAlg = r.u16();
  let scheme: TpmPublic["scheme"] = null;
  if (schemeAlg !== TPM_ALG.NULL) {
    if (schemeAlg === TPM_ALG.ECDAA) {
      scheme = { alg: schemeAlg, hash: r.u16() };
      r.u16(); // count
    } else {
      // RSASSA, RSAPSS, OAEP and ECDSA carry a hash; RSAES carries none.
      scheme = { alg: schemeAlg, hash: schemeAlg === TPM_ALG.RSAES ? TPM_ALG.NULL : r.u16() };
    }
  }
  let out: TpmPublic;
  if (type === TPM_ALG.RSA) {
    const keyBits = r.u16();
    const exponent = r.u32() || 65537;
    const modulus = r.tpm2b();
    if (modulus.length * 8 !== keyBits) throw new TpmFormatError("modulus size");
    out = {
      type: "rsa",
      nameAlg,
      attributes,
      authPolicy,
      symmetric,
      scheme,
      rsa: { keyBits, exponent, modulus },
      bytes,
    };
  } else if (type === TPM_ALG.ECC) {
    const curve = r.u16();
    const kdf = r.u16();
    if (kdf !== TPM_ALG.NULL) r.u16();
    const x = r.tpm2b();
    const y = r.tpm2b();
    out = { type: "ecc", nameAlg, attributes, authPolicy, symmetric, scheme, ecc: { curve, x, y }, bytes };
  } else {
    throw new TpmFormatError(`unsupported key type 0x${type.toString(16)}`);
  }
  r.end();
  return out;
}

/** A TPM2B_PUBLIC (what TPM2_Create and TPM2_ReadPublic return) parsed as readPublic does. */
export function readPublic2b(bytes: Buffer): TpmPublic {
  const r = new Reader(bytes);
  const inner = r.tpm2b();
  r.end();
  return readPublic(inner);
}

/** An object's name: its nameAlg, then that hash of its TPMT_PUBLIC. */
export const nameOf = (pub: TpmPublic): Buffer =>
  Buffer.concat([u16(pub.nameAlg), digest(pub.nameAlg, pub.bytes)]);

/**
 * The qualified name of `child` made directly under `parent`, which is a
 * primary key of `hierarchy` (Part 1, 16.6): an AK made under the EK has
 * exactly this as the quote's qualifiedSigner.
 */
export function qualifiedNameUnder(hierarchy: number, parent: TpmPublic, child: TpmPublic): Buffer {
  const parentQn = Buffer.concat([
    u16(parent.nameAlg),
    digest(parent.nameAlg, u32(hierarchy), nameOf(parent)),
  ]);
  return Buffer.concat([u16(child.nameAlg), digest(child.nameAlg, parentQn, nameOf(child))]);
}

/** Node's view of a TPM public key. */
export function publicKeyOf(pub: TpmPublic): KeyObject {
  if (pub.rsa) {
    const e = Buffer.from(pub.rsa.exponent.toString(16).padStart(6, "0"), "hex");
    return createPublicKey({
      key: { kty: "RSA", n: pub.rsa.modulus.toString("base64url"), e: e.toString("base64url") },
      format: "jwk",
    });
  }
  const curve = CURVES.get(pub.ecc!.curve);
  if (!curve) throw new TpmFormatError("unsupported curve");
  return createPublicKey({
    key: {
      kty: "EC",
      crv: curve.jwk,
      x: leftPad(pub.ecc!.x, curve.size).toString("base64url"),
      y: leftPad(pub.ecc!.y, curve.size).toString("base64url"),
    },
    format: "jwk",
  });
}

function leftPad(buf: Buffer, size: number): Buffer {
  if (buf.length > size) throw new TpmFormatError("coordinate too long");
  return Buffer.concat([Buffer.alloc(size - buf.length), buf]);
}

/** One bank of PCRs a quote covers: the hash and the PCR indices, ascending. */
export type PcrSelection = { hash: number; pcrs: number[] };

/** The parts of a TPMS_ATTEST from TPM2_Quote the verifier judges. */
export type Quote = {
  qualifiedSigner: Buffer;
  /** The qualifying data: SHA-256 of the server's nonce. */
  extraData: Buffer;
  clock: { clock: bigint; resetCount: number; restartCount: number; safe: boolean };
  firmwareVersion: bigint;
  selections: PcrSelection[];
  /** The hash, under the signing scheme's hash, of every selected PCR in order. */
  pcrDigest: Buffer;
};

/** Parse a TPMS_ATTEST, refusing anything that is not a quote the TPM generated. */
export function readAttest(bytes: Buffer): Quote {
  const r = new Reader(bytes);
  if (r.u32() !== TPM_GENERATED_VALUE) throw new TpmFormatError("not TPM-generated");
  if (r.u16() !== TPM_ST_ATTEST_QUOTE) throw new TpmFormatError("not a quote");
  const qualifiedSigner = r.tpm2b();
  const extraData = r.tpm2b();
  const clock = { clock: r.u64(), resetCount: r.u32(), restartCount: r.u32(), safe: r.u8() === 1 };
  const firmwareVersion = r.u64();
  const count = r.u32();
  if (count > 16) throw new TpmFormatError("too many PCR banks");
  const selections: PcrSelection[] = [];
  for (let i = 0; i < count; i++) {
    const hash = r.u16();
    const select = r.bytes(r.u8());
    const pcrs: number[] = [];
    select.forEach((byte, octet) => {
      for (let bit = 0; bit < 8; bit++) if (byte & (1 << bit)) pcrs.push(octet * 8 + bit);
    });
    selections.push({ hash, pcrs });
  }
  const pcrDigest = r.tpm2b();
  r.end();
  return { qualifiedSigner, extraData, clock, firmwareVersion, selections, pcrDigest };
}

/**
 * The hash `signature` (a TPMT_SIGNATURE) was made with, when it is `ak`'s
 * over `attest`, with SHA-256 or stronger, and in the AK's own scheme when it
 * is fixed to one. Otherwise, malformed signatures included, null.
 */
export function quoteSignatureHash(ak: TpmPublic, attest: Buffer, signature: Buffer): number | null {
  let alg: number, hash: number, sig: Buffer;
  try {
    const r = new Reader(signature);
    alg = r.u16();
    hash = r.u16();
    if (alg === TPM_ALG.RSASSA || alg === TPM_ALG.RSAPSS) {
      sig = r.tpm2b();
    } else if (alg === TPM_ALG.ECDSA) {
      const size = CURVES.get(ak.ecc?.curve ?? -1)?.size;
      if (!size) return null;
      sig = Buffer.concat([leftPad(r.tpm2b(), size), leftPad(r.tpm2b(), size)]);
    } else {
      return null;
    }
    r.end();
  } catch {
    return null;
  }
  if (hash === TPM_ALG.SHA1 || !HASHES.has(hash)) return null;
  if (ak.scheme && (ak.scheme.alg !== alg || ak.scheme.hash !== hash)) return null;
  const key = publicKeyOf(ak);
  const name = hashAlg(hash).name;
  if (alg === TPM_ALG.ECDSA) {
    if (!ak.ecc) return null;
    return verify(name, attest, { key, dsaEncoding: "ieee-p1363" }, sig) ? hash : null;
  }
  if (!ak.rsa) return null;
  const padding = alg === TPM_ALG.RSAPSS ? constants.RSA_PKCS1_PSS_PADDING : constants.RSA_PKCS1_PADDING;
  return verify(name, attest, { key, padding, saltLength: constants.RSA_PSS_SALTLEN_AUTO }, sig)
    ? hash
    : null;
}

/** KDFa (Part 1, 11.4.10.2): SP 800-108 counter mode with HMAC. */
export function kdfa(
  alg: number,
  key: Buffer,
  label: string,
  contextU: Buffer,
  contextV: Buffer,
  bits: number,
) {
  const { name } = hashAlg(alg);
  const out: Buffer[] = [];
  const labelBytes = Buffer.from(`${label}\0`, "latin1");
  for (let counter = 1, have = 0; have * 8 < bits; counter++) {
    const block = createHmac(name, key)
      .update(u32(counter))
      .update(labelBytes)
      .update(contextU)
      .update(contextV)
      .update(u32(bits))
      .digest();
    out.push(block);
    have += block.length;
  }
  return Buffer.concat(out).subarray(0, bits / 8);
}

/** KDFe (Part 1, 11.4.10.3): SP 800-56A concatenation KDF, for an ECDH secret. */
export function kdfe(alg: number, z: Buffer, label: string, partyU: Buffer, partyV: Buffer, bits: number) {
  const { name } = hashAlg(alg);
  const out: Buffer[] = [];
  const labelBytes = Buffer.from(`${label}\0`, "latin1");
  for (let counter = 1, have = 0; have * 8 < bits; counter++) {
    const block = createHash(name)
      .update(u32(counter))
      .update(z)
      .update(labelBytes)
      .update(partyU)
      .update(partyV)
      .digest();
    out.push(block);
    have += block.length;
  }
  return Buffer.concat(out).subarray(0, bits / 8);
}

/** TPM2_MakeCredential's two outputs, marshalled as TPM2_ActivateCredential takes them. */
export type Credential = {
  /** TPM2B_ID_OBJECT. */
  credentialBlob: Buffer;
  /** TPM2B_ENCRYPTED_SECRET. */
  secret: Buffer;
};

/**
 * TPM2_MakeCredential, off the TPM: wrap `credential` so that only the TPM
 * holding `ek`'s private key can unwrap it, and only for the object named
 * `objectName` loaded in that TPM. `ek` is a storage key: restricted, for
 * decryption, with an AES-CFB symmetric definition, as every TCG EK template is.
 */
export function makeCredential(ek: TpmPublic, objectName: Buffer, credential: Buffer): Credential {
  const { size: digestSize } = hashAlg(ek.nameAlg);
  if (!ek.symmetric || ek.symmetric.alg !== TPM_ALG.AES || ek.symmetric.mode !== TPM_ALG.CFB) {
    throw new TpmFormatError("the EK has no AES-CFB symmetric definition");
  }
  if (credential.length > digestSize) throw new TpmFormatError("credential longer than a digest");

  let seed: Buffer, secret: Buffer;
  if (ek.rsa) {
    seed = randomBytes(digestSize);
    secret = publicEncrypt(
      {
        key: publicKeyOf(ek),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: hashAlg(ek.nameAlg).name,
        oaepLabel: Buffer.from("IDENTITY\0", "latin1"),
      },
      seed,
    );
  } else {
    const curve = CURVES.get(ek.ecc!.curve);
    if (!curve) throw new TpmFormatError("unsupported curve");
    const ecdh = createECDH(curve.node);
    ecdh.generateKeys();
    const ekPoint = Buffer.concat([
      Buffer.from([4]),
      leftPad(ek.ecc!.x, curve.size),
      leftPad(ek.ecc!.y, curve.size),
    ]);
    const z = ecdh.computeSecret(ekPoint);
    const ephemeral = ecdh.getPublicKey();
    const ephX = ephemeral.subarray(1, 1 + curve.size);
    const ephY = ephemeral.subarray(1 + curve.size);
    seed = kdfe(ek.nameAlg, z, "IDENTITY", ephX, leftPad(ek.ecc!.x, curve.size), digestSize * 8);
    secret = Buffer.concat([tpm2b(ephX), tpm2b(ephY)]);
  }

  const symKey = kdfa(ek.nameAlg, seed, "STORAGE", objectName, Buffer.alloc(0), ek.symmetric.keyBits);
  const cipher = createCipheriv(`aes-${ek.symmetric.keyBits}-cfb`, symKey, Buffer.alloc(16));
  const encIdentity = Buffer.concat([cipher.update(tpm2b(credential)), cipher.final()]);
  const hmacKey = kdfa(ek.nameAlg, seed, "INTEGRITY", Buffer.alloc(0), Buffer.alloc(0), digestSize * 8);
  const integrity = createHmac(hashAlg(ek.nameAlg).name, hmacKey)
    .update(encIdentity)
    .update(objectName)
    .digest();
  return {
    credentialBlob: tpm2b(Buffer.concat([tpm2b(integrity), encIdentity])),
    secret: tpm2b(secret),
  };
}

/**
 * The EK public area the TCG EK Credential Profile's default templates make
 * for `key` (L-1: RSA 2048, L-2: ECC NIST P-256): what an EK certificate
 * certifies. Its name is the EK's name, which the AK's qualified name hangs off.
 */
export function ekPublicFor(key: KeyObject): TpmPublic {
  const jwk = key.export({ format: "jwk" });
  const head = Buffer.concat([
    u32(0x000300b2), // fixedTPM fixedParent sensitiveDataOrigin adminWithPolicy restricted decrypt
    tpm2b(EK_POLICY),
    u16(TPM_ALG.AES),
    u16(128),
    u16(TPM_ALG.CFB),
    u16(TPM_ALG.NULL), // scheme
  ]);
  let bytes: Buffer;
  if (jwk.kty === "RSA" && jwk.n && jwk.e) {
    const modulus = Buffer.from(jwk.n, "base64url");
    const exponent = Buffer.from(jwk.e, "base64url").readUIntBE(0, Buffer.from(jwk.e, "base64url").length);
    if (modulus.length !== 256) throw new TpmFormatError("not an RSA 2048 EK");
    bytes = Buffer.concat([
      u16(TPM_ALG.RSA),
      u16(TPM_ALG.SHA256),
      head,
      u16(2048),
      u32(exponent === 65537 ? 0 : exponent),
      tpm2b(modulus),
    ]);
  } else if (jwk.kty === "EC" && jwk.crv === "P-256" && jwk.x && jwk.y) {
    bytes = Buffer.concat([
      u16(TPM_ALG.ECC),
      u16(TPM_ALG.SHA256),
      head,
      u16(TPM_ECC_NIST_P256),
      u16(TPM_ALG.NULL), // kdf
      tpm2b(Buffer.from(jwk.x, "base64url")),
      tpm2b(Buffer.from(jwk.y, "base64url")),
    ]);
  } else {
    throw new TpmFormatError("not an RSA 2048 or ECC P-256 EK");
  }
  return readPublic(bytes);
}

/** The EK templates' authPolicy: PolicySecret(TPM_RH_ENDORSEMENT). */
const EK_POLICY = Buffer.from("837197674484b3f81a90cc8d46a5d724fd52d76e06520b64f2a1da1b331469aa", "hex");
