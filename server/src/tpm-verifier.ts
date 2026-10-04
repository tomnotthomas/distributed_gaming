// The production attestation verifier (ATTESTATION_VERIFIER=tpm): a machine
// earns a host certificate only by proving, with its TPM, that it booted an
// untouched, Swiff-signed Swiff OS just now.
//
//   owner's Windows (machine key)            this server
//   PUT  /api/machines/:id/ek  { certificate } ──► EK certificate must chain to a
//                                                  TPM vendor root; registered
//
//   swiff-hostd in Swiff OS
//   POST /attest-challenge                     ──► { nonce }
//   POST /attest-activation { nonce, akPublic } ──► TPM2_MakeCredential to the
//                                                  registered EK, for that AK
//   TPM2_ActivateCredential (EK + AK): the credential
//   TPM2_Quote (AK) over SHA-256(nonce): PCRs 0-7 and 11-13
//   POST /attest { nonce, evidence }           ──► judged below
//
// The evidence (protocol.ts, TpmEvidence) is judged in this order, and the
// first failure is the refusal's `detail`:
//
//   1. unknown-ek / ek-untrusted / ek-unsupported
//                                  the machine registered an EK whose certificate
//                                  still chains to a vendor root (ek.ts), for a
//                                  key the TCG's default EK templates make (RSA
//                                  2048, ECC P-256); the root's kind is the
//                                  TPM's: firmware or discrete
//   2. ak-unsuitable               the AK is a restricted signing key that never
//                                  leaves its TPM (fixedTPM, fixedParent,
//                                  sensitiveDataOrigin), and a key at all
//   3. bad-signature               the quote is the AK's
//   4. wrong-nonce                 quoted over SHA-256 of this challenge
//   5. ak-not-activated            the credential the AK's TPM recovered is the one
//                                  made for this nonce, this AK and this EK: the
//                                  AK lives in the TPM that holds the EK
//   6. ak-not-under-ek             the AK is a child of the EK, so it is in the
//                                  endorsement hierarchy and the quote's
//                                  resetCount and restartCount are not obfuscated
//   7. pcrs-not-quoted             the quote covers SHA-256 PCRs 0-7 and 11-13
//   8. pcr-digest-mismatch         the PCR values sent are the ones quoted
//   9. event-log-mismatch          the firmware's event log replays to PCRs 0-7
//  10. unknown-boot-image          PCR 11 is a signed release's (boot-policy.ts)
//  11. unknown-boot-extras         PCRs 12 and 13 are that release's: systemd-stub
//                                  took no command line, credential or extension
//                                  from outside the UKI the release does not expect
//  12. unknown-boot-application    PCR 4 measured at least one application, all of
//                                  them the release's, the last one its UKI
//  13. secure-boot-untrusted       PCR 7 measured SecureBoot, PK, KEK, db and dbx
//                                  with a platform key enrolled (not setup mode),
//                                  and every Secure Boot authority it measured is
//                                  one the release lists. Refused outright: no
//                                  cooldown ever trusts another authority
//  14. firmware-changed            PCRs 0-3 (firmware and its settings) are the
//                                  ones this machine first attested with. A
//                                  change, such as a BIOS update, is refused until
//                                  the same new values have been seen for
//                                  FIRMWARE_COOLDOWN_SECONDS, and then becomes the
//                                  machine's. After the EK is registered again,
//                                  even unchanged firmware waits out the cooldown
//  15. counter-rollback / replayed-quote
//                                  the TPM's resetCount, restartCount and clock
//                                  never go back from the last accepted quote
//
// What passes: the platform facts (UEFI, Secure Boot and pre-boot DMA
// protection from the replayed log, IOMMU from the release, the TPM's kind from
// its EK root).
//
// Per machine the store keeps the registered EK, the firmware baseline and the
// last accepted counters, in the platform database (migration 4, schema.ts) so a restart
// never makes a changed firmware look like a first use. The firmware baseline is
// the machine's, not its EK's: registering an EK again (the same one after the
// owner cleared the TPM, which sets its counters back to zero, or another one)
// keeps it, forgets the counters, and holds the firmware for the cooldown.
//
// Every refusal of secure-boot-untrusted or firmware-changed, every firmware
// change accepted after its cooldown, and every EK registered again over a
// baseline is a SecurityEvent, logged as one JSON line for review and alerts.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Queryable } from "./db.js";
import { EventLogError, bootFacts, parseEventLog, replay } from "./eventlog.js";
import { verifyEkCertificate, type TrustStore, type TrustedEk } from "./ek.js";
import { releaseFor, type BootPolicy } from "./boot-policy.js";
import {
  TPMA,
  TPM_ALG,
  TPM_RH_ENDORSEMENT,
  TpmFormatError,
  digest,
  ekPublicFor,
  makeCredential,
  nameOf,
  publicKeyOf,
  qualifiedNameUnder,
  quoteSignatureHash,
  readAttest,
  readPublic2b,
  type TpmPublic,
} from "./tpm.js";
import type { Activate, AttestationVerifier, Enroll, Verdict } from "./attestation.js";
import type { AttestRefusalDetail } from "./protocol.js";

/** The PCRs a quote must cover, all in the SHA-256 bank. */
export const QUOTED_PCRS = [0, 1, 2, 3, 4, 5, 6, 7, 11, 12, 13] as const;
/** The PCRs the firmware's event log must replay to. */
const REPLAYED_PCRS = [0, 1, 2, 3, 4, 5, 6, 7];
/** Firmware code and settings: trusted on first use per machine. */
export const FIRMWARE_PCRS = [0, 1, 2, 3];
/**
 * How long a machine's new firmware values must keep being seen before they
 * replace the ones it first attested with. Provisional: long enough that a
 * firmware change is noticed, short enough that a BIOS update costs a day.
 */
export const FIRMWARE_COOLDOWN_SECONDS = 24 * 60 * 60;

/** What the store keeps per machine. Digests are lowercase hex, the TPM clock a decimal string. */
export type MachineRecord = {
  /** The registered EK certificate (DER) and the intermediates sent with it. */
  ek: { certificate: Buffer; intermediates: Buffer[] } | null;
  /** PCRs 0-3 the machine first attested with, by PCR. */
  firmware: Record<string, string> | null;
  /** New PCRs 0-3 being cooled down, and since when (Unix ms). */
  pendingFirmware: { pcrs: Record<string, string>; since: number } | null;
  /** The counters of the last accepted quote. */
  counters: { resetCount: number; restartCount: number; clock: string } | null;
  /** When (Unix ms) the EK was registered again over a firmware baseline, until the firmware cools down again. */
  reenrolledAt: number | null;
};

export type AttestationStore = {
  get(room: string): Promise<MachineRecord | null>;
  put(room: string, record: MachineRecord): Promise<void>;
};

/** A copy of `record` that shares nothing with it. */
const copy = (record: MachineRecord): MachineRecord => ({
  ek: record.ek && {
    certificate: Buffer.from(record.ek.certificate),
    intermediates: record.ek.intermediates.map((cert) => Buffer.from(cert)),
  },
  firmware: record.firmware && { ...record.firmware },
  pendingFirmware: record.pendingFirmware && {
    pcrs: { ...record.pendingFirmware.pcrs },
    since: record.pendingFirmware.since,
  },
  counters: record.counters && { ...record.counters },
  reenrolledAt: record.reenrolledAt,
});

/** A store in this process's memory: a restart forgets every machine. */
export function memoryStore(): AttestationStore {
  const records = new Map<string, MachineRecord>();
  return {
    async get(room) {
      const record = records.get(room);
      return record ? copy(record) : null;
    },
    async put(room, record) {
      records.set(room, copy(record));
    },
  };
}

type Row = {
  ek_certificate: string | null;
  ek_intermediates: string | null;
  firmware_pcrs: string | null;
  pending_firmware_pcrs: string | null;
  pending_since: number | null;
  reset_count: number | null;
  restart_count: number | null;
  tpm_clock: string | null;
  reenrolled_at: number | null;
};

/** The store in the platform database's machine_attestation table. */
export function databaseStore(db: Queryable): AttestationStore {
  return {
    async get(room) {
      const { rows } = await db.query<Row>("SELECT * FROM machine_attestation WHERE machine_id = $1", [room]);
      const row = rows[0];
      if (!row) return null;
      return {
        ek: row.ek_certificate
          ? {
              certificate: Buffer.from(row.ek_certificate, "base64"),
              intermediates: (JSON.parse(row.ek_intermediates ?? "[]") as string[]).map((c) =>
                Buffer.from(c, "base64"),
              ),
            }
          : null,
        firmware: row.firmware_pcrs ? (JSON.parse(row.firmware_pcrs) as Record<string, string>) : null,
        pendingFirmware:
          row.pending_firmware_pcrs && row.pending_since !== null
            ? {
                pcrs: JSON.parse(row.pending_firmware_pcrs) as Record<string, string>,
                since: Number(row.pending_since),
              }
            : null,
        counters:
          row.reset_count !== null && row.restart_count !== null && row.tpm_clock !== null
            ? {
                resetCount: Number(row.reset_count),
                restartCount: Number(row.restart_count),
                clock: row.tpm_clock,
              }
            : null,
        reenrolledAt: row.reenrolled_at === null ? null : Number(row.reenrolled_at),
      };
    },
    async put(room, record) {
      await db.query(
        `INSERT INTO machine_attestation (machine_id, ek_certificate, ek_intermediates, firmware_pcrs,
           pending_firmware_pcrs, pending_since, reset_count, restart_count, tpm_clock, reenrolled_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (machine_id) DO UPDATE SET
           ek_certificate = $2, ek_intermediates = $3, firmware_pcrs = $4, pending_firmware_pcrs = $5,
           pending_since = $6, reset_count = $7, restart_count = $8, tpm_clock = $9, reenrolled_at = $10,
           updated_at = $11`,
        [
          room,
          record.ek?.certificate.toString("base64") ?? null,
          record.ek ? JSON.stringify(record.ek.intermediates.map((c) => c.toString("base64"))) : null,
          record.firmware ? JSON.stringify(record.firmware) : null,
          record.pendingFirmware ? JSON.stringify(record.pendingFirmware.pcrs) : null,
          record.pendingFirmware?.since ?? null,
          record.counters?.resetCount ?? null,
          record.counters?.restartCount ?? null,
          record.counters?.clock ?? null,
          record.reenrolledAt,
          Date.now(),
        ],
      );
    },
  };
}

/** What the verifier reports for review: the machine and PCR values, never keys or evidence. */
export type SecurityEvent =
  | { event: "secure-boot-untrusted"; machine: string; configured: boolean; unknownAuthorities: string[] }
  | {
      event: "firmware-changed";
      machine: string;
      baseline: Record<string, string> | null;
      presented: Record<string, string>;
    }
  | {
      event: "firmware-accepted";
      machine: string;
      previous: Record<string, string> | null;
      accepted: Record<string, string>;
    }
  | { event: "ek-registered-again"; machine: string; sameEk: boolean };

const logSecurityEvent = (event: SecurityEvent) =>
  console.warn(`[swiff] security event ${JSON.stringify(event)}`);

export type TpmVerifierOptions = {
  store: AttestationStore;
  /** TPM vendor roots (ek.ts). */
  roots: TrustStore;
  /** The signed releases (boot-policy.ts). */
  policy: BootPolicy;
  /** Keys the AK activation credentials, so a challenge needs no state: at least 32 bytes. */
  activationKey: Buffer;
  firmwareCooldownSeconds?: number;
  /** Where security events go: a JSON line on stderr unless given. */
  securityLog?: (event: SecurityEvent) => void;
};

/** A refusal the verifier explains, as the attest refusal's `detail`. */
const refuse = (reason: AttestRefusalDetail): Verdict => ({ ok: false, reason });

const b64 = (value: unknown): Buffer | null =>
  typeof value === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(value) ? Buffer.from(value, "base64") : null;
const HEX_PCR = /^[0-9a-fA-F]{64}$/;

/** The AK in `akPublic` (base64 TPM2B_PUBLIC), when it is a key Node can verify with, or why it cannot be one. */
function readAk(akPublic: unknown): TpmPublic | AttestRefusalDetail {
  const bytes = b64(akPublic);
  if (!bytes) return "malformed-evidence";
  let ak: TpmPublic;
  try {
    ak = readPublic2b(bytes);
  } catch (error) {
    if (error instanceof TpmFormatError) return "ak-unsuitable";
    throw error;
  }
  const required = TPMA.fixedTPM | TPMA.fixedParent | TPMA.sensitiveDataOrigin | TPMA.restricted | TPMA.sign;
  if ((ak.attributes & required) !== required || ak.attributes & TPMA.decrypt) return "ak-unsuitable";
  if (ak.nameAlg === TPM_ALG.SHA1) return "ak-unsuitable";
  if (ak.rsa && ak.rsa.keyBits < 2048) return "ak-unsuitable";
  try {
    publicKeyOf(ak);
  } catch {
    return "ak-unsuitable";
  }
  return ak;
}

/** Run `work` for `room` after whatever is already running for it, so its record changes in turn. */
function perRoom() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(room: string, work: () => Promise<T>): Promise<T> => {
    const run = (tails.get(room) ?? Promise.resolve()).then(work);
    const tail = run.catch(() => {});
    tails.set(room, tail);
    void tail.then(() => {
      if (tails.get(room) === tail) tails.delete(room);
    });
    return run;
  };
}

/** A registered EK the verifier trusts, with the public area its certificate's key has under its template. */
type Ek = TrustedEk & { public: TpmPublic };

/** The TPM verifier: it also registers EKs and activates AKs. */
export type TpmVerifier = AttestationVerifier & { enroll: Enroll; activate: Activate };

export function tpmVerifier({
  store,
  roots,
  policy,
  activationKey,
  firmwareCooldownSeconds = FIRMWARE_COOLDOWN_SECONDS,
  securityLog = logSecurityEvent,
}: TpmVerifierOptions): TpmVerifier {
  if (activationKey.length < 32) throw new Error("the activation key must be at least 32 bytes");
  const inTurn = perRoom();

  /** The credential an AK activated for `nonce` under EK `ek` must recover. */
  const credentialFor = (nonce: string, akName: Buffer, ek: Ek) =>
    createHmac("sha256", activationKey)
      .update("swiff-ak-activation\0")
      .update(createHash("sha256").update(nonce).digest())
      .update(akName)
      .update(ek.fingerprint)
      .digest();

  /** The EK certified by `der`, if it chains to a vendor root at `now` and was made from a template this verifier knows. */
  const endorsement = (der: Buffer, intermediates: Buffer[], now: number): Ek | AttestRefusalDetail => {
    const trusted = verifyEkCertificate(roots, der, intermediates, now);
    if (!trusted) return "ek-untrusted";
    try {
      return { ...trusted, public: ekPublicFor(trusted.key) };
    } catch (error) {
      if (error instanceof TpmFormatError) return "ek-unsupported";
      throw error;
    }
  };

  /** The registered EK of `record`, as `endorsement` judges it now. */
  const trustedEk = (record: MachineRecord | null, now: number): Ek | AttestRefusalDetail =>
    record?.ek ? endorsement(record.ek.certificate, record.ek.intermediates, now) : "unknown-ek";

  return {
    name: "tpm",

    enroll: ({ room, certificate, intermediates = [], now = Date.now() }) =>
      inTurn(room, async () => {
        const der = b64(certificate);
        const extra = Array.isArray(intermediates) ? intermediates.map(b64) : [null];
        if (!der || extra.some((cert) => !cert) || extra.length > 8) {
          return { ok: false, reason: "malformed-evidence" } as const;
        }
        const ek = endorsement(der, extra as Buffer[], now);
        if (typeof ek === "string") return { ok: false, reason: ek } as const;
        const record = await store.get(room);
        // The firmware baseline is the machine's, whichever EK it registers.
        // The counters start again (a cleared TPM's are back at zero), and a
        // machine that has a baseline waits out the firmware cooldown again.
        const firmware = record?.firmware ?? null;
        await store.put(room, {
          ek: { certificate: der, intermediates: extra as Buffer[] },
          firmware,
          pendingFirmware: record?.pendingFirmware ?? null,
          counters: null,
          reenrolledAt: firmware ? now : null,
        });
        if (firmware) {
          securityLog({
            event: "ek-registered-again",
            machine: room,
            sameEk: Boolean(record?.ek?.certificate.equals(der)),
          });
        }
        return { ok: true } as const;
      }),

    async activate({ room, nonce, akPublic, now = Date.now() }) {
      const ek = trustedEk(await store.get(room), now);
      if (typeof ek === "string") return { ok: false, reason: ek };
      const ak = readAk(akPublic);
      if (typeof ak === "string") return { ok: false, reason: ak };
      const akName = nameOf(ak);
      const { credentialBlob, secret } = makeCredential(ek.public, akName, credentialFor(nonce, akName, ek));
      return {
        ok: true,
        activation: {
          credentialBlob: credentialBlob.toString("base64"),
          encryptedSecret: secret.toString("base64"),
        },
      };
    },

    verify: ({ room, nonce, evidence, now = Date.now() }) =>
      inTurn(room, async (): Promise<Verdict> => {
        const e = (evidence ?? {}) as Record<string, unknown>;
        const attest = b64(e.quote);
        const signature = b64(e.signature);
        const activation = b64(e.activation);
        const eventLogBytes = b64(e.eventLog);
        const pcrValues = e.pcrs as Record<string, unknown> | undefined;
        if (
          !attest ||
          !signature ||
          !activation ||
          !eventLogBytes ||
          !pcrValues ||
          typeof pcrValues !== "object"
        ) {
          return refuse("malformed-evidence");
        }

        // 1. The registered EK.
        const record = await store.get(room);
        const ek = trustedEk(record, now);
        if (typeof ek === "string") return refuse(ek);

        // 2-4. A proper AK signed a quote over this challenge.
        const ak = readAk(e.akPublic);
        if (typeof ak === "string") return refuse(ak);
        const signedWith = quoteSignatureHash(ak, attest, signature);
        if (signedWith === null) return refuse("bad-signature");
        let quote;
        try {
          quote = readAttest(attest);
        } catch (error) {
          if (error instanceof TpmFormatError) return refuse("malformed-evidence");
          throw error;
        }
        if (!quote.extraData.equals(createHash("sha256").update(nonce).digest()))
          return refuse("wrong-nonce");

        // 5-6. The AK lives in the EK's TPM, directly under the EK.
        const akName = nameOf(ak);
        const expected = credentialFor(nonce, akName, ek);
        if (activation.length !== expected.length || !timingSafeEqual(activation, expected)) {
          return refuse("ak-not-activated");
        }
        if (!quote.qualifiedSigner.equals(qualifiedNameUnder(TPM_RH_ENDORSEMENT, ek.public, ak))) {
          return refuse("ak-not-under-ek");
        }

        // 7-8. The PCRs sent are the ones quoted, and the ones that matter are among them.
        const [bank, ...others] = quote.selections;
        if (!bank || others.length || bank.hash !== TPM_ALG.SHA256) return refuse("pcrs-not-quoted");
        if (!QUOTED_PCRS.every((pcr) => bank.pcrs.includes(pcr))) return refuse("pcrs-not-quoted");
        const pcrs = new Map<number, Buffer>();
        for (const pcr of bank.pcrs) {
          const value = pcrValues[String(pcr)];
          if (typeof value !== "string" || !HEX_PCR.test(value)) return refuse("malformed-evidence");
          pcrs.set(pcr, Buffer.from(value, "hex"));
        }
        if (!digest(signedWith, ...bank.pcrs.map((pcr) => pcrs.get(pcr)!)).equals(quote.pcrDigest)) {
          return refuse("pcr-digest-mismatch");
        }

        // 9. The firmware's log is honest about PCRs 0-7.
        let log;
        try {
          log = parseEventLog(eventLogBytes);
        } catch (error) {
          if (error instanceof EventLogError) return refuse("event-log-mismatch");
          throw error;
        }
        const replayed = replay(log, REPLAYED_PCRS);
        if (!REPLAYED_PCRS.every((pcr) => replayed.get(pcr)!.equals(pcrs.get(pcr)!))) {
          return refuse("event-log-mismatch");
        }

        // 10-12. A released Swiff OS, with nothing from outside its UKI, booted
        // through only its own applications and into its UKI last.
        const release = releaseFor(policy, pcrs.get(11)!.toString("hex"));
        if (!release) return refuse("unknown-boot-image");
        if (
          !release.pcr12.includes(pcrs.get(12)!.toString("hex")) ||
          !release.pcr13.includes(pcrs.get(13)!.toString("hex"))
        ) {
          return refuse("unknown-boot-extras");
        }
        const boot = bootFacts(log);
        const apps = boot.bootApplications.map((app) => app.toString("hex"));
        if (
          !apps.length ||
          !apps.every((app) => release.bootApplications.includes(app)) ||
          !release.uki.includes(apps[apps.length - 1]!)
        ) {
          return refuse("unknown-boot-application");
        }

        // 13. Secure Boot keys enrolled, and only the release's authorities verified anything.
        const unknownAuthorities = boot.secureBootAuthorities
          .map((authority) => authority.toString("hex"))
          .filter((authority) => !release.secureBootAuthorities.includes(authority));
        if (!boot.secureBootConfigured || unknownAuthorities.length) {
          securityLog({
            event: "secure-boot-untrusted",
            machine: room,
            configured: boot.secureBootConfigured,
            unknownAuthorities,
          });
          return refuse("secure-boot-untrusted");
        }

        // 14. The firmware it first attested with, or a change that has cooled
        // down; after the EK was registered again, any firmware cools down.
        const firmware = Object.fromEntries(
          FIRMWARE_PCRS.map((pcr) => [pcr, pcrs.get(pcr)!.toString("hex")]),
        );
        const sameFirmware = (other: Record<string, string>) =>
          FIRMWARE_PCRS.every((pcr) => other[pcr] === firmware[pcr]);
        const next: MachineRecord = { ...record!, pendingFirmware: null, reenrolledAt: null };
        let cooledDown = false;
        if (!record!.reenrolledAt && (!record!.firmware || sameFirmware(record!.firmware))) {
          next.firmware = firmware;
        } else if (
          record!.pendingFirmware &&
          sameFirmware(record!.pendingFirmware.pcrs) &&
          now - Math.max(record!.pendingFirmware.since, record!.reenrolledAt ?? 0) >=
            firmwareCooldownSeconds * 1000
        ) {
          next.firmware = firmware;
          cooledDown = true;
        } else {
          if (!record!.pendingFirmware || !sameFirmware(record!.pendingFirmware.pcrs)) {
            await store.put(room, { ...record!, pendingFirmware: { pcrs: firmware, since: now } });
          }
          securityLog({
            event: "firmware-changed",
            machine: room,
            baseline: record!.firmware,
            presented: firmware,
          });
          return refuse("firmware-changed");
        }

        // 15. The TPM's counters only go forward.
        const { resetCount, restartCount, clock } = quote.clock;
        const last = record!.counters;
        if (last) {
          if (resetCount < last.resetCount) return refuse("counter-rollback");
          if (resetCount === last.resetCount) {
            if (restartCount < last.restartCount) return refuse("counter-rollback");
            if (restartCount === last.restartCount && clock <= BigInt(last.clock))
              return refuse("replayed-quote");
          }
        }
        next.counters = { resetCount, restartCount, clock: clock.toString() };
        await store.put(room, next);
        if (cooledDown) {
          securityLog({
            event: "firmware-accepted",
            machine: room,
            previous: record!.firmware,
            accepted: firmware,
          });
        }

        return {
          ok: true,
          facts: {
            uefi: boot.uefi,
            secureBoot: boot.uefi && boot.secureBoot,
            tpm: ek.kind,
            ekCertificate: true,
            iommu: release.iommu && !boot.dmaProtectionDisabled,
          },
        };
      }),
  };
}
