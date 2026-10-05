// The state key: the server's share of the key to a rental-mode PC's encrypted
// state partition, released only to a machine that has just proven with its
// TPM that it booted an untouched Swiff OS (attestation.ts), so a tampered or
// cloned system, or one whose disk something else had in between, never
// unlocks it.
//
// The partition's LUKS2 key is split in two, after Keylime's U and V shares:
//
//   U   32 random bytes swiff-hostd makes when it formats the partition, sealed
//       to the TPM under the Swiff-signed PCR policy. Never leaves the machine.
//   V   32 random bytes this server makes per machine: the state key. Kept
//       here encrypted with STATE_KEY_SECRET, released only as below.
//
//   The partition opens with U XOR V. Neither alone is any use: the disk and
//   its sealed U, copied off the machine, open nothing without V, and V opens
//   nothing without the TPM that sealed U.
//
// swiff-hostd, once per boot, right after attesting:
//
//   POST /api/machines/:id/state-key   Bearer <host certificate>
//     ◄── 200 { keyId, share }         open the partition with U XOR share
//     ◄── 404 no-state-key             none made yet: ask for a new one
//     ◄── 409 continuity-gap           something else may have had the disk:
//                                      ask for a new one, never open the old
//   PUT  /api/machines/:id/state-key   Bearer <the same certificate>
//     ◄── 201 { keyId, share }         the old share is gone: format the
//                                      partition anew with a fresh U
//
// Released only to a certificate that is:
//
//   - a host certificate for this machine (a machine key never: 403
//     attestation-required, whatever HOSTING_ATTESTATION says), the machine
//     still in MACHINE_KEYS (401 bad-host-cert);
//   - fresh: minted at most STATE_KEY_FRESH_SECONDS ago, and not yet used for a
//     state key (401 stale-host-cert): one call that gets a share per
//     attestation;
//   - for the machine's latest attested boot: the TPM resetCount its quote
//     counted is the latest one any of its quotes did (401 stale-host-cert);
//
// and only while the machine is not revoked (403 revoked), not waiting out a
// firmware cooldown (403 firmware-cooldown), and within its budget of these
// calls (429 rate-limited, with retry-after).
//
// Continuity. The TPM's resetCount goes up by one at every boot, whatever
// boots. Every attestation that passes reports its boot here (`observe`), and a
// boot that is neither the one before's nor the next one, or one the verifier
// could not count, means something else booted in between (the owner's
// Windows, a live USB) and had the disk: the share is withheld from then on,
// and only a new one (PUT) opens rental mode again, on a freshly formatted
// partition. A boot that attested but never asked for the share counts too, so
// an interrupted boot costs no state.
//
// The share and STATE_KEY_SECRET are never logged. Replacing, revoking and a
// share withheld for a gap are security events (machine id, key id and boot
// counts only), one JSON line each on stderr, like the verifier's.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { MIN_SECRET_LENGTH } from "./access.js";
import type { AttestationVerifier, Credential } from "./attestation.js";
import { RequestBudget } from "./budget.js";
import type { Queryable } from "./db.js";
import type { StateKeyError, StateKeyGrant } from "./protocol.js";
import { perRoom } from "./tpm-verifier.js";

/** Bytes in a share, and in the partition key U XOR V. */
export const STATE_KEY_BYTES = 32;
/** How long after attesting a certificate may still get the share: one boot step, not a session. */
export const STATE_KEY_FRESH_SECONDS = 2 * 60;
/** State-key calls one machine may make at once: a boot that asks, is told to replace, and retries. */
export const STATE_KEY_BURST = 6;
/** After the burst, one more call per this many ms. */
export const STATE_KEY_REFILL_MS = 60_000;

/** What the store keeps per machine. */
export type StateKeyRecord = {
  /** The current share's id and the share sealed with STATE_KEY_SECRET; null before the first and once revoked. */
  keyId: string | null;
  sealed: Buffer | null;
  /** When (Unix ms) the current share was made. */
  createdAt: number | null;
  /** The TPM resetCount of the machine's latest attested boot; null when the verifier counted none. */
  lastBoot: number | null;
  /** A boot broke continuity since the share was made: it is not released again. */
  withheld: boolean;
  /** When (Unix ms) the machine was revoked; null while it is not. */
  revokedAt: number | null;
};

/**
 * Each write changes only its own columns, and a new share only an unrevoked
 * machine's, so a revocation from another process (cli.ts) is never undone by
 * a write made from what was read before it.
 */
export type StateKeyStore = {
  get(room: string): Promise<StateKeyRecord | null>;
  /** The machine's latest attested boot, and withhold its share when `withhold`; the share and revocation untouched. */
  recordBoot(room: string, boot: number | null, withhold: boolean): Promise<void>;
  /** Make this the machine's share, no longer withheld, unless it is revoked or has no record: whether it did. */
  putShare(room: string, share: { keyId: string; sealed: Buffer; createdAt: number }): Promise<boolean>;
  /** Destroy the machine's share and mark it revoked at `now`. */
  revoke(room: string, now: number): Promise<void>;
  /** Clear the machine's revocation: whether it was revoked. */
  reinstate(room: string): Promise<boolean>;
};

/** A copy of `record` that shares no buffer with it. */
const copy = (record: StateKeyRecord): StateKeyRecord => ({
  ...record,
  sealed: record.sealed && Buffer.from(record.sealed),
});

/** The record of a machine never seen: no share, no boot, not withheld or revoked. */
const empty = (): StateKeyRecord => ({
  keyId: null,
  sealed: null,
  createdAt: null,
  lastBoot: null,
  withheld: false,
  revokedAt: null,
});

/** A store in this process's memory: a restart forgets every share, so every machine formats anew. */
export function memoryStateKeyStore(): StateKeyStore {
  const records = new Map<string, StateKeyRecord>();
  return {
    async get(room) {
      const record = records.get(room);
      return record ? copy(record) : null;
    },
    async recordBoot(room, boot, withhold) {
      const record = records.get(room) ?? empty();
      records.set(room, { ...record, lastBoot: boot, withheld: record.withheld || withhold });
    },
    async putShare(room, { keyId, sealed, createdAt }) {
      const record = records.get(room);
      if (!record || record.revokedAt !== null) return false;
      records.set(room, { ...record, keyId, sealed: Buffer.from(sealed), createdAt, withheld: false });
      return true;
    },
    async revoke(room, now) {
      const record = records.get(room) ?? empty();
      records.set(room, { ...record, keyId: null, sealed: null, createdAt: null, revokedAt: now });
    },
    async reinstate(room) {
      const record = records.get(room);
      if (!record || record.revokedAt === null) return false;
      records.set(room, { ...record, revokedAt: null });
      return true;
    },
  };
}

type Row = {
  key_id: string | null;
  sealed: string | null;
  created_at: number | null;
  last_boot: number | null;
  withheld: boolean;
  revoked_at: number | null;
};

/** A BIGINT column as a number, or null when it is null. */
const numberOrNull = (value: unknown) => (value === null || value === undefined ? null : Number(value));

/** The store in the platform database's machine_state_keys table. */
export function databaseStateKeyStore(db: Queryable): StateKeyStore {
  return {
    async get(room) {
      const { rows } = await db.query<Row>("SELECT * FROM machine_state_keys WHERE machine_id = $1", [room]);
      const row = rows[0];
      if (!row) return null;
      return {
        keyId: row.key_id,
        sealed: row.sealed === null ? null : Buffer.from(row.sealed, "base64"),
        createdAt: numberOrNull(row.created_at),
        lastBoot: numberOrNull(row.last_boot),
        withheld: row.withheld,
        revokedAt: numberOrNull(row.revoked_at),
      };
    },
    async recordBoot(room, boot, withhold) {
      await db.query(
        `INSERT INTO machine_state_keys (machine_id, last_boot, withheld, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (machine_id) DO UPDATE SET
           last_boot = $2, withheld = machine_state_keys.withheld OR $3, updated_at = $4`,
        [room, boot, withhold, Date.now()],
      );
    },
    async putShare(room, { keyId, sealed, createdAt }) {
      const { rowCount } = await db.query(
        `UPDATE machine_state_keys SET key_id = $2, sealed = $3, created_at = $4, withheld = FALSE, updated_at = $5
         WHERE machine_id = $1 AND revoked_at IS NULL`,
        [room, keyId, sealed.toString("base64"), createdAt, Date.now()],
      );
      return rowCount > 0;
    },
    async revoke(room, now) {
      await db.query(
        `INSERT INTO machine_state_keys (machine_id, revoked_at, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (machine_id) DO UPDATE SET
           key_id = NULL, sealed = NULL, created_at = NULL, revoked_at = $2, updated_at = $3`,
        [room, now, Date.now()],
      );
    },
    async reinstate(room) {
      const { rowCount } = await db.query(
        `UPDATE machine_state_keys SET revoked_at = NULL, updated_at = $2
         WHERE machine_id = $1 AND revoked_at IS NOT NULL`,
        [room, Date.now()],
      );
      return rowCount > 0;
    },
  };
}

/** Sealed shares start with their format's version, so STATE_KEY_SECRET can be rotated later. */
const SEALED_V1 = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The AES-256-GCM key STATE_KEY_SECRET derives: never the secret itself. */
const sealingKey = (secret: string) =>
  Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "swiff-state-key-sealing-v1", 32));

/** Bound to its machine and its id, so a sealed share copied onto another row opens nothing. */
const aad = (room: string, keyId: string) => Buffer.from(`swiff-state-key\0${room}\0${keyId}`);

/** `share` sealed with AES-256-GCM under `key`, bound to `room` and `keyId`: version, IV, tag, ciphertext. */
function seal(key: Buffer, room: string, keyId: string, share: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(room, keyId));
  const body = Buffer.concat([cipher.update(share), cipher.final()]);
  return Buffer.concat([Buffer.from([SEALED_V1]), iv, cipher.getAuthTag(), body]);
}

/** The share in `sealed`; throws when it was sealed with another secret, for another row, or altered. */
function unseal(key: Buffer, room: string, keyId: string, sealed: Buffer): Buffer {
  if (sealed[0] !== SEALED_V1 || sealed.length !== 1 + IV_BYTES + TAG_BYTES + STATE_KEY_BYTES) {
    throw new Error("unknown sealed state key format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(1, 1 + IV_BYTES));
  decipher.setAAD(aad(room, keyId));
  decipher.setAuthTag(sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(sealed.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]);
}

/** What state-key.ts reports for review: never a share, a sealed share or the secret. */
export type StateKeySecurityEvent =
  | {
      event: "state-key-withheld";
      machine: string;
      keyId: string;
      lastBoot: number | null;
      boot: number | null;
    }
  | {
      event: "state-key-replaced";
      machine: string;
      keyId: string;
      previous: string | null;
      boot: number | null;
    }
  | { event: "state-key-revoked"; machine: string; previous: string | null }
  | { event: "state-key-reinstated"; machine: string };

/** The default security log: one JSON line on stderr. */
const logSecurityEvent = (event: StateKeySecurityEvent) =>
  console.warn(`[swiff] security event ${JSON.stringify(event)}`);

/** A state-key call's answer: the share, or a refusal with its status. */
export type StateKeyResult =
  | { ok: true; status: 200 | 201; grant: StateKeyGrant }
  | { ok: false; status: number; body: StateKeyError; retryAfterSeconds?: number };

export type StateKeys = {
  /**
   * Machine `room` just passed attestation at the boot `boot` counts (null:
   * not counted). Withholds its share when that boot does not follow the last
   * one. Rejects only when the store fails; attestation then mints nothing.
   */
  observe(room: string, boot: number | null, now?: number): Promise<void>;
  /** POST: the machine's current share, for `credential` (attestation.credential). */
  release(room: string, credential: Credential | null, now?: number): Promise<StateKeyResult>;
  /** PUT: a new share for the machine, replacing any it had. */
  replace(room: string, credential: Credential | null, now?: number): Promise<StateKeyResult>;
  /** Destroy the machine's share and refuse it any until reinstated. */
  revoke(room: string, now?: number): Promise<void>;
  /** Let a revoked machine ask for a new share (PUT) again. */
  reinstate(room: string): Promise<void>;
};

export type StateKeyOptions = {
  store: StateKeyStore;
  /** STATE_KEY_SECRET; null: every call answers 503 not-configured. */
  secret: string | null;
  /** Says whether a machine is waiting out a firmware cooldown. */
  verifier?: AttestationVerifier | null;
  /** Each machine's budget of state-key calls. */
  budget?: RequestBudget;
  freshSeconds?: number;
  securityLog?: (event: StateKeySecurityEvent) => void;
};

/** Whether a boot counted `boot` follows one counted `last`: the same boot again, or the next. */
const follows = (last: number | null, boot: number | null) =>
  last !== null && boot !== null && (boot === last || boot === last + 1);

/**
 * The state keys of every machine, kept in `store` and sealed with `secret`.
 * Calls for one machine take turns in this process; the store's writes keep a
 * revocation made from another process (state-key.ts header, cli.ts).
 */
export function createStateKeys({
  store,
  secret,
  verifier = null,
  budget = new RequestBudget({ burst: STATE_KEY_BURST, refillMs: STATE_KEY_REFILL_MS }),
  freshSeconds = STATE_KEY_FRESH_SECONDS,
  securityLog = logSecurityEvent,
}: StateKeyOptions): StateKeys {
  const key = secret ? sealingKey(secret) : null;
  const inTurn = perRoom();
  /** Host certificate id → when it expires (Unix ms), once it has got a share. */
  const used = new Map<string, number>();
  /** A refusal with its status, and when to come back for a 429. */
  const refuse = (
    status: number,
    error: StateKeyError["error"],
    retryAfterSeconds?: number,
  ): StateKeyResult => ({
    ok: false,
    status,
    body: { error },
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });

  /**
   * The checks every state-key call makes, in order: the record to act on, or
   * the refusal. Called in the machine's turn.
   */
  /** `refusal` as admit's answer. */
  const no = (refusal: StateKeyResult) => ({ admitted: false, refusal }) as const;

  async function admit(
    room: string,
    credential: Credential | null,
    now: number,
  ): Promise<
    | { admitted: true; record: StateKeyRecord; cert: { id: string; exp: number } }
    | { admitted: false; refusal: StateKeyResult }
  > {
    if (!key) return no(refuse(503, "not-configured"));
    if (!credential) return no(refuse(401, "bad-host-cert"));
    if (credential.kind !== "host-cert") return no(refuse(403, "attestation-required"));
    const waitMs = budget.take(room);
    if (waitMs > 0) return no(refuse(429, "rate-limited", Math.ceil(waitMs / 1000)));
    for (const [id, until] of used) if (until <= now) used.delete(id);
    if (
      credential.iat === null ||
      now - credential.iat * 1000 > freshSeconds * 1000 ||
      used.has(credential.id)
    ) {
      return no(refuse(401, "stale-host-cert"));
    }
    const record = await store.get(room);
    if (record?.revokedAt != null) return no(refuse(403, "revoked"));
    // Defense in depth: closes the race where a firmware-changed refusal or an
    // EK re-enrollment lands after a host certificate was minted but before
    // the key is released.
    if (await verifier?.inCooldown?.(room, now)) return no(refuse(403, "firmware-cooldown"));
    // Every attestation that minted a certificate was observed first, so a
    // record whose latest boot is not the certificate's has seen a later one.
    if (!record || record.lastBoot !== credential.boot) return no(refuse(401, "stale-host-cert"));
    return { admitted: true, record, cert: { id: credential.id, exp: credential.exp } };
  }

  /** Answer `run`, and log only the kind of any failure: the store's errors could carry anything. */
  const guarded = async (run: () => Promise<StateKeyResult>): Promise<StateKeyResult> => {
    try {
      return await run();
    } catch (error) {
      console.error("[swiff] state key call failed:", error instanceof Error ? error.name : typeof error);
      return refuse(500, "internal-error");
    }
  };

  return {
    observe: (room, boot) =>
      inTurn(room, async () => {
        const existing = await store.get(room);
        const record = existing ?? empty();
        const gap = Boolean(record.keyId) && !record.withheld && !follows(record.lastBoot, boot);
        if (gap) {
          securityLog({
            event: "state-key-withheld",
            machine: room,
            keyId: record.keyId!,
            lastBoot: record.lastBoot,
            boot,
          });
        }
        if (existing && !gap && existing.lastBoot === boot) return;
        await store.recordBoot(room, boot, gap);
      }),

    release: (room, credential, now = Date.now()) =>
      guarded(() =>
        inTurn(room, async () => {
          const admitted = await admit(room, credential, now);
          if (!admitted.admitted) return admitted.refusal;
          const { record, cert } = admitted;
          if (!record.keyId || !record.sealed) return refuse(404, "no-state-key");
          if (record.withheld) return refuse(409, "continuity-gap");
          let share: Buffer;
          try {
            share = unseal(key!, room, record.keyId, record.sealed);
          } catch {
            console.error(
              `[swiff] the state key of ${room} cannot be unsealed: was STATE_KEY_SECRET changed?`,
            );
            return refuse(500, "internal-error");
          }
          used.set(cert.id, cert.exp * 1000);
          return { ok: true, status: 200, grant: { keyId: record.keyId, share: share.toString("base64") } };
        }),
      ),

    replace: (room, credential, now = Date.now()) =>
      guarded(() =>
        inTurn(room, async () => {
          const admitted = await admit(room, credential, now);
          if (!admitted.admitted) return admitted.refusal;
          const { record, cert } = admitted;
          const share = randomBytes(STATE_KEY_BYTES);
          const keyId = randomBytes(12).toString("base64url");
          const sealed = seal(key!, room, keyId, share);
          if (!(await store.putShare(room, { keyId, sealed, createdAt: now }))) return refuse(403, "revoked");
          used.set(cert.id, cert.exp * 1000);
          securityLog({
            event: "state-key-replaced",
            machine: room,
            keyId,
            previous: record.keyId,
            boot: record.lastBoot,
          });
          return { ok: true, status: 201, grant: { keyId, share: share.toString("base64") } };
        }),
      ),

    revoke: (room, now = Date.now()) =>
      inTurn(room, async () => {
        const previous = (await store.get(room))?.keyId ?? null;
        await store.revoke(room, now);
        securityLog({ event: "state-key-revoked", machine: room, previous });
      }),

    reinstate: (room) =>
      inTurn(room, async () => {
        if (!(await store.reinstate(room))) return;
        securityLog({ event: "state-key-reinstated", machine: room });
      }),
  };
}

/** STATE_KEY_SECRET from the environment, and what is wrong with it. */
export function stateKeySecretFromEnv(env: NodeJS.ProcessEnv): { secret: string | null; warnings: string[] } {
  const secret = env.STATE_KEY_SECRET?.trim() ?? "";
  if (!secret) {
    return {
      secret: null,
      warnings: ["STATE_KEY_SECRET is not set — no rental-mode PC can unlock its state"],
    };
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    return {
      secret: null,
      warnings: [
        `STATE_KEY_SECRET is shorter than ${MIN_SECRET_LENGTH} characters — no rental-mode PC can unlock its state`,
      ],
    };
  }
  const warnings =
    secret === env.ROOM_SECRET?.trim()
      ? ["STATE_KEY_SECRET is ROOM_SECRET — give the state keys a secret of their own"]
      : [];
  return { secret, warnings };
}
