// The Wi-Fi test's provisioning record: sealed to the VM's TPM as the owner's
// app seals it (desktop/provision.cjs provisionRecord, tpm-seal.cjs), with the
// payload as given, so it can carry the Wi-Fi network the app's encoder on
// this branch does not hand over yet. Test tooling: never shipped.
//
//   node wifi-provision.cjs <out> <host:port> <certificate> < payload.json
//
// The payload comes on stdin, never in argv; the record is written 0600.

const crypto = require("node:crypto");
const fs = require("node:fs");
const { RECORD_BYTES, RECORD_MAGIC, RECORD_VERSION } = require("../../desktop/provision.cjs");
const { b2, sealKey, sealPolicy } = require("../../desktop/tpm-seal.cjs");
const { makeSrk, tcpTransport } = require("../../desktop/vm/swtpm.cjs");

/** The magic, version, length and SHA-256 before the body. */
const HEADER_BYTES = 48;

async function main() {
  const [out, at, certFile] = process.argv.slice(2);
  const [, host, port] = /^(.+):(\d+)$/.exec(at ?? "") ?? [];
  if (!out || !host || !certFile)
    throw new Error("usage: wifi-provision.cjs <out> <host:port> <certificate>");
  const payload = Buffer.from(JSON.stringify(JSON.parse(fs.readFileSync(0, "utf8"))), "utf8");
  const policy = sealPolicy(new crypto.X509Certificate(fs.readFileSync(certFile)).publicKey);
  const key = crypto.randomBytes(32);
  const tpm = await tcpTransport(host, Number(port));
  try {
    await makeSrk(tpm);
    const sealed = await sealKey(tpm, policy, key);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const body = Buffer.concat([
      b2(sealed.public),
      b2(sealed.private),
      nonce,
      cipher.getAuthTag(),
      ciphertext,
    ]);
    const record = Buffer.alloc(RECORD_BYTES);
    RECORD_MAGIC.copy(record, 0);
    record.writeUInt32BE(RECORD_VERSION, 8);
    record.writeUInt32BE(body.length, 12);
    crypto.createHash("sha256").update(body).digest().copy(record, 16);
    body.copy(record, HEADER_BYTES);
    fs.writeFileSync(out, record, { mode: 0o600 });
  } finally {
    tpm.close();
    key.fill(0);
    payload.fill(0);
  }
}

main().catch((error) => {
  console.error(`wifi-provision: ${error.message}`);
  process.exit(1);
});
