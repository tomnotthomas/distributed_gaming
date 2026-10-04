// The TPM attestation verifier against quotes a software TPM (swtpm) really
// made: fixtures/tpm-attestation.json, recorded by server/scripts/tpm-fixtures.mjs.
// The fixture's local CA stands in for a TPM vendor. Every quote was made over
// a nonce minted at `fixture.now`, so the tests judge them at that instant.

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { accessFromEnv, mintChallenge, type Access } from "../access.js";
import { createApi } from "../api.js";
import { attestationFromEnv, createAttestation, insecureDevVerifier } from "../attestation.js";
import { Platform } from "../platform.js";
import { BootPolicyError, readBootPolicy, signBootPolicy, type BootPolicy } from "../boot-policy.js";
import { bootFacts, parseEventLog, replay } from "../eventlog.js";
import { trustStore, verifyEkCertificate, type TpmKind } from "../ek.js";
import { migrate } from "../schema.js";
import {
  databaseStore,
  FIRMWARE_COOLDOWN_SECONDS,
  memoryStore,
  tpmVerifier,
  type AttestationStore,
  type SecurityEvent,
} from "../tpm-verifier.js";
import type { TpmEvidence } from "../protocol.js";
import fixture from "./fixtures/tpm-attestation.json" with { type: "json" };
import { testDatabase } from "./db.js";

type Recorded = { nonce: string; evidence: TpmEvidence };
type Room = "pc-rsa" | "pc-ecc";

const NOW = fixture.now;
const ACTIVATION_KEY = createHash("sha256").update(fixture.activationKeyLabel).digest();
const RELEASE = {
  name: "swiff-os test",
  pcr11: [fixture.release.pcr11],
  pcr12: [fixture.release.pcr12],
  pcr13: [fixture.release.pcr13],
  bootApplications: fixture.release.bootApplications,
  uki: fixture.release.uki,
  secureBootAuthorities: fixture.release.secureBootAuthorities,
  iommu: true,
};
const POLICY: BootPolicy = { releases: [RELEASE] };
const recorded = (room: Room, label: string): Recorded => {
  const quotes = fixture.machines[room].quotes as Record<string, Recorded>;
  const quote = quotes[label];
  assert.ok(quote, `no fixture quote ${room}/${label}`);
  return quote;
};
const vendor = (kind: TpmKind = "firmware") =>
  trustStore([
    { der: fixture.vendorRoot, kind },
    { der: fixture.vendorIntermediate, kind },
  ]);

/** A verifier with `room`'s EK registered (unless `enrolled` is false). */
async function verifierFor(
  room: Room,
  {
    kind = "firmware" as TpmKind,
    enrolled = true,
    store = memoryStore() as AttestationStore,
    policy = POLICY,
    securityLog = (() => {}) as (event: SecurityEvent) => void,
  } = {},
) {
  const verifier = tpmVerifier({
    store,
    roots: vendor(kind),
    policy,
    activationKey: ACTIVATION_KEY,
    securityLog,
  });
  if (enrolled) {
    const result = await verifier.enroll({
      room,
      certificate: fixture.machines[room].ekCertificate,
      now: NOW,
    });
    assert.deepEqual(result, { ok: true });
  }
  return verifier;
}

/** Judge recorded quote `label` of `room`, with any evidence fields replaced. */
function judge(
  verifier: Awaited<ReturnType<typeof verifierFor>>,
  room: Room,
  label: string,
  { evidence = {} as Partial<TpmEvidence>, nonce = recorded(room, label).nonce, now = NOW } = {},
) {
  return verifier.verify({ room, nonce, evidence: { ...recorded(room, label).evidence, ...evidence }, now });
}

/** `base64` with byte `at` (from the end when negative) flipped. */
function flip(base64: string, at: number): string {
  const bytes = Buffer.from(base64, "base64");
  const i = at < 0 ? bytes.length + at : at;
  bytes[i] = bytes[i]! ^ 0x01;
  return bytes.toString("base64");
}

const GOOD_FACTS = { uefi: true, secureBoot: true, tpm: "firmware", ekCertificate: true, iommu: true };

describe("the TPM verifier accepts", () => {
  it("an untouched Swiff OS boot quoted by a firmware TPM with an RSA EK", async () => {
    const verifier = await verifierFor("pc-rsa");
    assert.deepEqual(await judge(verifier, "pc-rsa", "first"), { ok: true, facts: GOOD_FACTS });
  });

  it("the same with an ECC P-256 EK and AK", async () => {
    const verifier = await verifierFor("pc-ecc");
    assert.deepEqual(await judge(verifier, "pc-ecc", "first"), { ok: true, facts: GOOD_FACTS });
  });

  it("a TPM whose vendor is a discrete-chip vendor as a discrete TPM", async () => {
    const verifier = await verifierFor("pc-rsa", { kind: "discrete" });
    const verdict = await judge(verifier, "pc-rsa", "first");
    assert.ok(verdict.ok);
    assert.equal(verdict.facts.tpm, "discrete");
  });

  it("quotes whose TPM counters go forward: the same boot, the next boot, and after a gap", async () => {
    const verifier = await verifierFor("pc-rsa");
    for (const label of ["first", "same-boot", "replay-later", "next-boot", "gap"]) {
      const verdict = await judge(verifier, "pc-rsa", label);
      assert.ok(verdict.ok, `${label}: ${JSON.stringify(verdict)}`);
    }
  });

  it("states what the event log says: Secure Boot off, pre-boot DMA protection off", async () => {
    const off = await judge(await verifierFor("pc-rsa"), "pc-rsa", "secure-boot-off");
    assert.ok(off.ok);
    assert.equal(off.facts.secureBoot, false);
    const dma = await judge(await verifierFor("pc-rsa"), "pc-rsa", "dma-off");
    assert.ok(dma.ok);
    assert.equal(dma.facts.iommu, false);
  });

  it("takes the IOMMU from the release: one that boots without it proves none", async () => {
    const verifier = await verifierFor("pc-rsa", { policy: { releases: [{ ...RELEASE, iommu: false }] } });
    const verdict = await judge(verifier, "pc-rsa", "first");
    assert.ok(verdict.ok);
    assert.equal(verdict.facts.iommu, false);
  });
});

describe("the TPM verifier refuses", () => {
  it("a machine with no EK registered", async () => {
    const verifier = await verifierFor("pc-rsa", { enrolled: false });
    assert.deepEqual(await judge(verifier, "pc-rsa", "first"), { ok: false, reason: "unknown-ek" });
  });

  it("to register an EK no vendor root vouches for, and a registered one it stopped trusting", async () => {
    // Registered while the vendor was trusted, judged after it no longer is.
    const store = memoryStore();
    await verifierFor("pc-rsa", { store });
    const strangers = tpmVerifier({
      store,
      roots: trustStore([]),
      policy: POLICY,
      activationKey: ACTIVATION_KEY,
    });
    const certificate = fixture.machines["pc-rsa"].ekCertificate;
    assert.deepEqual(await strangers.enroll({ room: "pc-rsa", certificate, now: NOW }), {
      ok: false,
      reason: "ek-untrusted",
    });
    assert.deepEqual(await judge(strangers, "pc-rsa", "first"), { ok: false, reason: "ek-untrusted" });
  });

  it("to register an EK of a template it cannot activate an AK for", async () => {
    const verifier = await verifierFor("pc-rsa", { enrolled: false });
    const certificate = fixture.p384EkCertificate;
    assert.deepEqual(await verifier.enroll({ room: "pc-rsa", certificate, now: NOW }), {
      ok: false,
      reason: "ek-unsupported",
    });
  });

  it("a quote from a TPM other than the registered EK's", async () => {
    // pc-ecc's EK registered for pc-rsa: pc-rsa's TPM never activated an AK for it.
    const verifier = tpmVerifier({
      store: memoryStore(),
      roots: vendor(),
      policy: POLICY,
      activationKey: ACTIVATION_KEY,
    });
    await verifier.enroll({
      room: "pc-rsa",
      certificate: fixture.machines["pc-ecc"].ekCertificate,
      now: NOW,
    });
    assert.deepEqual(await judge(verifier, "pc-rsa", "first"), { ok: false, reason: "ak-not-activated" });
  });

  it("an activation the TPM did not recover", async () => {
    const verifier = await verifierFor("pc-rsa");
    const activation = flip(recorded("pc-rsa", "first").evidence.activation, 0);
    assert.deepEqual(await judge(verifier, "pc-rsa", "first", { evidence: { activation } }), {
      ok: false,
      reason: "ak-not-activated",
    });
  });

  it("an AK that is not a key at all, when activated or judged", async () => {
    const verifier = await verifierFor("pc-ecc");
    // TPM2B_PUBLIC of an ECC P-256 AK ends with the point's x and y, 32 bytes each with its size.
    const akPublic = flip(recorded("pc-ecc", "first").evidence.akPublic, -40);
    assert.deepEqual(await verifier.activate({ room: "pc-ecc", nonce: "n", akPublic, now: NOW }), {
      ok: false,
      reason: "ak-unsuitable",
    });
    assert.deepEqual(await judge(verifier, "pc-ecc", "first", { evidence: { akPublic } }), {
      ok: false,
      reason: "ak-unsuitable",
    });
  });

  it("an AK that is not a restricted signing key, and an AK made outside the EK", async () => {
    const verifier = await verifierFor("pc-rsa");
    // TPM2B_PUBLIC: size (2), type (2), nameAlg (2), then objectAttributes; restricted is bit 16.
    const ak = Buffer.from(recorded("pc-rsa", "first").evidence.akPublic, "base64");
    ak[7] = ak[7]! & ~0x01;
    assert.deepEqual(
      await judge(verifier, "pc-rsa", "first", { evidence: { akPublic: ak.toString("base64") } }),
      {
        ok: false,
        reason: "ak-unsuitable",
      },
    );
    // Activated by the EK's TPM, but a child of a storage key in the owner
    // hierarchy, where the quote's counters are obfuscated.
    assert.deepEqual(await judge(verifier, "pc-rsa", "ak-under-srk"), {
      ok: false,
      reason: "ak-not-under-ek",
    });
  });

  it("a quote the AK did not sign", async () => {
    const verifier = await verifierFor("pc-rsa");
    for (const evidence of [
      { quote: flip(recorded("pc-rsa", "first").evidence.quote, -40) },
      { signature: flip(recorded("pc-rsa", "first").evidence.signature, -1) },
      // Another boot's AK: a key of the same TPM, but not the one that signed.
      { akPublic: recorded("pc-rsa", "next-boot").evidence.akPublic },
    ]) {
      const verdict = await judge(verifier, "pc-rsa", "first", { evidence });
      assert.deepEqual(verdict, { ok: false, reason: "bad-signature" }, Object.keys(evidence)[0]);
    }
  });

  it("a quote over another nonce", async () => {
    const verifier = await verifierFor("pc-rsa");
    const nonce = recorded("pc-rsa", "same-boot").nonce;
    assert.deepEqual(await judge(verifier, "pc-rsa", "first", { nonce }), {
      ok: false,
      reason: "wrong-nonce",
    });
  });

  it("PCR values that are not the ones quoted", async () => {
    const verifier = await verifierFor("pc-rsa");
    const { pcrs } = recorded("pc-rsa", "first").evidence;
    // The tampered UKI's quote, claiming the golden PCR 11.
    const tampered = recorded("pc-rsa", "tampered-uki").evidence.pcrs;
    for (const [label, lie] of [
      ["first", { ...pcrs, 0: "00".repeat(32) }],
      ["tampered-uki", { ...tampered, 11: fixture.release.pcr11 }],
    ] as const) {
      assert.deepEqual(await judge(verifier, "pc-rsa", label, { evidence: { pcrs: lie } }), {
        ok: false,
        reason: "pcr-digest-mismatch",
      });
    }
  });

  it("a quote that leaves out PCR 11, or PCRs 12 and 13", async () => {
    const verifier = await verifierFor("pc-rsa");
    for (const label of ["without-pcr11", "without-pcr12-13"]) {
      assert.deepEqual(
        await judge(verifier, "pc-rsa", label),
        { ok: false, reason: "pcrs-not-quoted" },
        label,
      );
    }
  });

  it("an event log that does not replay to the quoted PCRs", async () => {
    const verifier = await verifierFor("pc-rsa");
    const { eventLog } = recorded("pc-rsa", "secure-boot-off").evidence;
    const log = Buffer.from(recorded("pc-rsa", "first").evidence.eventLog, "base64");
    // The first event after the header is PCR 0's; its SHA-256 digest follows
    // its PCR, type, digest count, and the SHA-1 digest with both algorithm ids.
    const firstDigest = 32 + log.readUInt32LE(28) + 4 + 4 + 4 + 2 + 20 + 2;
    // The golden boot's quote with the log of a boot that had Secure Boot off,
    // a log with PCR 0's first digest changed, and one cut short.
    for (const lie of [
      eventLog,
      flip(log.toString("base64"), firstDigest),
      log.subarray(0, log.length - 10).toString("base64"),
    ]) {
      assert.deepEqual(await judge(verifier, "pc-rsa", "first", { evidence: { eventLog: lie } }), {
        ok: false,
        reason: "event-log-mismatch",
      });
    }
  });

  it("a boot of anything but a signed release, or through anything but its own boot chain", async () => {
    const verifier = await verifierFor("pc-rsa");
    assert.deepEqual(await judge(verifier, "pc-rsa", "tampered-uki"), {
      ok: false,
      reason: "unknown-boot-image",
    });
    assert.deepEqual(await judge(verifier, "pc-rsa", "extra-boot-app"), {
      ok: false,
      reason: "unknown-boot-application",
    });
    const none = await verifierFor("pc-rsa", { policy: { releases: [] } });
    assert.deepEqual(await judge(none, "pc-rsa", "first"), { ok: false, reason: "unknown-boot-image" });
  });

  it("a boot that measured no boot application, or did not end in the release's UKI", async () => {
    // The golden PCR 11 with nothing in PCR 4: whatever ran extended PCR 11 itself.
    assert.deepEqual(await judge(await verifierFor("pc-rsa"), "pc-rsa", "no-boot-apps"), {
      ok: false,
      reason: "unknown-boot-application",
    });
    const shim = fixture.release.bootApplications[0]!;
    const shimLast = await verifierFor("pc-rsa", { policy: { releases: [{ ...RELEASE, uki: [shim] }] } });
    assert.deepEqual(await judge(shimLast, "pc-rsa", "first"), {
      ok: false,
      reason: "unknown-boot-application",
    });
  });

  it("a signed release booted with a credential or an extension from the ESP", async () => {
    const verifier = await verifierFor("pc-rsa");
    for (const label of ["esp-credential", "esp-sysext"]) {
      assert.deepEqual(
        await judge(verifier, "pc-rsa", label),
        { ok: false, reason: "unknown-boot-extras" },
        label,
      );
    }
    // A release that declares the values takes them.
    const { pcrs } = recorded("pc-rsa", "esp-credential").evidence;
    const declared = await verifierFor("pc-rsa", {
      policy: { releases: [{ ...RELEASE, pcr12: [...RELEASE.pcr12, pcrs["12"]!] }] },
    });
    assert.ok((await judge(declared, "pc-rsa", "esp-credential")).ok);
  });

  it("a replayed quote: the same one again, or an older one over the same nonce", async () => {
    const verifier = await verifierFor("pc-rsa");
    assert.ok((await judge(verifier, "pc-rsa", "replay-later")).ok);
    assert.deepEqual(await judge(verifier, "pc-rsa", "replay-later"), {
      ok: false,
      reason: "replayed-quote",
    });
    assert.deepEqual(await judge(verifier, "pc-rsa", "replay-earlier"), {
      ok: false,
      reason: "replayed-quote",
    });
  });

  it("a quote from before the last one it accepted: the TPM's counters went back", async () => {
    const verifier = await verifierFor("pc-rsa");
    assert.ok((await judge(verifier, "pc-rsa", "next-boot")).ok);
    assert.deepEqual(await judge(verifier, "pc-rsa", "first"), { ok: false, reason: "counter-rollback" });
  });

  it("malformed evidence, without throwing", async () => {
    const verifier = await verifierFor("pc-rsa");
    for (const evidence of [
      { quote: undefined },
      { quote: "not base64!" },
      { pcrs: { 0: "zz" } },
      { quote: Buffer.from("hello").toString("base64") },
    ] as Partial<TpmEvidence>[]) {
      const verdict = await judge(verifier, "pc-rsa", "first", { evidence });
      assert.equal(verdict.ok, false, JSON.stringify(evidence));
    }
    for (const evidence of [null, 7, "x", []]) {
      assert.deepEqual(await verifier.verify({ room: "pc-rsa", nonce: "n", evidence, now: NOW }), {
        ok: false,
        reason: "malformed-evidence",
      });
    }
  });
});

describe("Secure Boot in PCR 7", () => {
  it("refuses a key the owner enrolled in db outright: no cooldown ever trusts it", async () => {
    const events: SecurityEvent[] = [];
    const store = memoryStore();
    const verifier = await verifierFor("pc-rsa", { store, securityLog: (event) => events.push(event) });
    assert.ok((await judge(verifier, "pc-rsa", "first")).ok);
    const refused = { ok: false, reason: "secure-boot-untrusted" };
    assert.deepEqual(await judge(verifier, "pc-rsa", "owner-db-key"), refused);
    const muchLater = { now: NOW + 2 * FIRMWARE_COOLDOWN_SECONDS * 1000 };
    assert.deepEqual(await judge(verifier, "pc-rsa", "owner-db-key", muchLater), refused);
    assert.equal((await store.get("pc-rsa"))?.pendingFirmware, null);
    // Both refusals logged, each naming the one authority the release does not list.
    assert.deepEqual(
      events.map((event) =>
        event.event === "secure-boot-untrusted"
          ? [event.machine, event.configured, event.unknownAuthorities.length]
          : event.event,
      ),
      [
        ["pc-rsa", true, 1],
        ["pc-rsa", true, 1],
      ],
    );
  });

  it("refuses firmware in setup mode, with no platform key enrolled", async () => {
    const events: SecurityEvent[] = [];
    const verifier = await verifierFor("pc-rsa", { securityLog: (event) => events.push(event) });
    assert.deepEqual(await judge(verifier, "pc-rsa", "setup-mode"), {
      ok: false,
      reason: "secure-boot-untrusted",
    });
    assert.deepEqual(events, [
      { event: "secure-boot-untrusted", machine: "pc-rsa", configured: false, unknownAuthorities: [] },
    ]);
  });

  it("takes only the authorities the release lists: shim's vendor certificate among them", async () => {
    const [microsoft] = fixture.release.secureBootAuthorities;
    const verifier = await verifierFor("pc-rsa", {
      policy: { releases: [{ ...RELEASE, secureBootAuthorities: [microsoft!] }] },
    });
    assert.deepEqual(await judge(verifier, "pc-rsa", "first"), {
      ok: false,
      reason: "secure-boot-untrusted",
    });
  });
});

describe("firmware trust on first use", () => {
  it("takes the first firmware it sees as the machine's", async () => {
    const verifier = await verifierFor("pc-rsa");
    assert.ok((await judge(verifier, "pc-rsa", "firmware-v2")).ok);
  });

  it("refuses changed firmware until the same new values have cooled down, and logs both", async () => {
    const events: SecurityEvent[] = [];
    const store = memoryStore();
    const verifier = await verifierFor("pc-rsa", { store, securityLog: (event) => events.push(event) });
    assert.ok((await judge(verifier, "pc-rsa", "first")).ok);
    const baseline = (await store.get("pc-rsa"))!.firmware!;
    const later = (seconds: number) => ({ now: NOW + seconds * 1000 });
    assert.deepEqual(await judge(verifier, "pc-rsa", "firmware-v2"), {
      ok: false,
      reason: "firmware-changed",
    });
    assert.deepEqual(
      await judge(verifier, "pc-rsa", "firmware-v2-again", later(FIRMWARE_COOLDOWN_SECONDS - 1)),
      {
        ok: false,
        reason: "firmware-changed",
      },
    );
    const cooled = await judge(verifier, "pc-rsa", "firmware-v2-again", later(FIRMWARE_COOLDOWN_SECONDS));
    assert.ok(cooled.ok);
    const presented = (await store.get("pc-rsa"))!.firmware!;
    assert.notDeepEqual(presented, baseline);
    const changed = { event: "firmware-changed", machine: "pc-rsa", baseline, presented };
    assert.deepEqual(events, [
      changed,
      changed,
      { event: "firmware-accepted", machine: "pc-rsa", previous: baseline, accepted: presented },
    ]);
  });

  it("starts the cool-down again when the firmware changes once more", async () => {
    const store = memoryStore();
    const verifier = await verifierFor("pc-rsa", { store });
    assert.ok((await judge(verifier, "pc-rsa", "first")).ok);
    assert.deepEqual(await judge(verifier, "pc-rsa", "firmware-v2"), {
      ok: false,
      reason: "firmware-changed",
    });
    const record = await store.get("pc-rsa");
    assert.equal(record?.pendingFirmware?.since, NOW);
    // The machine's own firmware again clears nothing it has not earned.
    assert.ok((await judge(verifier, "pc-rsa", "secure-boot-off")).ok);
    assert.equal((await store.get("pc-rsa"))?.pendingFirmware, null);
  });

  const enroll = (verifier: Awaited<ReturnType<typeof verifierFor>>, room: Room, now = NOW) =>
    verifier.enroll({ room: "pc-rsa", certificate: fixture.machines[room].ekCertificate, now });

  it("lets a cleared TPM attest again once the EK is registered again, after the cooldown", async () => {
    const verifier = await verifierFor("pc-rsa");
    assert.ok((await judge(verifier, "pc-rsa", "next-boot")).ok);
    // A cleared TPM's counters are back below the last accepted quote's.
    assert.deepEqual(await judge(verifier, "pc-rsa", "first"), { ok: false, reason: "counter-rollback" });
    assert.deepEqual(await enroll(verifier, "pc-rsa"), { ok: true });
    assert.deepEqual(await judge(verifier, "pc-rsa", "first"), { ok: false, reason: "firmware-changed" });
    const later = { now: NOW + FIRMWARE_COOLDOWN_SECONDS * 1000 };
    assert.ok((await judge(verifier, "pc-rsa", "same-boot", later)).ok);
    assert.deepEqual(await judge(verifier, "pc-rsa", "first", later), {
      ok: false,
      reason: "replayed-quote",
    });
  });

  it("keeps the machine's firmware across another EK, and holds it for the cooldown", async () => {
    const store = memoryStore();
    const verifier = await verifierFor("pc-rsa", { store });
    assert.ok((await judge(verifier, "pc-rsa", "first")).ok);
    const baseline = (await store.get("pc-rsa"))?.firmware;
    assert.ok(baseline);
    // Another EK certificate, and then the first one back: never a first use again.
    assert.deepEqual(await enroll(verifier, "pc-ecc"), { ok: true });
    let record = await store.get("pc-rsa");
    assert.deepEqual(record?.firmware, baseline);
    assert.equal(record?.counters, null);
    assert.equal(record?.reenrolledAt, NOW);
    assert.deepEqual(await enroll(verifier, "pc-rsa"), { ok: true });
    assert.deepEqual(await judge(verifier, "pc-rsa", "firmware-v2"), {
      ok: false,
      reason: "firmware-changed",
    });
    assert.deepEqual(await judge(verifier, "pc-rsa", "next-boot"), { ok: false, reason: "firmware-changed" });
    record = await store.get("pc-rsa");
    assert.deepEqual(record?.firmware, baseline);
    // A change already cooling down still waits out the cooldown from the registration.
    const later = (seconds: number) => ({ now: NOW + seconds * 1000 });
    assert.deepEqual(await enroll(verifier, "pc-rsa", NOW + 1000), { ok: true });
    assert.deepEqual(await judge(verifier, "pc-rsa", "next-boot", later(FIRMWARE_COOLDOWN_SECONDS)), {
      ok: false,
      reason: "firmware-changed",
    });
    assert.ok((await judge(verifier, "pc-rsa", "gap", later(FIRMWARE_COOLDOWN_SECONDS + 1))).ok);
    assert.equal((await store.get("pc-rsa"))?.reenrolledAt, null);
  });

  it("logs an EK registered again over a firmware baseline", async () => {
    const events: SecurityEvent[] = [];
    const verifier = await verifierFor("pc-rsa", { securityLog: (event) => events.push(event) });
    assert.deepEqual(await enroll(verifier, "pc-rsa"), { ok: true });
    assert.deepEqual(events, []);
    assert.ok((await judge(verifier, "pc-rsa", "first")).ok);
    await enroll(verifier, "pc-rsa");
    await enroll(verifier, "pc-ecc");
    assert.deepEqual(events, [
      { event: "ek-registered-again", machine: "pc-rsa", sameEk: true },
      { event: "ek-registered-again", machine: "pc-rsa", sameEk: false },
    ]);
  });

  it("starts a machine that never attested from first use, whatever EK it registers", async () => {
    const store = memoryStore();
    const verifier = await verifierFor("pc-rsa", { store });
    assert.deepEqual(await enroll(verifier, "pc-rsa"), { ok: true });
    assert.equal((await store.get("pc-rsa"))?.reenrolledAt, null);
    assert.ok((await judge(verifier, "pc-rsa", "first")).ok);
  });
});

describe("the machine attestation table", () => {
  it("keeps what the verifier keeps, across a restart", async () => {
    const db = await testDatabase();
    try {
      await migrate(db);
      const verifier = await verifierFor("pc-rsa", { store: databaseStore(db) });
      assert.ok((await judge(verifier, "pc-rsa", "first")).ok);
      assert.deepEqual(await judge(verifier, "pc-rsa", "firmware-v2"), {
        ok: false,
        reason: "firmware-changed",
      });
      // A new verifier on the same table, as after a restart.
      const restarted = tpmVerifier({
        store: databaseStore(db),
        roots: vendor(),
        policy: POLICY,
        activationKey: ACTIVATION_KEY,
      });
      assert.deepEqual(await judge(restarted, "pc-rsa", "first"), { ok: false, reason: "replayed-quote" });
      const record = await databaseStore(db).get("pc-rsa");
      assert.equal(record?.pendingFirmware?.since, NOW);
      assert.equal(record?.ek?.certificate.toString("base64"), fixture.machines["pc-rsa"].ekCertificate);
      assert.equal(typeof record?.counters?.clock, "string");
      assert.equal(record?.reenrolledAt, null);
      await restarted.enroll({
        room: "pc-rsa",
        certificate: fixture.machines["pc-rsa"].ekCertificate,
        now: NOW,
      });
      const reenrolled = await databaseStore(db).get("pc-rsa");
      assert.equal(reenrolled?.reenrolledAt, NOW);
      assert.equal(reenrolled?.counters, null);
      assert.deepEqual(reenrolled?.firmware, record?.firmware);
      assert.equal(await databaseStore(db).get("pc-unknown"), null);
    } finally {
      await db.close();
    }
  });
});

describe("attestation with the TPM verifier", () => {
  const access: Access = accessFromEnv({
    ROOM_SECRET: fixture.roomSecret,
    MACHINE_KEYS: `pc-rsa:${"a".repeat(64)},pc-ecc:${"b".repeat(64)}`,
  });
  const attestation = async (kind: TpmKind = "firmware") =>
    createAttestation({ access, verifier: await verifierFor("pc-rsa", { kind }), attestedOnly: true });

  it("mints a host certificate at the TPM's tier", async () => {
    const quote = recorded("pc-rsa", "first");
    const firmware = await (await attestation()).attest("pc-rsa", quote.nonce, quote.evidence, NOW);
    assert.ok(firmware.ok);
    assert.equal(firmware.grant.tier, "attested");
    const discrete = await (await attestation("discrete")).attest("pc-rsa", quote.nonce, quote.evidence, NOW);
    assert.ok(discrete.ok);
    assert.equal(discrete.grant.tier, "attested-discrete-tpm");
  });

  it("names the verifier's reason, and holds a machine with Secure Boot off below the floor", async () => {
    const a = await attestation();
    const tampered = recorded("pc-rsa", "tampered-uki");
    assert.deepEqual(await a.attest("pc-rsa", tampered.nonce, tampered.evidence, NOW), {
      ok: false,
      status: 403,
      body: { error: "attestation-refused", reason: "evidence-rejected", detail: "unknown-boot-image" },
    });
    const off = recorded("pc-rsa", "secure-boot-off");
    assert.deepEqual(await a.attest("pc-rsa", off.nonce, off.evidence, NOW), {
      ok: false,
      status: 403,
      body: { error: "attestation-refused", reason: "below-hardware-floor" },
    });
  });

  it("refuses a replayed quote: its nonce is spent, and a fresh nonce is not what it quoted", async () => {
    const a = await attestation();
    const quote = recorded("pc-rsa", "first");
    assert.ok((await a.attest("pc-rsa", quote.nonce, quote.evidence, NOW)).ok);
    const again = await a.attest("pc-rsa", quote.nonce, quote.evidence, NOW);
    assert.deepEqual(again.ok ? null : again.body, { error: "bad-nonce" });
    const fresh = mintChallenge(fixture.roomSecret, "pc-rsa", 60, NOW);
    const replayed = await a.attest("pc-rsa", fresh, quote.evidence, NOW);
    assert.deepEqual(replayed.ok ? null : replayed.body, {
      error: "attestation-refused",
      reason: "evidence-rejected",
      detail: "wrong-nonce",
    });
  });

  it("activates an AK only for a live challenge of the machine's own, to its registered EK", async () => {
    const a = await attestation();
    const { akPublic } = recorded("pc-rsa", "first").evidence;
    const nonce = mintChallenge(fixture.roomSecret, "pc-rsa", 60, NOW);
    const made = await a.activate("pc-rsa", nonce, akPublic, NOW);
    assert.ok(made.ok);
    // TPM2B_ID_OBJECT: size, then a TPM2B HMAC (SHA-256), then the encrypted credential.
    assert.equal(Buffer.from(made.grant.credentialBlob, "base64").readUInt16BE(2), 32);
    // TPM2B_ENCRYPTED_SECRET: the seed, RSA-OAEP to the 2048-bit EK.
    assert.equal(Buffer.from(made.grant.encryptedSecret, "base64").length, 2 + 256);
    for (const bad of ["forged", mintChallenge(fixture.roomSecret, "pc-ecc", 60, NOW), nonce]) {
      const when = bad === nonce ? NOW + 60_000 : NOW;
      const refused = await a.activate("pc-rsa", bad, akPublic, when);
      assert.deepEqual(refused.ok ? null : refused.body, { error: "bad-nonce" });
    }
    const unknown = await a.activate(
      "pc-ecc",
      mintChallenge(fixture.roomSecret, "pc-ecc", 60, NOW),
      akPublic,
      NOW,
    );
    assert.deepEqual(unknown.ok ? null : unknown.body, {
      error: "attestation-refused",
      reason: "evidence-rejected",
      detail: "unknown-ek",
    });
  });

  it("registers an EK only a vendor vouches for, and only with a verifier that uses one", async () => {
    const a = await attestation();
    const certificate = fixture.machines["pc-ecc"].ekCertificate;
    assert.deepEqual(await a.enroll("pc-ecc", { certificate }, NOW), { ok: true });
    const garbage = await a.enroll("pc-ecc", { certificate: "!!" }, NOW);
    assert.deepEqual(garbage.ok ? null : [garbage.status, garbage.body], [400, { error: "bad-request" }]);
    const root = Buffer.from(fixture.vendorRoot.replace(/-----[A-Z ]+-----|\s/g, ""), "base64").toString(
      "base64",
    );
    const notEk = await a.enroll("pc-ecc", { certificate: root }, NOW);
    assert.deepEqual(notEk.ok ? null : notEk.body, {
      error: "attestation-refused",
      reason: "evidence-rejected",
      detail: "ek-untrusted",
    });
    const dev = createAttestation({ access, verifier: insecureDevVerifier(access.machines) });
    const none = await dev.enroll("pc-ecc", { certificate }, NOW);
    assert.deepEqual(none.ok ? null : none.body, { error: "not-configured" });
    const noActivation = await dev.activate(
      "pc-ecc",
      mintChallenge(fixture.roomSecret, "pc-ecc", 60, NOW),
      "",
      NOW,
    );
    assert.deepEqual(noActivation.ok ? null : noActivation.body, { error: "not-configured" });
  });
});

describe("the TPM verifier's configuration", () => {
  /** A directory with a vendor root store, a signed policy and its key, and the environment naming them. */
  function configured() {
    const dir = mkdtempSync(join(tmpdir(), "swiff-attest-"));
    mkdirSync(join(dir, "roots", "firmware"), { recursive: true });
    writeFileSync(
      join(dir, "roots", "firmware", "vendor.pem"),
      fixture.vendorRoot + fixture.vendorIntermediate,
    );
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(join(dir, "policy.json"), signBootPolicy({ version: 1, releases: [RELEASE] }, privateKey));
    writeFileSync(join(dir, "policy.pem"), publicKey.export({ format: "pem", type: "spki" }));
    const env = {
      ATTESTATION_VERIFIER: "tpm",
      ROOM_SECRET: fixture.roomSecret,
      ATTESTATION_TPM_ROOTS: join(dir, "roots"),
      ATTESTATION_POLICY: join(dir, "policy.json"),
      ATTESTATION_POLICY_KEY: join(dir, "policy.pem"),
    };
    return { dir, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("builds the TPM verifier from the environment", () => {
    const { env, cleanup } = configured();
    try {
      const config = attestationFromEnv(env, new Map(), { query: async () => ({ rows: [], rowCount: 0 }) });
      assert.equal(config.verifier?.name, "tpm");
      assert.deepEqual(
        config.warnings.filter((w) => w.includes("tpm")),
        [],
      );
      const inMemory = attestationFromEnv(env);
      assert.ok(inMemory.warnings.some((w) => w.includes("in memory")));
    } finally {
      cleanup();
    }
  });

  it("has no verifier, and says why, when anything it needs is missing or wrong", () => {
    const { dir, env, cleanup } = configured();
    try {
      const otherKey = generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" });
      writeFileSync(join(dir, "other.pem"), otherKey);
      for (const [change, says] of [
        [{ ATTESTATION_TPM_ROOTS: "" }, "ATTESTATION_TPM_ROOTS"],
        [{ ATTESTATION_TPM_ROOTS: join(dir, "nowhere") }, "no root certificates"],
        [{ ATTESTATION_POLICY: join(dir, "nowhere.json") }, "ENOENT"],
        [{ ATTESTATION_POLICY_KEY: join(dir, "other.pem") }, "signature"],
        [{ ROOM_SECRET: "" }, "ROOM_SECRET"],
      ] as const) {
        const config = attestationFromEnv({ ...env, ...change });
        assert.equal(config.verifier, null, says);
        assert.ok(
          config.warnings.some((w) => w.includes("no machine can attest") && w.includes(says)),
          `${says}: ${config.warnings.join(" | ")}`,
        );
      }
    } finally {
      cleanup();
    }
  });
});

describe("the boot policy", () => {
  const payload = { version: 1, releases: [RELEASE] };

  it("reads a policy its key signed, with Ed25519, RSA or ECDSA", () => {
    for (const type of ["ed25519", "rsa", "ec"] as const) {
      const { publicKey, privateKey } =
        type === "rsa"
          ? generateKeyPairSync("rsa", { modulusLength: 2048 })
          : type === "ec"
            ? generateKeyPairSync("ec", { namedCurve: "P-256" })
            : generateKeyPairSync("ed25519");
      assert.deepEqual(
        readBootPolicy(signBootPolicy(payload, privateKey), publicKey),
        { releases: [RELEASE] },
        type,
      );
    }
  });

  it("refuses a policy another key signed, or one changed after signing", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519").publicKey;
    const signed = signBootPolicy(payload, privateKey);
    assert.throws(() => readBootPolicy(signed, other), BootPolicyError);
    const file = JSON.parse(signed) as { payload: string; signature: string };
    const changed = JSON.stringify({ ...payload, releases: [{ ...RELEASE, pcr11: ["0".repeat(64)] }] });
    const tampered = JSON.stringify({ ...file, payload: Buffer.from(changed).toString("base64") });
    assert.throws(() => readBootPolicy(tampered, publicKey), BootPolicyError);
  });

  it("never signs or reads a malformed policy", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    for (const bad of [
      { version: 2, releases: [] },
      { version: 1 },
      { version: 1, releases: [{ ...RELEASE, pcr11: [] }] },
      { version: 1, releases: [{ ...RELEASE, pcr11: ["abc"] }] },
      { version: 1, releases: [{ ...RELEASE, iommu: "yes" }] },
      { version: 1, releases: [{ ...RELEASE, name: "" }] },
      { version: 1, releases: [{ ...RELEASE, pcr12: undefined }] },
      { version: 1, releases: [{ ...RELEASE, pcr13: [] }] },
      { version: 1, releases: [{ ...RELEASE, uki: ["0".repeat(64)] }] },
      { version: 1, releases: [{ ...RELEASE, secureBootAuthorities: undefined }] },
    ]) {
      assert.throws(() => signBootPolicy(bad, privateKey), BootPolicyError, JSON.stringify(bad));
    }
    assert.throws(() => readBootPolicy("not json", publicKey), BootPolicyError);
    assert.throws(() => readBootPolicy("{}", publicKey), BootPolicyError);
  });
});

describe("the event log", () => {
  const log = parseEventLog(Buffer.from(recorded("pc-rsa", "first").evidence.eventLog, "base64"));

  it("replays to the PCRs the TPM quoted", () => {
    const { pcrs } = recorded("pc-rsa", "first").evidence;
    const replayed = replay(log, [0, 1, 2, 3, 4, 5, 6, 7]);
    for (let pcr = 0; pcr <= 7; pcr++) {
      assert.equal(replayed.get(pcr)!.toString("hex"), pcrs[String(pcr) as keyof typeof pcrs], `PCR ${pcr}`);
    }
  });

  it("believes event data only where the digest is its hash", () => {
    assert.equal(bootFacts(log).secureBoot, true);
    // The SecureBoot variable's data claiming 1 beside a digest of anything else is not believed.
    const forged = parseEventLog(
      Buffer.from(recorded("pc-rsa", "secure-boot-off").evidence.eventLog, "base64"),
    );
    const secureBoot = forged.events.find((e) => e.data.includes(Buffer.from("SecureBoot", "utf16le")))!;
    secureBoot.data[secureBoot.data.length - 1] = 1;
    assert.equal(bootFacts(forged).secureBoot, false);
  });

  it("lists the boot applications measured into PCR 4", () => {
    assert.deepEqual(
      bootFacts(log).bootApplications.map((d) => d.toString("hex")),
      fixture.release.bootApplications,
    );
  });

  it("starts PCR 0 at the locality the firmware says it started at", () => {
    const startup = Buffer.concat([Buffer.from("StartupLocality\0", "latin1"), Buffer.from([3])]);
    const header = Buffer.from(recorded("pc-rsa", "first").evidence.eventLog, "base64");
    // The header is the first event: 32 bytes of fields, then its data.
    const headerLength = 32 + header.readUInt32LE(28);
    const noAction = Buffer.alloc(4 * 3 + 2 + 20 + 2 + 32 + 4);
    noAction.writeUInt32LE(0, 0);
    noAction.writeUInt32LE(3, 4);
    noAction.writeUInt32LE(2, 8);
    noAction.writeUInt16LE(0x0004, 12);
    noAction.writeUInt16LE(0x000b, 34);
    noAction.writeUInt32LE(startup.length, 68);
    const withLocality = Buffer.concat([header.subarray(0, headerLength), noAction, startup]);
    const replayed = replay(parseEventLog(withLocality), [0]);
    assert.equal(replayed.get(0)!.toString("hex"), "00".repeat(31) + "03");
  });

  it("refuses a log that is not crypto-agile or has no SHA-256 bank", () => {
    assert.throws(() => parseEventLog(Buffer.alloc(10)));
    assert.throws(() => parseEventLog(Buffer.alloc(100)));
  });
});

describe("EK certificates", () => {
  it("chain to a vendor root through the store's intermediates or the machine's own", () => {
    const der = Buffer.from(fixture.machines["pc-rsa"].ekCertificate, "base64");
    const rootOnly = trustStore([{ der: fixture.vendorRoot, kind: "firmware" }]);
    assert.equal(verifyEkCertificate(rootOnly, der, [], NOW), null, "no path to the root");
    const intermediate = Buffer.from(
      fixture.vendorIntermediate.replace(/-----[A-Z ]+-----|\s/g, ""),
      "base64",
    );
    const ek = verifyEkCertificate(rootOnly, der, [intermediate], NOW);
    assert.equal(ek?.kind, "firmware");
    assert.equal(ek?.fingerprint.toString("hex"), createHash("sha256").update(der).digest("hex"));
    assert.equal(verifyEkCertificate(vendor(), der, [], Date.parse("2000-01-01")), null, "not yet valid");
  });
});

describe("the TPM attestation routes", () => {
  const KEY = "the-rsa-machine-key";
  const access: Access = accessFromEnv({
    ROOM_SECRET: fixture.roomSecret,
    MACHINE_KEYS: `pc-rsa:${createHash("sha256").update(KEY).digest("hex")}`,
  });
  let origin = "";
  let close = async () => {};

  before(async () => {
    const platform = await Platform.open({ database: await testDatabase(), owners: access.owners });
    const verifier = tpmVerifier({
      store: memoryStore(),
      roots: vendor(),
      policy: POLICY,
      activationKey: ACTIVATION_KEY,
    });
    const attestation = createAttestation({ access, verifier, attestedOnly: true });
    const api = createApi({
      platform,
      access,
      sessionSecret: null,
      publicOrigin: null,
      fallbackOrigin: "http://localhost",
      attestation,
    });
    const server = createServer(async (req, res) => {
      if (!(await api(req, res, new URL(req.url ?? "/", "http://localhost").pathname)))
        res.writeHead(418).end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    close = async () => {
      server.close();
      await platform.close();
    };
  });
  after(() => close());

  async function call(method: string, path: string, body?: unknown, bearer?: string) {
    const res = await fetch(`${origin}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  it("registers the EK with the machine key only, and refuses a certificate that is not an EK", async () => {
    const certificate = fixture.machines["pc-rsa"].ekCertificate;
    assert.equal((await call("PUT", "/api/machines/pc-rsa/ek", { certificate })).status, 401);
    assert.equal((await call("PUT", "/api/machines/pc-rsa/ek", { certificate }, "wrong")).status, 401);
    assert.equal((await call("PUT", "/api/machines/pc-rsa/ek", "not json", KEY)).status, 400);
    const root = Buffer.from(fixture.vendorRoot.replace(/-----[A-Z ]+-----|\s/g, ""), "base64").toString(
      "base64",
    );
    assert.deepEqual(await call("PUT", "/api/machines/pc-rsa/ek", { certificate: root }, KEY), {
      status: 403,
      body: { error: "attestation-refused", reason: "evidence-rejected", detail: "ek-untrusted" },
    });
    assert.deepEqual(await call("PUT", "/api/machines/pc-rsa/ek", { certificate }, KEY), {
      status: 204,
      body: null,
    });
  });

  it("activates the AK for a live challenge, and refuses a recorded quote over it", async () => {
    const challenge = await call("POST", "/api/machines/pc-rsa/attest-challenge");
    assert.equal(challenge.status, 200);
    const { evidence } = recorded("pc-rsa", "first");
    const nonce = challenge.body!.nonce;
    const activation = await call("POST", "/api/machines/pc-rsa/attest-activation", {
      nonce,
      akPublic: evidence.akPublic,
    });
    assert.equal(activation.status, 200);
    assert.deepEqual(Object.keys(activation.body!).sort(), ["credentialBlob", "encryptedSecret"]);
    const forged = await call("POST", "/api/machines/pc-rsa/attest-activation", {
      nonce: "x",
      akPublic: evidence.akPublic,
    });
    assert.deepEqual(forged, { status: 401, body: { error: "bad-nonce" } });
    assert.equal((await call("POST", "/api/machines/pc-rsa/attest-activation", "[", KEY)).status, 400);
    assert.deepEqual(await call("POST", "/api/machines/pc-rsa/attest", { nonce, evidence }), {
      status: 403,
      body: { error: "attestation-refused", reason: "evidence-rejected", detail: "wrong-nonce" },
    });
  });
});
