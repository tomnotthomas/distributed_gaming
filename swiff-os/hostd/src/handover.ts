// The hand-over record's seal, Lanterel OS's side. The owner's Windows app
// (desktop/tpm-seal.cjs) never writes the provisioning to the disk in the
// clear: it encrypts it with a fresh AES-256 key and seals that key to this
// PC's TPM, under the storage root key at 0x81000001, with a policy only a
// Lanterel OS boot satisfies: PolicyAuthorize by Lanterel's PCR signing key,
// the key in the UKI's .pcrpkey section, whose signed PCR 11 policies are in
// its .pcrsig section (systemd-stub leaves both in /run, PCR_POLICY), then
// PolicyPCR of PCRs 12 and 13 at zero: a boot that took a command line,
// credentials, add-ons or system extensions from outside its UKI has them
// extended. The record's body (provision.ts) is
//
//   TPM2B  the sealed key's TPMT_PUBLIC
//   TPM2B  the sealed key's TPM2B_PRIVATE contents
//      12  AES-256-GCM nonce
//      16  AES-256-GCM tag
//       …  the payload's ciphertext, no AAD, to the end of the body
//
// Opening it, with the raw commands of tpm.ts: the TPM verifies Lanterel's
// signature over the policy for this boot's PCR 11, checks PCRs 12 and 13 are
// still zero, unseals the key, and the key decrypts the payload. Another PC, a
// cleared TPM, a boot Lanterel did not sign or one with extras cannot. The key and the payload are zeroed as soon as
// they are used, and no message quotes either.

import { createDecipheriv, createHash, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ProvisionError } from "./provision.ts";
import { PCR_POLICY } from "./state-key.ts";
import { ALG, b2, CC, deviceTransport, selection, Tpm, TpmError, u16, u32, type Transport } from "./tpm.ts";

/** Where Windows keeps its storage root key, the sealed key's parent. */
const SRK_HANDLE = 0x81000001;
/** The PCR whose signed values say a boot is Lanterel OS's: the UKI's, measured by systemd-stub. */
const PCR = 11;
/** The PCRs a boot's extras from outside its UKI go to, zero in a Lanterel OS boot. */
const EXTRAS = [12, 13];
/** userWithAuth decrypt sign: what systemd gives the key it loads to check a PCR policy's signature. */
const SIGNING_ATTRIBUTES = 0x00060040;
const AES_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Tries at the unseal while systemd-pcrphase moves PCR 11 on under it. */
const TRIES = 3;

const DAMAGED = "the provisioning record is damaged";
const NOT_SIGNED = "this boot is not one Lanterel signed, so the provisioning record cannot be opened";
const REFUSED =
  "the TPM refuses to open the provisioning record (another PC, a cleared TPM, or not a Lanterel OS boot)";
const CHANGED = "the provisioning record was changed after it was sealed";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest();

/** The record's body, its parts. */
export type SealedBody = { public: Buffer; private: Buffer; nonce: Buffer; tag: Buffer; ciphertext: Buffer };

/** The parts of a record's body (views into it). Throws ProvisionError for a body cut short. */
export function parseBody(body: Buffer): SealedBody {
  let at = 0;
  const take = (n: number) => {
    if (n <= 0 || at + n > body.length) throw new ProvisionError(DAMAGED);
    at += n;
    return body.subarray(at - n, at);
  };
  const tpm2b = () => take(take(2).readUInt16BE());
  const pub = tpm2b();
  const priv = tpm2b();
  const nonce = take(NONCE_BYTES);
  const tag = take(TAG_BYTES);
  return { public: pub, private: priv, nonce, tag, ciphertext: take(body.length - at) };
}

/** A key as the TPM names it: its TPMT_PUBLIC and its name. */
export type SigningKey = { public: Buffer; name: Buffer };

/**
 * Lanterel's PCR signing key (PEM) as the TPM loads it to check a signature:
 * the TPMT_PUBLIC systemd gives it, and its name, `000B || SHA256(TPMT_PUBLIC)`.
 */
export function signingKey(pem: string): SigningKey {
  const key = createPublicKey(pem);
  const { modulusLength: bits, publicExponent: exponent } = key.asymmetricKeyDetails ?? {};
  if (key.asymmetricKeyType !== "rsa" || !bits || !exponent || exponent > 0xffffffffn) {
    throw new ProvisionError("Lanterel's PCR signing key is not an RSA key");
  }
  const modulus = Buffer.from(key.export({ format: "jwk" }).n!, "base64url");
  const pub = Buffer.concat([
    u16(ALG.RSA),
    u16(ALG.SHA256),
    u32(SIGNING_ATTRIBUTES),
    b2(Buffer.alloc(0)),
    u16(ALG.NULL),
    u16(ALG.NULL),
    u16(bits),
    u32(exponent === 65537n ? 0 : Number(exponent)),
    b2(Buffer.concat([Buffer.alloc(bits / 8 - modulus.length), modulus])),
  ]);
  return { public: pub, name: Buffer.concat([u16(ALG.SHA256), sha256(pub)]) };
}

/**
 * The sealed key's authPolicy: PolicyAuthorize by the key named `name`, with
 * an empty policyRef, then PolicyPCR of SHA-256 PCRs 12 and 13 at zero.
 */
export function authorizedPolicy(name: Buffer): Buffer {
  const authorized = sha256(sha256(Buffer.concat([Buffer.alloc(32), u32(CC.PolicyAuthorize), name])));
  return sha256(
    Buffer.concat([
      authorized,
      u32(CC.PolicyPCR),
      selection(EXTRAS),
      sha256(Buffer.alloc(32 * EXTRAS.length)),
    ]),
  );
}

/** The PolicyPCR digest of SHA-256 PCR 11 at `value`: what Lanterel signs for each phase of its boot. */
export function pcrPolicy(value: Buffer): Buffer {
  return sha256(Buffer.concat([Buffer.alloc(32), u32(CC.PolicyPCR), selection([PCR]), sha256(value)]));
}

type PcrSignature = { pcrs: number[]; pol: string; sig: string };

/**
 * The signature over `policy` among the SHA-256 PCR 11 entries of a
 * tpm2-pcr-signature.json (systemd-measure's), or ProvisionError when Lanterel
 * signed none for it.
 */
export function signatureFor(signatureJson: string, policy: Buffer): Buffer {
  let entries: unknown;
  try {
    entries = (JSON.parse(signatureJson) as { sha256?: unknown }).sha256;
  } catch {
    throw new ProvisionError(NOT_SIGNED);
  }
  const entry = (Array.isArray(entries) ? entries : []).find(
    (e: Partial<PcrSignature> | null): e is PcrSignature =>
      Array.isArray(e?.pcrs) &&
      e.pcrs.length === 1 &&
      e.pcrs[0] === PCR &&
      typeof e.pol === "string" &&
      typeof e.sig === "string" &&
      e.pol.toLowerCase() === policy.toString("hex"),
  );
  if (!entry) throw new ProvisionError(NOT_SIGNED);
  return Buffer.from(entry.sig, "base64");
}

/** Lanterel's PCR signing key and its signed PCR policies, as systemd-stub left them. */
export type PcrPolicyFiles = { publicKeyPem: string; signatureJson: string };

/**
 * The payload in `body`, unsealed by `tpm` and decrypted. Throws
 * ProvisionError in plain words when it cannot be opened; flushes whatever it
 * loaded into the TPM.
 */
export async function unsealBody(tpm: Tpm, body: SealedBody, files: PcrPolicyFiles): Promise<Buffer> {
  const key = signingKey(files.publicKeyPem);
  for (let tries = 1; ; tries++) {
    const pcr = await pcr11(tpm);
    let aesKey: Buffer;
    try {
      aesKey = await unsealKey(tpm, body, key, pcrPolicy(pcr), files.signatureJson);
    } catch (cause) {
      if (!(cause instanceof TpmError)) throw cause;
      // systemd-pcrphase extends PCR 11 as the boot goes on: with its new value, again.
      if (tries < TRIES && !(await pcr11(tpm)).equals(pcr)) continue;
      throw new ProvisionError(REFUSED);
    }
    return decrypt(body, aesKey);
  }
}

/** SHA-256 PCR 11's value. */
async function pcr11(tpm: Tpm): Promise<Buffer> {
  return Buffer.from((await tpm.readPcrs([PCR]))[PCR]!, "hex");
}

/** The sealed AES key, unsealed under `policy`, the PCR 11 policy Lanterel signed. */
async function unsealKey(
  tpm: Tpm,
  body: SealedBody,
  key: SigningKey,
  policy: Buffer,
  signatureJson: string,
): Promise<Buffer> {
  const signature = signatureFor(signatureJson, policy);
  const loaded: number[] = [];
  let session: number | null = null;
  try {
    const verifier = await tpm.loadExternal(key.public);
    loaded.push(verifier.handle);
    if (!verifier.name.equals(key.name)) throw new Error("the TPM names the PCR signing key otherwise");
    const ticket = await tpm.verifySignature(verifier.handle, sha256(policy), signature);
    const sealed = await tpm.load(SRK_HANDLE, body.private, body.public);
    loaded.push(sealed);
    session = await tpm.policySession();
    await tpm.policyPcr(session, [PCR]);
    await tpm.policyAuthorize(session, policy, key.name, ticket);
    await tpm.policyPcr(session, EXTRAS);
    const aesKey = await tpm.unseal(sealed, session);
    // Used once: the TPM flushed it.
    session = null;
    return aesKey;
  } finally {
    for (const handle of session === null ? loaded : [session, ...loaded]) {
      await tpm.flush(handle).catch(() => {});
    }
  }
}

/** The payload `body` holds, decrypted with `aesKey`, which is zeroed. Throws ProvisionError when it was changed. */
export function decrypt(body: SealedBody, aesKey: Buffer): Buffer {
  try {
    if (aesKey.length !== AES_KEY_BYTES) throw new ProvisionError(DAMAGED);
    const decipher = createDecipheriv("aes-256-gcm", aesKey, body.nonce, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(body.tag);
    const payload = decipher.update(body.ciphertext);
    try {
      decipher.final();
    } catch {
      payload.fill(0);
      throw new ProvisionError(CHANGED);
    }
    return payload;
  } finally {
    aesKey.fill(0);
  }
}

/**
 * Open a record's body on this PC's TPM, with the PCR signing key and signed
 * policies systemd-stub left for this boot: the payload, or ProvisionError.
 */
export function tpmOpen(policy: typeof PCR_POLICY = PCR_POLICY, connect: () => Transport = deviceTransport) {
  return async (body: Buffer): Promise<Buffer> => {
    const sealed = parseBody(body);
    let files: PcrPolicyFiles;
    try {
      files = {
        publicKeyPem: await readFile(policy.publicKey, "utf8"),
        signatureJson: await readFile(policy.signature, "utf8"),
      };
    } catch {
      // The UKI carries both: without them this is no boot Lanterel signed.
      throw new ProvisionError(NOT_SIGNED);
    }
    const transport = connect();
    try {
      return await unsealBody(new Tpm(transport), sealed, files);
    } finally {
      transport.close();
    }
  };
}
