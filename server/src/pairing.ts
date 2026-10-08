// Pairing a gaming PC with its owner's Steam account: how a PC gets its
// machine id and key without anyone minting one by hand (cli.ts).
//
//   host app   makes a machine key, keeps it, and opens /pair?k=<SHA-256 of the key>
//   owner      signs in with Steam there and adds the PC:
//              POST /api/pairings { keyHash }   ─►  { machineId }, owned by them
//   host app   asks with the key itself until the server knows it:
//              GET  /api/pairings/mine  Bearer <machine key>  ─►  { machineId, owner }
//
// The key never leaves the PC until it is used: the link and the server carry
// only its hash, as MACHINE_KEYS does. Whoever adds the PC owns it (access.ts
// owners), so they are never matched to it as a renter. That makes the hash a
// claim ticket: the page keeps it out of analytics and the Steam sign-in round
// trip (web/src/swiff/pair.ts), and the app shows whose the PC became (owner:
// their Steam persona, else their Steam id), so a wrong owner is plain to see.
// The page and the app both show a few characters of the hash (pairingCode),
// so the owner can see the PC they add is the one in front of them. The app
// pairs again with the key it keeps, which answers the same machine id, except
// when a paired PC's owner disputes it: then it makes a fresh key, a new claim.
//
// A paired PC is an entry in access.machines and access.owners like any from
// MACHINE_KEYS: loaded when the server starts, added when it is paired, and
// added again when its app asks (a server that started before another one
// paired it). An id MACHINE_KEYS names is never taken over by a pairing, and
// a key MACHINE_KEYS has is never paired again: it answers its own id and owner.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Access } from "./access.js";
import type { Database, Queryable } from "./db.js";

/** The most PCs one Steam account may pair: more than anyone owns, few enough that a script cannot fill the table. */
export const MAX_PAIRED = 10;

/** Held while pairing, so two pairings for one owner count each other. Nothing else takes this lock (schema.ts takes its own). */
const PAIRING_LOCK = 5_317_002;

/** SHA-256 of a machine key, in hex: what the link carries and the server keeps. */
export const KEY_HASH = /^[0-9a-f]{64}$/;

/** The SHA-256 of `key`, in hex, as parseMachineKeys keeps it. */
export const keyHashOf = (key: string): string => createHash("sha256").update(key).digest("hex");

/** The few characters of a key's hash the owner compares between the app and the page: "3F9-A2C". */
export const pairingCode = (keyHash: string): string =>
  `${keyHash.slice(0, 3)}-${keyHash.slice(3, 6)}`.toUpperCase();

/** A new paired PC's machine id: "pc-" and 12 hex characters. */
const newMachineId = () => `pc-${randomBytes(6).toString("hex")}`;

/** Paired now, already paired to this owner, or refused: the key is another owner's, or the owner has MAX_PAIRED PCs. */
export type Paired =
  { ok: true; machineId: string; created: boolean } | { ok: false; reason: "paired-elsewhere" | "too-many" };

export type Pairings = {
  /** Pair the PC whose key hashes to `keyHash` with `owner`'s Steam account. */
  pair(owner: string, keyHash: string): Promise<Paired>;
  /** The machine id paired with `key`, or null while nobody has added it. */
  pairedWith(key: string): Promise<string | null>;
};

type PairedRow = { id: string; key_hash: string; owner_id: string };

/** Make `row` a machine `access` knows; false when MACHINE_KEYS has its id for another key. */
function know(access: Access, row: PairedRow): boolean {
  const known = access.machines.get(row.id);
  if (known && known.toString("hex") !== row.key_hash) return false;
  access.machines.set(row.id, Buffer.from(row.key_hash, "hex"));
  access.owners.set(row.id, row.owner_id);
  return true;
}

/** The id MACHINE_KEYS, or a pairing this server knows, has for `keyHash`; compared in constant time. */
function knownId(access: Access, keyHash: string): string | null {
  const wanted = Buffer.from(keyHash, "hex");
  for (const [id, stored] of access.machines) if (timingSafeEqual(stored, wanted)) return id;
  return null;
}

/**
 * The paired PCs, over `db`, kept in `access`: every one paired so far is
 * loaded into it before this resolves.
 */
export async function openPairings(db: Database, access: Access): Promise<Pairings> {
  const { rows } = await db.query<PairedRow>("SELECT id, key_hash, owner_id FROM paired_machines");
  for (const row of rows) know(access, row);

  const byHash = async (q: Queryable, keyHash: string) =>
    (
      await q.query<PairedRow>("SELECT id, key_hash, owner_id FROM paired_machines WHERE key_hash = $1", [
        keyHash,
      ])
    ).rows[0] ?? null;

  return {
    async pair(owner, keyHash) {
      const known = knownId(access, keyHash);
      if (known) {
        const had = access.owners.get(known);
        return had === undefined || had === owner
          ? { ok: true, machineId: known, created: false }
          : { ok: false, reason: "paired-elsewhere" };
      }
      const paired = await db.transaction(async (tx): Promise<{ answer: Paired; row?: PairedRow }> => {
        await tx.query("SELECT pg_advisory_xact_lock($1)", [PAIRING_LOCK]);
        const had = await byHash(tx, keyHash);
        if (had) {
          return had.owner_id === owner
            ? { answer: { ok: true, machineId: had.id, created: false }, row: had }
            : { answer: { ok: false, reason: "paired-elsewhere" } };
        }
        const { rows: count } = await tx.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM paired_machines WHERE owner_id = $1",
          [owner],
        );
        if (count[0]!.n >= MAX_PAIRED) return { answer: { ok: false, reason: "too-many" } };
        let id = newMachineId();
        while (access.machines.has(id)) id = newMachineId();
        const row = { id, key_hash: keyHash, owner_id: owner };
        await tx.query(
          "INSERT INTO paired_machines (id, key_hash, owner_id, paired_at) VALUES ($1, $2, $3, $4)",
          [id, keyHash, owner, Date.now()],
        );
        return { answer: { ok: true, machineId: id, created: true }, row };
      });
      if (paired.row) know(access, paired.row);
      return paired.answer;
    },
    async pairedWith(key) {
      const known = knownId(access, keyHashOf(key));
      if (known) return known;
      const row = await byHash(db, keyHashOf(key));
      return row && know(access, row) ? row.id : null;
    },
  };
}
