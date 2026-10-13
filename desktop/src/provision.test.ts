// @vitest-environment node
// The provisioning record's payload, as swiff-os/hostd/src/provision.ts reads
// it: the machine's fields, and the Wi-Fi only on a PC that goes online over it.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { provisionRecord, RECORD_BYTES, RECORD_VERSION, wifiProblem } from "../provision.cjs";

const MACHINE = {
  serverUrl: "wss://lanterel.example",
  machineId: "gaming-pc-1",
  machineKey: "the-machine-key-of-gaming-pc-1",
};

/** The payload Lanterel OS reads from a record: checked against the header's length and hash. */
function payloadOf(record: Buffer): unknown {
  expect(record.length).toBe(RECORD_BYTES);
  expect(record.subarray(0, 8).toString("ascii")).toBe("SWIFFPRV");
  expect(record.readUInt32BE(8)).toBe(RECORD_VERSION);
  const payload = record.subarray(48, 48 + record.readUInt32BE(12));
  expect(createHash("sha256").update(payload).digest().equals(record.subarray(16, 48))).toBe(true);
  return JSON.parse(payload.toString("utf8"));
}

describe("provisionRecord", () => {
  it("carries no wifi on a PC with a network cable: the payload is as before", () => {
    expect(payloadOf(provisionRecord(MACHINE))).toEqual(MACHINE);
    expect(RECORD_VERSION).toBe(1);
  });

  it("carries the Wi-Fi's name, security and password on a Wi-Fi PC, in the same record", () => {
    const wifi = { ssid: "Brammiball", security: "sae" as const, passphrase: "correct horse 15" };
    expect(payloadOf(provisionRecord({ ...MACHINE, wifi }))).toEqual({ ...MACHINE, wifi });
    const psk = { ssid: "Büro & Gäste", security: "psk" as const, passphrase: "  spaces count  " };
    expect(payloadOf(provisionRecord({ ...MACHINE, wifi: psk }))).toEqual({ ...MACHINE, wifi: psk });
    const hex = { ssid: "Home", security: "psk" as const, passphrase: "0123456789ABCDEF".repeat(4) };
    expect(payloadOf(provisionRecord({ ...MACHINE, wifi: hex }))).toEqual({ ...MACHINE, wifi: hex });
  });

  it("carries no password for an open network, and nothing beyond the three fields", () => {
    const open = { ssid: "Café", security: "open" as const };
    expect(payloadOf(provisionRecord({ ...MACHINE, wifi: { ...open, extra: 1 } as typeof open }))).toEqual({
      ...MACHINE,
      wifi: open,
    });
  });

  it("refuses a Wi-Fi Lanterel OS cannot join, never quoting its password", () => {
    const secret = "hunter2-but-longer";
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
      expect(() => provisionRecord({ ...MACHINE, wifi } as never)).toThrow(problem!);
    }
    expect(wifiProblem(null)).not.toBeNull();
  });
});
