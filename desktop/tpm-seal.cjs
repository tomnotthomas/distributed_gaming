// Sealing the hand-over record's key (provision.cjs) to this PC's TPM, so only
// a Lanterel OS boot of this PC can open it: TPM2_Create under Windows' storage
// root key, of a sealed object whose one policy is PolicyAuthorize by the key
// that signs Lanterel OS's PCR 11 policies (the image set's Secure Boot
// certificate's: mkosi signs the UKI's .pcrsig with it). Only a boot whose PCR
// 11 that key signed can unseal it (swiff-os/hostd/src/handover.ts), and the
// sealed object never leaves this TPM in a form another TPM can load.
//
// Raw TPM 2.0 commands with Node's crypto, as Lanterel OS's side
// (swiff-os/hostd/src/tpm.ts). Names follow the TCG TPM 2.0 Library
// specification: every structure is big-endian, every TPM2B a 16-bit size
// followed by that many bytes. The transport is Windows' TPM Base Services
// (rental-worker.cjs), or swtpm in the tests.

const crypto = require("node:crypto");

/** Where Windows persists its storage root key, and systemd on Lanterel OS reuses it. */
const SRK_HANDLE = 0x81000001;

const ALG = { RSA: 0x0001, KEYEDHASH: 0x0008, SHA256: 0x000b, NULL: 0x0010, ECC: 0x0023 };
const CC = { Create: 0x153, PolicyAuthorize: 0x16a, ReadPublic: 0x173 };
const TPM_RS_PW = 0x40000009;
/** userWithAuth decrypt sign: the signing key as both sides load it. */
const SIGNING_ATTRIBUTES = 0x00060040;
/** fixedTPM fixedParent adminWithPolicy noDA: userWithAuth clear, so only the policy unseals it. */
const SEALED_ATTRIBUTES = 0x00000492;
/** fixedTPM restricted decrypt: what makes an object a storage key. */
const STORAGE_ATTRIBUTES = 0x00000002 | 0x00010000 | 0x00020000;
/** TPM_RC_YIELDED, TPM_RC_TESTING and TPM_RC_RETRY: warnings that ask for the same command again. */
const RETRY = new Set([0x908, 0x90a, 0x922]);
const RETRIES = 50;
const EMPTY = Buffer.alloc(0);

const NO_SRK =
  "Windows has not set up this PC's TPM for Lanterel OS yet: check in Windows Security, Device security, that the security processor is ready, then go live again.";

const u8 = (n) => Buffer.from([n]);
const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
/** A TPM2B: the bytes with their 16-bit size in front. */
const b2 = (data) => Buffer.concat([u16(data.length), data]);
const sha256 = (...parts) => crypto.createHash("sha256").update(Buffer.concat(parts)).digest();

/** A password session with an empty password. */
const pw = () => Buffer.concat([u32(TPM_RS_PW), b2(EMPTY), u8(0x01), b2(EMPTY)]);

/** A TPM error naming the command and its response code, which it keeps as `rc`. */
function tpmError(code, rc) {
  return Object.assign(new Error(`TPM command 0x${code.toString(16)} failed: rc 0x${rc.toString(16)}`), {
    rc,
  });
}

/** A reader over a response, from just past its 10-byte header. */
function reader(response) {
  let at = 10;
  const bytes = (n) => {
    if (at + n > response.length) throw new Error("The TPM's response was cut short.");
    const v = Buffer.from(response.subarray(at, at + n));
    at += n;
    return v;
  };
  return {
    bytes,
    u16: () => bytes(2).readUInt16BE(),
    u32: () => bytes(4).readUInt32BE(),
    b2: () => bytes(bytes(2).readUInt16BE()),
  };
}

/**
 * Run command `code` on `transport` with `handles`, one password session when
 * `auth`, and `params`; resolves with a reader past the response's header.
 * The command is zeroed once sent: it may carry a secret in `params`.
 */
async function run(transport, code, { handles = [], auth = false, params = EMPTY } = {}) {
  const session = auth ? Buffer.concat([u32(pw().length), pw()]) : EMPTY;
  const size = 10 + handles.length * 4 + session.length + params.length;
  const command = Buffer.alloc(size);
  command.writeUInt16BE(auth ? 0x8002 : 0x8001, 0);
  command.writeUInt32BE(size, 2);
  command.writeUInt32BE(code, 6);
  handles.forEach((h, i) => command.writeUInt32BE(h, 10 + i * 4));
  session.copy(command, 10 + handles.length * 4);
  params.copy(command, size - params.length);
  try {
    for (let tries = 1; ; tries++) {
      const response = await transport.send(command);
      if (response.length < 10) throw new Error(`TPM command 0x${code.toString(16)} had a short response.`);
      const rc = response.readUInt32BE(6);
      if (rc === 0) return reader(response);
      // The TPM did not start the command: send it again.
      if (!RETRY.has(rc) || tries >= RETRIES) throw tpmError(code, rc);
      await new Promise((resolve) => setTimeout(resolve, 20 * tries));
    }
  } finally {
    command.fill(0);
  }
}

/** The RSA public key in `key`: a KeyObject, PEM, or an X.509 certificate's DER. */
function publicKeyOf(key) {
  if (key instanceof crypto.KeyObject) return key;
  if (Buffer.isBuffer(key)) return new crypto.X509Certificate(key).publicKey;
  return crypto.createPublicKey(key);
}

/**
 * The signing key's TPMT_PUBLIC and Name, from an RSA public key (a
 * KeyObject, PEM, or an X.509 certificate's DER), exactly as Lanterel OS
 * builds it to load the key from its PEM.
 */
function signingKey(key) {
  const object = publicKeyOf(key);
  if (object.asymmetricKeyType !== "rsa")
    throw new Error("The key that signs Lanterel OS's boots is not an RSA key.");
  const { n, e } = object.export({ format: "jwk" });
  const bits = object.asymmetricKeyDetails.modulusLength;
  const modulus = Buffer.alloc(Math.ceil(bits / 8));
  const given = Buffer.from(n, "base64url");
  given.copy(modulus, modulus.length - given.length);
  const exponent = Buffer.from(e, "base64url");
  if (exponent.length > 4)
    throw new Error("The key that signs Lanterel OS's boots has an exponent a TPM cannot take.");
  const value = exponent.readUIntBE(0, exponent.length);
  const pub = Buffer.concat([
    u16(ALG.RSA),
    u16(ALG.SHA256),
    u32(SIGNING_ATTRIBUTES),
    b2(EMPTY),
    u16(ALG.NULL),
    u16(ALG.NULL),
    u16(bits),
    u32(value === 65537 ? 0 : value),
    b2(modulus),
  ]);
  return { public: pub, name: Buffer.concat([u16(ALG.SHA256), sha256(pub)]) };
}

/** The sealed object's authPolicy: PolicyAuthorize by `key` (as signingKey takes it), with an empty policyRef. */
function sealPolicy(key) {
  const { name } = signingKey(key);
  return sha256(sha256(Buffer.alloc(32), u32(CC.PolicyAuthorize), name));
}

/** The sealed object's TPMT_PUBLIC template, under `policy`. */
const sealTemplate = (policy) =>
  Buffer.concat([
    u16(ALG.KEYEDHASH),
    u16(ALG.SHA256),
    u32(SEALED_ATTRIBUTES),
    b2(policy),
    u16(ALG.NULL),
    b2(EMPTY),
  ]);

/** Whether a TPMT_PUBLIC is a storage key: RSA or ECC, fixedTPM, restricted and decrypt. */
function isStorageKey(pub) {
  if (pub.length < 8) return false;
  const type = pub.readUInt16BE(0);
  const attributes = pub.readUInt32BE(4);
  return (type === ALG.RSA || type === ALG.ECC) && (attributes & STORAGE_ATTRIBUTES) === STORAGE_ATTRIBUTES;
}

/** Whether `rc` is TPM_RC_HANDLE: no object at the handle asked for. */
const noObject = (rc) => (rc & 0xbf) === 0x8b;

/**
 * Seal `key` (32 bytes) under `policy` (sealPolicy's) to the TPM on
 * `transport`, beneath the storage root key Windows persisted: its TPMT_PUBLIC
 * and TPM2B_PRIVATE contents, which only that TPM can load.
 */
async function sealKey(transport, policy, key) {
  if (!Buffer.isBuffer(policy) || policy.length !== 32) throw new Error("A seal policy is 32 bytes.");
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("A sealed key is 32 bytes.");
  let srk;
  try {
    srk = (await run(transport, CC.ReadPublic, { handles: [SRK_HANDLE] })).b2();
  } catch (error) {
    throw noObject(error.rc) ? new Error(NO_SRK) : error;
  }
  if (!isStorageKey(srk)) throw new Error(NO_SRK);
  // inSensitive (userAuth empty, data the key), inPublic, outsideInfo, creationPCR: built in one
  // buffer, so the key is in no other and that one is zeroed.
  const template = sealTemplate(policy);
  const params = Buffer.alloc(2 + 2 + 2 + key.length + 2 + template.length + 2 + 4);
  let at = params.writeUInt16BE(2 + 2 + key.length, 0);
  at = params.writeUInt16BE(0, at);
  at = params.writeUInt16BE(key.length, at);
  at += key.copy(params, at);
  at = params.writeUInt16BE(template.length, at);
  template.copy(params, at);
  try {
    const r = await run(transport, CC.Create, { handles: [SRK_HANDLE], auth: true, params });
    r.u32(); // parameterSize
    const priv = r.b2();
    return { public: r.b2(), private: priv };
  } finally {
    params.fill(0);
  }
}

module.exports = { SRK_HANDLE, b2, run, sealKey, sealPolicy, signingKey };
