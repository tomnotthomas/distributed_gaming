// The Wi-Fi test's provisioning record: sealed to the VM's TPM by the owner's
// app's own encoder (desktop/provision.cjs provisionRecord, tpm-seal.cjs),
// with the Wi-Fi network in its payload when given. Test tooling: never shipped.
//
//   node wifi-provision.cjs <out> <host:port> <certificate> < payload.json
//
// The payload comes on stdin, never in argv; the record is written 0600.

const crypto = require("node:crypto");
const fs = require("node:fs");
const { provisionRecord } = require("../../desktop/provision.cjs");
const { sealKey, sealPolicy } = require("../../desktop/tpm-seal.cjs");
const { makeSrk, tcpTransport } = require("../../desktop/vm/swtpm.cjs");

async function main() {
  const [out, at, certFile] = process.argv.slice(2);
  const [, host, port] = /^(.+):(\d+)$/.exec(at ?? "") ?? [];
  if (!out || !host || !certFile)
    throw new Error("usage: wifi-provision.cjs <out> <host:port> <certificate>");
  const payload = JSON.parse(fs.readFileSync(0, "utf8"));
  const policy = sealPolicy(new crypto.X509Certificate(fs.readFileSync(certFile)).publicKey);
  const tpm = await tcpTransport(host, Number(port));
  try {
    await makeSrk(tpm);
    const record = await provisionRecord(payload, (key) => sealKey(tpm, policy, key));
    fs.writeFileSync(out, record, { mode: 0o600 });
  } finally {
    tpm.close();
  }
}

main().catch((error) => {
  console.error(`wifi-provision: ${error.message}`);
  process.exit(1);
});
