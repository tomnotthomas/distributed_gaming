// swiff-attest: swiff-hostd's attestation client (state.attestCommand), as
// /usr/libexec/swiff/swiff-attest in the image. It attests this boot with the
// TPM (attest.ts) to the server in swiff-hostd's config and prints the host
// certificate it earns: { "hostCert": ..., "expiresAt": ... }. A refusal is
// one line on stderr naming it, and exit status 1.

import { readFile } from "node:fs/promises";
import { attestBoot, EVENT_LOG, httpOrigin } from "./attest.ts";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./config.ts";
import { deviceTransport, Tpm } from "./tpm.ts";

try {
  const config = await loadConfig(process.env.SWIFF_HOSTD_CONFIG ?? DEFAULT_CONFIG_PATH);
  const transport = deviceTransport();
  try {
    const grant = await attestBoot({
      origin: httpOrigin(config.serverUrl),
      machineId: config.machineId,
      tpm: new Tpm(transport),
      eventLog: () => readFile(EVENT_LOG),
    });
    process.stdout.write(`${JSON.stringify({ hostCert: grant.hostCert, expiresAt: grant.expiresAt })}\n`);
  } finally {
    transport.close();
  }
} catch (error) {
  console.error(`swiff-attest: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
