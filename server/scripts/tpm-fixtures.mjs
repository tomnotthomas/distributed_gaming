// Records the TPM attestation fixtures the verifier's tests replay
// (server/src/test/fixtures/tpm-attestation.json), from a software TPM:
//
//   brew install swtpm gnutls        (Debian/Ubuntu: apt install swtpm swtpm-tools)
//   npm run build -w @swiff/server
//   node server/scripts/tpm-fixtures.mjs
//
// swtpm_setup manufactures the TPM: its RSA 2048 EK (template L-1) and an EK
// certificate from a throwaway two-level local CA, which the tests trust as a
// "TPM vendor". The script then makes an ECC P-256 EK (template L-2) itself and
// has the same CA certify it. It talks to swtpm with raw TPM 2.0 commands, so
// it needs no tpm2-tools, and it never shares code with the verifier to build
// what the TPM sees: only the server's own TPM2_MakeCredential output (from
// dist/), which the TPM must accept for activation to succeed at all.
//
// Each boot powers the TPM on (resetCount + 1), extends a synthetic UEFI event
// log into PCRs 0-7 and a synthetic Swiff OS boot into PCR 11 (UKI sections
// logged as systemd-stub does, then the boot phases, which are not), makes an
// AK under the EK, and quotes as swiff-hostd would: challenge, activation,
// TPM2_ActivateCredential, TPM2_Quote over SHA-256(nonce) of PCRs 0-7 and 11-13.
// Variant boots change one thing each: firmware, Secure Boot, the UKI, an extra
// boot application, no boot application at all, DMA protection, a credential
// (PCR 12) or a system extension (PCR 13) systemd-stub took from the ESP, the
// firmware in setup mode (no PK), and a key the owner enrolled in db verifying
// a DXE driver of theirs (PCRs 2 and 7).
//
// Every nonce is minted at one instant, `now` in the file, with ROOM_SECRET
// below, so tests replay them at that instant. Private keys stay in a
// temporary directory that is deleted at the end.

import { execFileSync, spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const { mintChallenge } = await import(join(dist, "access.js"));
const { trustStore } = await import(join(dist, "ek.js"));
const { memoryStore, tpmVerifier } = await import(join(dist, "tpm-verifier.js"));

export const ROOM_SECRET = "tpm-fixture-room-secret-at-least-32-chars";
/** The activation key is this label's SHA-256: the fixture records the label, not a key-shaped value. */
const ACTIVATION_KEY_LABEL = "tpm-fixture-activation-key";
const ACTIVATION_KEY = createHash("sha256").update(ACTIVATION_KEY_LABEL).digest();
const OUT = join(here, "..", "src", "test", "fixtures", "tpm-attestation.json");
const PORT = 23400 + Math.floor(Math.random() * 500);

const sha256 = (...parts) => {
  const h = createHash("sha256");
  for (const part of parts) h.update(part);
  return h.digest();
};
const sha1 = (data) => createHash("sha1").update(data).digest();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- TPM 2.0 marshalling (big-endian) ---------------------------------------

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
const b2 = (data) => Buffer.concat([u16(data.length), data]);
const EMPTY = Buffer.alloc(0);

const TPM_RS_PW = 0x40000009;
const TPM_RH_OWNER = 0x40000001;
const TPM_RH_NULL = 0x40000007;
const TPM_RH_ENDORSEMENT = 0x4000000b;
const RSA_EK_HANDLE = 0x81010001;
const RSA_EK_CERT_NV = 0x01c00002;
/** swtpm_setup also makes an ECC NIST P-384 EK (template H-3) with a certificate here. */
const P384_EK_CERT_NV = 0x01c00016;
const ALG = {
  RSA: 0x0001,
  SHA1: 0x0004,
  AES: 0x0006,
  SHA256: 0x000b,
  NULL: 0x0010,
  RSASSA: 0x0014,
  ECDSA: 0x0018,
  ECC: 0x0023,
  CFB: 0x0043,
};
const EK_POLICY = Buffer.from("837197674484b3f81a90cc8d46a5d724fd52d76e06520b64f2a1da1b331469aa", "hex");

/** A password session with an empty password. */
const pw = () => Buffer.concat([u32(TPM_RS_PW), b2(EMPTY), u8(0x01), b2(EMPTY)]);
/** A policy session, used once. */
const policy = (handle) => Buffer.concat([u32(handle), b2(EMPTY), u8(0x00), b2(EMPTY)]);

class Response {
  constructor(buf) {
    this.buf = buf;
    this.at = 10;
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
  bytes(n) {
    const v = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return Buffer.from(v);
  }
  b2() {
    return this.bytes(this.u16());
  }
}

/** One connection to swtpm's command channel: a command in, its response out. */
class Tpm {
  constructor(socket) {
    this.socket = socket;
    this.pending = Buffer.alloc(0);
    this.waiting = null;
    socket.on("data", (chunk) => {
      this.pending = Buffer.concat([this.pending, chunk]);
      if (this.waiting && this.pending.length >= 6 && this.pending.length >= this.pending.readUInt32BE(2)) {
        const size = this.pending.readUInt32BE(2);
        const response = this.pending.subarray(0, size);
        this.pending = this.pending.subarray(size);
        const { resolve } = this.waiting;
        this.waiting = null;
        resolve(response);
      }
    });
  }

  /** Run command `code` with `handles`, `auths` (session areas) and `params`; the response past its header. */
  async run(code, { handles = [], auths = [], params = EMPTY } = {}) {
    const body = Buffer.concat([
      ...handles.map(u32),
      ...(auths.length ? [u32(Buffer.concat(auths).length), ...auths] : []),
      params,
    ]);
    const tag = auths.length ? 0x8002 : 0x8001;
    if (process.env.DEBUG) console.error(`TPM command 0x${code.toString(16)}`);
    const command = Buffer.concat([u16(tag), u32(10 + body.length), u32(code), body]);
    const response = await new Promise((resolve) => {
      this.waiting = { resolve };
      this.socket.write(command);
    });
    const rc = response.readUInt32BE(6);
    if (rc !== 0) throw new Error(`TPM command 0x${code.toString(16)} failed: rc 0x${rc.toString(16)}`);
    return new Response(response);
  }

  /** A policy session satisfying the EK templates' PolicySecret(TPM_RH_ENDORSEMENT). */
  async ekPolicy() {
    const r = await this.run(0x176, {
      handles: [TPM_RH_NULL, TPM_RH_NULL],
      params: Buffer.concat([b2(Buffer.alloc(32, 7)), b2(EMPTY), u8(0x01), u16(ALG.NULL), u16(ALG.SHA256)]),
    });
    const session = r.u32();
    await this.run(0x151, {
      handles: [TPM_RH_ENDORSEMENT, session],
      auths: [pw()],
      params: Buffer.concat([b2(EMPTY), b2(EMPTY), b2(EMPTY), u32(0)]),
    });
    return session;
  }

  async readPublic(handle) {
    const r = await this.run(0x173, { handles: [handle] });
    return r.b2();
  }

  async nvRead(index) {
    const pub = await this.run(0x169, { handles: [index] });
    pub.u16(); // size
    pub.u32();
    pub.u16();
    pub.u32();
    pub.b2();
    const size = pub.u16();
    const out = [];
    for (let offset = 0; offset < size; offset += 512) {
      const r = await this.run(0x14e, {
        handles: [TPM_RH_OWNER, index],
        auths: [pw()],
        params: Buffer.concat([u16(Math.min(512, size - offset)), u16(offset)]),
      });
      r.u32(); // parameterSize
      out.push(r.b2());
    }
    return Buffer.concat(out);
  }

  /** TPM2_CreatePrimary in the endorsement hierarchy: the handle and the TPMT_PUBLIC. */
  async createPrimaryEk(template) {
    const r = await this.run(0x131, {
      handles: [TPM_RH_ENDORSEMENT],
      auths: [pw()],
      params: Buffer.concat([b2(Buffer.concat([b2(EMPTY), b2(EMPTY)])), b2(template), b2(EMPTY), u32(0)]),
    });
    const handle = r.u32();
    r.u32(); // parameterSize
    return { handle, public: r.b2() };
  }

  /**
   * An AK from `template`, loaded: its handle and TPMT_PUBLIC. Under the EK,
   * as swiff-hostd makes it, or (`parent` given) under that owner-hierarchy key.
   */
  async createAk(ek, template, parent = null) {
    const auth = async () => (parent ? pw() : policy(await this.ekPolicy()));
    const created = await this.run(0x153, {
      handles: [parent ?? ek],
      auths: [await auth()],
      params: Buffer.concat([b2(Buffer.concat([b2(EMPTY), b2(EMPTY)])), b2(template), b2(EMPTY), u32(0)]),
    });
    created.u32();
    const priv = created.b2();
    const pub = created.b2();
    const loaded = await this.run(0x157, {
      handles: [parent ?? ek],
      auths: [await auth()],
      params: Buffer.concat([b2(priv), b2(pub)]),
    });
    return { handle: loaded.u32(), public: pub };
  }

  /** A storage root key in the owner hierarchy: the usual parent of an AK made elsewhere than under the EK. */
  async createSrk() {
    const r = await this.run(0x131, {
      handles: [TPM_RH_OWNER],
      auths: [pw()],
      params: Buffer.concat([b2(Buffer.concat([b2(EMPTY), b2(EMPTY)])), b2(SRK), b2(EMPTY), u32(0)]),
    });
    return r.u32();
  }

  async activateCredential(ak, ek, credentialBlob, secret) {
    const r = await this.run(0x147, {
      handles: [ak, ek],
      auths: [pw(), policy(await this.ekPolicy())],
      params: Buffer.concat([credentialBlob, secret]),
    });
    r.u32();
    return r.b2();
  }

  async extend(pcr, digest) {
    await this.run(0x182, {
      handles: [pcr],
      auths: [pw()],
      params: Buffer.concat([u32(1), u16(ALG.SHA256), digest]),
    });
  }

  /** SHA-256 PCRs `pcrs`, by number, as hex. */
  async readPcrs(pcrs) {
    const values = {};
    for (let i = 0; i < pcrs.length; i += 8) {
      const chunk = pcrs.slice(i, i + 8);
      const r = await this.run(0x17e, { params: selection(chunk) });
      r.u32(); // update counter
      const banks = r.u32();
      for (let b = 0; b < banks; b++) {
        r.u16();
        r.bytes(r.bytes(1)[0]);
      }
      const count = r.u32();
      const read = [...chunk].sort((a, b) => a - b);
      for (let d = 0; d < count; d++) values[read[d]] = r.b2().toString("hex");
    }
    return values;
  }

  async quote(ak, qualifyingData, pcrs, scheme) {
    const r = await this.run(0x158, {
      handles: [ak],
      auths: [pw()],
      params: Buffer.concat([b2(qualifyingData), scheme, selection(pcrs)]),
    });
    const end = r.u32() + r.at; // the parameters end where the session's response begins
    const attest = r.b2();
    return { attest, signature: r.bytes(end - r.at) };
  }

  async flush(handle) {
    await this.run(0x165, { params: u32(handle) });
  }

  async shutdown() {
    await this.run(0x145, { params: u16(0) });
  }
}

/** A TPML_PCR_SELECTION of SHA-256 PCRs. */
function selection(pcrs) {
  const bits = Buffer.alloc(3);
  for (const pcr of pcrs) bits[pcr >> 3] |= 1 << (pcr & 7);
  return Buffer.concat([u32(1), u16(ALG.SHA256), u8(3), bits]);
}

const AK_ATTRIBUTES = 0x00050072; // fixedTPM fixedParent sensitiveDataOrigin userWithAuth restricted sign
const RSA_AK = Buffer.concat([
  u16(ALG.RSA),
  u16(ALG.SHA256),
  u32(AK_ATTRIBUTES),
  b2(EMPTY),
  u16(ALG.NULL),
  u16(ALG.RSASSA),
  u16(ALG.SHA256),
  u16(2048),
  u32(0),
  b2(EMPTY),
]);
const ECC_AK = Buffer.concat([
  u16(ALG.ECC),
  u16(ALG.SHA256),
  u32(AK_ATTRIBUTES),
  b2(EMPTY),
  u16(ALG.NULL),
  u16(ALG.ECDSA),
  u16(ALG.SHA256),
  u16(0x0003),
  u16(ALG.NULL),
  b2(EMPTY),
  b2(EMPTY),
]);
/** An RSA 2048 storage key: fixedTPM fixedParent sensitiveDataOrigin userWithAuth restricted decrypt. */
const SRK = Buffer.concat([
  u16(ALG.RSA),
  u16(ALG.SHA256),
  u32(0x00030072),
  b2(EMPTY),
  u16(ALG.AES),
  u16(128),
  u16(ALG.CFB),
  u16(ALG.NULL),
  u16(2048),
  u32(0),
  b2(EMPTY),
]);
/** TCG EK Credential Profile template L-2: ECC NIST P-256. */
const ECC_EK = Buffer.concat([
  u16(ALG.ECC),
  u16(ALG.SHA256),
  u32(0x000300b2),
  b2(EK_POLICY),
  u16(ALG.AES),
  u16(128),
  u16(ALG.CFB),
  u16(ALG.NULL),
  u16(0x0003),
  u16(ALG.NULL),
  b2(Buffer.alloc(32)),
  b2(Buffer.alloc(32)),
]);

// --- The synthetic firmware event log (little-endian) -----------------------

const le32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const le16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const le64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const EV = {
  POST_CODE: 0x1,
  SEPARATOR: 0x4,
  S_CRTM_VERSION: 0x8,
  IPL: 0xd,
  VARIABLE_DRIVER_CONFIG: 0x80000001,
  VARIABLE_BOOT: 0x80000002,
  BOOT_SERVICES_APPLICATION: 0x80000003,
  BOOT_SERVICES_DRIVER: 0x80000004,
  ACTION: 0x80000007,
  PLATFORM_FIRMWARE_BLOB: 0x80000008,
  VARIABLE_AUTHORITY: 0x800000e0,
};
const GLOBAL = Buffer.from("61dfe48bca93d211aa0d00e098032b8c", "hex");
const IMAGE_SECURITY = Buffer.from("cbb219d73a3d9645a3bcdad00e67656f", "hex");
const SHIM_LOCK = Buffer.from("50ab5d6046e00043abb63dd810dd8b23", "hex");

function variable(guid, name, value) {
  const unicode = Buffer.from(name, "utf16le");
  return Buffer.concat([guid, le64(name.length), le64(value.length), unicode, value]);
}

/** The Spec ID header, naming the SHA-1 and SHA-256 banks. */
function specId() {
  const data = Buffer.concat([
    Buffer.from("Spec ID Event03\0", "latin1"),
    le32(0),
    u8(0),
    u8(2),
    u8(0),
    u8(2),
    le32(2),
    le16(ALG.SHA1),
    le16(20),
    le16(ALG.SHA256),
    le16(32),
    u8(0),
  ]);
  return Buffer.concat([le32(0), le32(0x3), Buffer.alloc(20), le32(data.length), data]);
}

/** One TCG_PCR_EVENT2: digests of `measured` (the data itself unless the event hashes something else). */
function event2(pcr, type, data, measured = data) {
  return Buffer.concat([
    le32(pcr),
    le32(type),
    le32(2),
    le16(ALG.SHA1),
    sha1(measured),
    le16(ALG.SHA256),
    sha256(measured),
    le32(data.length),
    data,
  ]);
}

/**
 * The events of one boot. `boot` changes the firmware, Secure Boot, the boot
 * applications, the UKI, DMA protection, what systemd-stub takes from the
 * ESP, setup mode, and an owner's db key. Returns the log entries, each with the SHA-256 digest to extend, and the
 * PCR 11 boot phases (extended, not logged).
 */
function bootEvents({
  firmware = "firmware-v1",
  secureBoot = 1,
  extraApp = null,
  apps = true,
  uki = "swiff-os-1",
  dmaOff = false,
  credential = false,
  sysext = false,
  setupMode = false,
  ownerDbKey = false,
}) {
  const events = [];
  const add = (pcr, type, data, measured = data) => events.push({ pcr, type, data, measured });
  add(0, EV.S_CRTM_VERSION, Buffer.from("1.0\0", "utf16le"));
  add(
    0,
    EV.PLATFORM_FIRMWARE_BLOB,
    Buffer.concat([le64(0xff000000), le64(0x1000000)]),
    Buffer.from(firmware),
  );
  add(1, EV.VARIABLE_BOOT, variable(GLOBAL, "BootOrder", Buffer.from([1, 0, 0, 0])));
  add(2, EV.POST_CODE, Buffer.from("Option ROM"), Buffer.from("gpu-option-rom"));
  const db = ownerDbKey ? "microsoft-uefi-ca-2023,owner-db-key" : "microsoft-uefi-ca-2023";
  add(
    7,
    EV.VARIABLE_DRIVER_CONFIG,
    variable(GLOBAL, "SecureBoot", Buffer.from([setupMode ? 0 : secureBoot])),
  );
  add(7, EV.VARIABLE_DRIVER_CONFIG, variable(GLOBAL, "PK", Buffer.from(setupMode ? "" : "platform-key")));
  add(7, EV.VARIABLE_DRIVER_CONFIG, variable(GLOBAL, "KEK", Buffer.from("key-exchange-keys")));
  add(7, EV.VARIABLE_DRIVER_CONFIG, variable(IMAGE_SECURITY, "db", Buffer.from(db)));
  add(7, EV.VARIABLE_DRIVER_CONFIG, variable(IMAGE_SECURITY, "dbx", Buffer.from("revocations-2026")));
  if (dmaOff) add(7, EV.ACTION, Buffer.from("DMA Protection Disabled", "latin1"));
  if (ownerDbKey) {
    // A Driver#### load option: the driver is measured into PCR 2, the key that verified it into PCR 7.
    add(2, EV.BOOT_SERVICES_DRIVER, Buffer.from("\\EFI\\owner\\patch.efi"), Buffer.from("owner-dxe-patch"));
    add(7, EV.VARIABLE_AUTHORITY, variable(IMAGE_SECURITY, "db", Buffer.from("owner-db-key")));
  }
  for (let pcr = 0; pcr <= 7; pcr++) add(pcr, EV.SEPARATOR, Buffer.alloc(4));
  add(4, EV.ACTION, Buffer.from("Calling EFI Application from Boot Option", "latin1"));
  if (extraApp) add(4, EV.BOOT_SERVICES_APPLICATION, Buffer.from("\\EFI\\loader.efi"), Buffer.from(extraApp));
  if (apps)
    add(4, EV.BOOT_SERVICES_APPLICATION, Buffer.from("\\EFI\\BOOT\\BOOTX64.EFI"), Buffer.from("shim-15.8"));
  add(7, EV.VARIABLE_AUTHORITY, variable(IMAGE_SECURITY, "db", Buffer.from("microsoft-uefi-ca-2023")));
  // shim: the vendor certificate it verified the UKI with.
  add(7, EV.VARIABLE_AUTHORITY, variable(SHIM_LOCK, "Shim", Buffer.from("swiff-vendor-cert")));
  if (apps)
    add(4, EV.BOOT_SERVICES_APPLICATION, Buffer.from("\\EFI\\Linux\\swiff.efi"), Buffer.from(`uki:${uki}`));
  // systemd-stub: every UKI section's name, then its contents, into PCR 11.
  for (const section of [".linux", ".osrel", ".cmdline", ".initrd", ".uname"]) {
    const name = Buffer.from(`${section}\0`, "latin1");
    add(11, EV.IPL, name);
    add(11, EV.IPL, Buffer.from(section, "latin1"), Buffer.from(`${uki}${section}`));
  }
  // systemd-stub: what it takes from outside the UKI, from the ESP.
  if (credential)
    add(
      12,
      EV.IPL,
      Buffer.from("ssh.authorized_keys.root.cred\0", "latin1"),
      Buffer.from("ssh-ed25519 AAAA owner"),
    );
  if (sysext) add(13, EV.IPL, Buffer.from("owner-tools.sysext.raw\0", "latin1"), Buffer.from("owner-tools"));
  return { events, phases: ["enter-initrd", "leave-initrd", "sysinit", "ready"] };
}

const secureBootAuthorities = (boot) =>
  bootEvents(boot)
    .events.filter((e) => e.pcr === 7 && e.type === EV.VARIABLE_AUTHORITY)
    .map((e) => sha256(e.measured).toString("hex"));

const bootApplications = (boot) =>
  bootEvents(boot)
    .events.filter((e) => e.pcr === 4 && e.type === EV.BOOT_SERVICES_APPLICATION)
    .map((e) => sha256(e.measured).toString("hex"));

// --- swtpm -------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), "swiff-tpm-fixtures-"));
const ca = join(work, "ca");
execFileSync("mkdir", ["-p", ca, join(work, "tpm")]);
writeFileSync(
  join(ca, "swtpm-localca.conf"),
  `statedir = ${ca}\nsigningkey = ${ca}/signkey.pem\nissuercert = ${ca}/issuercert.pem\ncertserial = ${ca}/certserial\n`,
);
writeFileSync(
  join(ca, "swtpm-localca.options"),
  "--platform-manufacturer Swiff\n--platform-version 2.1\n--platform-model fixture\n",
);
const localca = execFileSync("sh", ["-c", "command -v swtpm_localca"]).toString().trim();
writeFileSync(
  join(ca, "swtpm_setup.conf"),
  `create_certs_tool = ${localca}\ncreate_certs_tool_config = ${ca}/swtpm-localca.conf\ncreate_certs_tool_options = ${ca}/swtpm-localca.options\n`,
);

/** Manufacture one TPM in `dir`: RSA 2048 EK, certified by the local CA. */
function manufacture(dir) {
  execFileSync(
    "swtpm_setup",
    [
      "--tpm2",
      "--tpmstate",
      dir,
      "--create-ek-cert",
      "--config",
      join(ca, "swtpm_setup.conf"),
      "--overwrite",
      "--pcr-banks",
      "sha256",
    ],
    { stdio: "ignore" },
  );
}

/** Power the TPM in `dir` on (resetCount + 1) for `work`, then shut it down in order. */
async function powerOn(dir, run) {
  const proc = spawn(
    "swtpm",
    [
      "socket",
      "--tpm2",
      "--tpmstate",
      `dir=${dir}`,
      "--server",
      `type=tcp,port=${PORT},bindaddr=127.0.0.1`,
      "--ctrl",
      `type=tcp,port=${PORT + 1},bindaddr=127.0.0.1`,
      "--flags",
      "not-need-init,startup-clear",
    ],
    { stdio: "ignore" },
  );
  let socket;
  for (let tries = 0; !socket; tries++) {
    try {
      socket = await new Promise((resolve, reject) => {
        const s = createConnection(PORT, "127.0.0.1", () => resolve(s));
        s.once("error", reject);
      });
    } catch (error) {
      if (tries > 50) throw error;
      await sleep(100);
    }
  }
  const tpm = new Tpm(socket);
  try {
    return await run(tpm);
  } finally {
    await tpm.shutdown().catch(() => {});
    socket.destroy();
    // Through the control channel: swtpm saves its state and exits.
    const exited = new Promise((resolve) => proc.once("exit", resolve));
    execFileSync("swtpm_ioctl", ["--tcp", `127.0.0.1:${PORT + 1}`, "-s"], { stdio: "ignore" });
    await exited;
  }
}

/** Measure `boot` into the TPM as firmware and systemd would. Returns the event log. */
async function measure(tpm, boot) {
  const { events, phases } = bootEvents(boot);
  const log = [specId()];
  for (const event of events) {
    await tpm.extend(event.pcr, sha256(event.measured));
    log.push(event2(event.pcr, event.type, event.data, event.measured));
  }
  for (const phase of phases) await tpm.extend(11, sha256(Buffer.from(phase)));
  return Buffer.concat(log);
}

const QUOTED = [0, 1, 2, 3, 4, 5, 6, 7, 11, 12, 13];
// A little ahead, so every certificate the local CA issues during the run is already valid then.
const NOW = Date.now() + 5 * 60 * 1000;
const roots = {
  root: () => readFileSync(join(ca, "swtpm-localca-rootca-cert.pem"), "utf8"),
  intermediate: () => readFileSync(join(ca, "issuercert.pem"), "utf8"),
};

/** One quote as swiff-hostd makes it: challenge, activation, ActivateCredential, Quote. */
async function attest(tpm, verifier, room, ek, ak, scheme, eventLog, nonce, pcrs = QUOTED) {
  const made = await verifier.activate({ room, nonce, akPublic: b2(ak.public).toString("base64"), now: NOW });
  if (!made.ok) throw new Error(`activation refused: ${made.reason}`);
  const activation = await tpm.activateCredential(
    ak.handle,
    ek,
    Buffer.from(made.activation.credentialBlob, "base64"),
    Buffer.from(made.activation.encryptedSecret, "base64"),
  );
  const { attest: quote, signature } = await tpm.quote(ak.handle, sha256(Buffer.from(nonce)), pcrs, scheme);
  return {
    nonce,
    evidence: {
      akPublic: b2(ak.public).toString("base64"),
      activation: activation.toString("base64"),
      quote: quote.toString("base64"),
      signature: signature.toString("base64"),
      pcrs: await tpm.readPcrs(pcrs),
      eventLog: eventLog.toString("base64"),
    },
  };
}

/**
 * Record machine `room` on the TPM in `dir`: `boots` in order, each a boot
 * variant and the labels of the quotes to take in it. A boot with no labels
 * powers the TPM on and off, as another system booting would.
 */
async function record(room, dir, ekOf, akTemplate, scheme, boots) {
  let ekCertificate;
  let verifier;
  const quotes = {};
  const pcr11 = {};
  for (const { boot, labels, sameNonce, akUnderSrk, pcrs } of boots) {
    await powerOn(dir, async (tpm) => {
      const ek = await ekOf(tpm);
      if (!verifier) {
        ekCertificate = ek.certificate;
        verifier = tpmVerifier({
          store: memoryStore(),
          roots: trustStore([
            { der: roots.root(), kind: "firmware" },
            { der: roots.intermediate(), kind: "firmware" },
          ]),
          policy: { releases: [] },
          activationKey: ACTIVATION_KEY,
        });
        const enrolled = await verifier.enroll({
          room,
          certificate: ekCertificate.toString("base64"),
          now: NOW,
        });
        if (!enrolled.ok) throw new Error(`EK refused: ${enrolled.reason}`);
      }
      if (!labels.length) return;
      const eventLog = await measure(tpm, boot);
      const ak = await tpm.createAk(ek.handle, akTemplate, akUnderSrk ? await tpm.createSrk() : null);
      const shared = sameNonce ? mintChallenge(ROOM_SECRET, room, 60, NOW) : null;
      for (const label of labels) {
        await sleep(30); // the TPM's clock moves on between quotes
        quotes[label] = await attest(
          tpm,
          verifier,
          room,
          ek.handle,
          ak,
          scheme,
          eventLog,
          shared ?? mintChallenge(ROOM_SECRET, room, 60, NOW),
          pcrs,
        );
        pcr11[label] = quotes[label].evidence.pcrs[11];
      }
      await tpm.flush(ak.handle);
    });
  }
  return { ekCertificate: ekCertificate.toString("base64"), quotes, pcr11 };
}

try {
  const rsaDir = join(work, "tpm");
  manufacture(rsaDir);
  const rsaEk = async (tpm) => ({ handle: RSA_EK_HANDLE, certificate: await tpm.nvRead(RSA_EK_CERT_NV) });

  const GOLDEN = {};
  const rsa = await record(
    "pc-rsa",
    rsaDir,
    rsaEk,
    RSA_AK,
    Buffer.concat([u16(ALG.RSASSA), u16(ALG.SHA256)]),
    [
      { boot: GOLDEN, labels: ["first", "same-boot"] },
      { boot: GOLDEN, labels: ["replay-earlier", "replay-later"], sameNonce: true },
      { boot: GOLDEN, labels: ["next-boot"] },
      { boot: GOLDEN, labels: [] }, // something else booted, and attested nothing
      { boot: GOLDEN, labels: ["gap"] },
      { boot: { uki: "tampered" }, labels: ["tampered-uki"] },
      { boot: { extraApp: "other-loader" }, labels: ["extra-boot-app"] },
      { boot: { apps: false }, labels: ["no-boot-apps"] },
      { boot: { credential: true }, labels: ["esp-credential"] },
      { boot: { sysext: true }, labels: ["esp-sysext"] },
      { boot: { setupMode: true }, labels: ["setup-mode"] },
      { boot: { ownerDbKey: true }, labels: ["owner-db-key"] },
      { boot: { secureBoot: 0 }, labels: ["secure-boot-off"] },
      { boot: { dmaOff: true }, labels: ["dma-off"] },
      { boot: { firmware: "firmware-v2" }, labels: ["firmware-v2", "firmware-v2-again"] },
      { boot: GOLDEN, labels: ["ak-under-srk"], akUnderSrk: true },
      { boot: GOLDEN, labels: ["without-pcr11"], pcrs: [0, 1, 2, 3, 4, 5, 6, 7, 12, 13] },
      { boot: GOLDEN, labels: ["without-pcr12-13"], pcrs: [0, 1, 2, 3, 4, 5, 6, 7, 11] },
    ],
  );

  // A genuine EK certificate for a template the verifier does not support.
  const p384 = await powerOn(rsaDir, (tpm) => tpm.nvRead(P384_EK_CERT_NV));

  // A second TPM, quoting with an ECC P-256 EK and AK.
  const eccDir = join(work, "tpm-ecc");
  execFileSync("mkdir", ["-p", eccDir]);
  manufacture(eccDir);
  let eccCertificate;
  const eccEk = async (tpm) => {
    const ek = await tpm.createPrimaryEk(ECC_EK);
    if (!eccCertificate) {
      // TPMT_PUBLIC of template L-2: the point is the last two TPM2Bs.
      const pub = ek.public;
      const y = pub.subarray(pub.length - 32);
      const x = pub.subarray(pub.length - 66, pub.length - 34);
      const certs = join(work, "ecc-cert");
      execFileSync("mkdir", ["-p", certs]);
      execFileSync(
        localca,
        [
          "--type",
          "ek",
          "--ek",
          `x=${x.toString("hex")},y=${y.toString("hex")}`,
          "--dir",
          certs,
          "--tpm-spec-family",
          "2.0",
          "--tpm-spec-level",
          "0",
          "--tpm-spec-revision",
          "183",
          "--tpm-manufacturer",
          "id:00001014",
          "--tpm-model",
          "swtpm",
          "--tpm-version",
          "id:20240125",
          "--tpm2",
          "--configfile",
          join(ca, "swtpm-localca.conf"),
          "--optsfile",
          join(ca, "swtpm-localca.options"),
        ],
        { stdio: "ignore" },
      );
      eccCertificate = readFileSync(join(certs, "ek.cert"));
    }
    return { handle: ek.handle, certificate: eccCertificate };
  };
  const ecc = await record(
    "pc-ecc",
    eccDir,
    eccEk,
    ECC_AK,
    Buffer.concat([u16(ALG.ECDSA), u16(ALG.SHA256)]),
    [{ boot: GOLDEN, labels: ["first"] }],
  );

  const fixture = {
    generatedBy: `server/scripts/tpm-fixtures.mjs with ${execFileSync("swtpm", ["--version"]).toString().split("\n")[0]}`,
    now: NOW,
    roomSecret: ROOM_SECRET,
    activationKeyLabel: ACTIVATION_KEY_LABEL,
    vendorRoot: roots.root(),
    vendorIntermediate: roots.intermediate(),
    release: {
      pcr11: rsa.pcr11.first,
      pcr12: rsa.quotes.first.evidence.pcrs[12],
      pcr13: rsa.quotes.first.evidence.pcrs[13],
      bootApplications: bootApplications(GOLDEN),
      uki: bootApplications(GOLDEN).slice(-1),
      secureBootAuthorities: secureBootAuthorities(GOLDEN),
    },
    tamperedPcr11: rsa.pcr11["tampered-uki"],
    p384EkCertificate: p384.toString("base64"),
    machines: {
      "pc-rsa": { ekCertificate: rsa.ekCertificate, quotes: rsa.quotes },
      "pc-ecc": { ekCertificate: ecc.ekCertificate, quotes: ecc.quotes },
    },
  };
  if (ecc.pcr11.first !== rsa.pcr11.first) throw new Error("the same boot measured differently on two TPMs");
  new X509Certificate(Buffer.from(rsa.ekCertificate, "base64"));
  writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${OUT}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
