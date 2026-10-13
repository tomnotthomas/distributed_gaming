// @vitest-environment node
// The provisioning record's payload, as swiff-os/hostd/src/provision.ts reads
// it once the TPM opens it: the machine's fields, and the Wi-Fi only on a PC
// that goes online over it, sealed with them and never in the clear.

import { describe, expect, it } from "vitest";
import { provisionRecord, wifiProblem, type Provisioning } from "../provision.cjs";
import { sealKey, sealPolicy } from "../tpm-seal.cjs";
import { fakeTpm } from "./test/fakeTpm";
import { GOLDEN_CERT } from "./test/goldenKey";

const MACHINE = {
  serverUrl: "wss://lanterel.example",
  machineId: "gaming-pc-1",
  machineKey: "the-machine-key-of-gaming-pc-1",
};

/** The record for `provisioning`, sealed to a fake TPM, and the payload that TPM opens from it. */
async function sealed(provisioning: Provisioning) {
  const tpm = fakeTpm();
  const transport = tpm.transport();
  const record = await provisionRecord(provisioning, (key) =>
    sealKey(transport, sealPolicy(GOLDEN_CERT), key),
  );
  return { record, payload: tpm.open(record) };
}

describe("provisionRecord", () => {
  it("carries no wifi on a PC with a network cable: the payload is as before", async () => {
    expect((await sealed(MACHINE)).payload).toEqual(MACHINE);
  });

  it("seals the Wi-Fi's name, security and password on a Wi-Fi PC in the same record, never in the clear", async () => {
    const sae = { ssid: "Brammiball", security: "sae" as const, passphrase: "correct horse 15" };
    const psk = { ssid: "Büro & Gäste", security: "psk" as const, passphrase: "  spaces count  " };
    const hex = { ssid: "Home", security: "psk" as const, passphrase: "0123456789ABCDEF".repeat(4) };
    for (const wifi of [sae, psk, hex]) {
      const { record, payload } = await sealed({ ...MACHINE, wifi });
      expect(payload).toEqual({ ...MACHINE, wifi });
      expect(record.includes(Buffer.from(wifi.passphrase))).toBe(false);
      expect(record.includes(Buffer.from(wifi.ssid))).toBe(false);
    }
  });

  it("carries no password for an open network, and nothing beyond the three fields", async () => {
    const open = { ssid: "Café", security: "open" as const };
    expect((await sealed({ ...MACHINE, wifi: { ...open, extra: 1 } as typeof open })).payload).toEqual({
      ...MACHINE,
      wifi: open,
    });
  });

  it("refuses a Wi-Fi Lanterel OS cannot join before the TPM is asked, never quoting its password", async () => {
    const secret = "hunter2-but-longer";
    let asked = 0;
    const seal = async () => {
      asked++;
      return { public: Buffer.alloc(48), private: Buffer.alloc(126) };
    };
    const refused = [
      { ssid: "", security: "psk", passphrase: secret },
      { ssid: "x".repeat(33), security: "psk", passphrase: secret },
      { ssid: "Bram\u0007ball", security: "psk", passphrase: secret },
      { ssid: "Home", security: "sae", passphrase: "a".repeat(64) },
      { ssid: "Office", security: "wpa2-enterprise", passphrase: secret },
      { ssid: "Café", security: "open", passphrase: secret },
      { ssid: "Home", security: "psk" },
      { ssid: "Home", security: "sae", passphrase: "short" },
      { ssid: "Home", security: "psk", passphrase: `${secret}\n` },
    ];
    for (const wifi of refused) {
      const problem = wifiProblem(wifi);
      expect(problem).toMatch(/Wi-Fi/);
      expect(problem).not.toContain(secret);
      await expect(provisionRecord({ ...MACHINE, wifi } as never, seal)).rejects.toThrow(problem!);
    }
    expect(asked).toBe(0);
    expect(wifiProblem(null)).not.toBeNull();
  });
});
