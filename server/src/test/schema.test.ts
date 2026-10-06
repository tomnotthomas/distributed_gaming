// The migrations (schema.ts): an empty database gets every table on first
// open, a migrated one is left as it is, and two servers opening it at once
// make the tables once.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Database } from "../db.js";
import { MIGRATIONS, migrate } from "../schema.js";
import { testSchema } from "./db.js";

/** Run `work` on a fresh schema, which it may connect to as often as it likes, dropped afterwards. */
async function withSchema(work: (open: () => Database) => Promise<void>): Promise<void> {
  const schema = await testSchema();
  try {
    await work(() => schema.open());
  } finally {
    await schema.drop();
  }
}

/** The tables in the connection's schema, by name. */
async function tables(db: Database): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = current_schema() ORDER BY table_name COLLATE "C"`,
  );
  return rows.map((row) => row.name);
}

/** The versions recorded as applied. */
async function versions(db: Database): Promise<number[]> {
  const { rows } = await db.query<{ version: number }>(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  return rows.map((row) => row.version);
}

const LATEST = MIGRATIONS.length;
const ALL = Array.from({ length: LATEST }, (_, i) => i + 1);

describe("migrations", () => {
  it("makes every table on an empty database and records each version", async () => {
    await withSchema(async (open) => {
      const db = open();
      assert.deepEqual(await tables(db), []);
      assert.equal(await migrate(db), LATEST);
      assert.deepEqual(await tables(db), [
        "bookings",
        "crew_invites",
        "crew_machines",
        "crew_members",
        "crews",
        "game_playability",
        "game_requirements",
        "key_sessions",
        "machine_attestation",
        "machine_games",
        "machine_state_keys",
        "machine_uptime",
        "machines",
        "reservations",
        "schema_migrations",
        "sessions",
      ]);
      assert.deepEqual(await versions(db), ALL);
      await db.close();
    });
  });

  it("leaves a migrated database as it is, data and all", async () => {
    await withSchema(async (open) => {
      const db = open();
      await migrate(db);
      await db.query("INSERT INTO machines (id, status, last_seen_at) VALUES ('pc-1', 'idle', 1)");
      assert.equal(await migrate(db), LATEST);
      assert.deepEqual(await versions(db), ALL);
      const { rows } = await db.query("SELECT id FROM machines");
      assert.deepEqual(rows, [{ id: "pc-1" }]);
      await db.close();
    });
  });

  it("makes the tables once when two servers open the database at once", async () => {
    await withSchema(async (open) => {
      const [a, b] = [open(), open()];
      assert.deepEqual(await Promise.all([migrate(a), migrate(b)]), [LATEST, LATEST]);
      assert.deepEqual(await versions(a), ALL);
      await Promise.all([a.close(), b.close()]);
    });
  });

  it("applies a migration whole or not at all", async () => {
    await withSchema(async (open) => {
      const db = open();
      // A table in the way: the first migration cannot make its own.
      await db.query("CREATE TABLE machines (id TEXT)");
      await assert.rejects(migrate(db));
      assert.deepEqual(await tables(db), ["machines"], "nothing it made is left, its record included");
      await db.close();
    });
  });

  it("dates a reservation kept from before its match was recorded to a claim clock started at the match", async () => {
    await withSchema(async (open) => {
      const db = open();
      // A database the release before matched_at left behind, holding a live reservation.
      await db.query(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)",
      );
      for (const [i, statements] of MIGRATIONS.slice(0, 2).entries()) {
        for (const statement of statements) await db.query(statement);
        await db.query("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, 0)", [i + 1]);
      }
      await db.query("INSERT INTO machines (id, status, last_seen_at) VALUES ('pc-1', 'reserved', 1)");
      await db.query(
        `INSERT INTO bookings (id, game_id, minutes, status, created_at, last_seen_at)
           VALUES ('b-1', 730, 30, 'matched', 1, 1)`,
      );
      await db.query(
        "INSERT INTO reservations (id, booking_id, machine_id, expires_at) VALUES ('r-1', 'b-1', 'pc-1', 70000)",
      );

      assert.equal(await migrate(db), LATEST);
      const { rows } = await db.query("SELECT matched_at, expires_at FROM reservations");
      assert.deepEqual(rows, [{ matched_at: 10_000, expires_at: 70_000 }]);
      await db.close();
    });
  });

  it("has each crew-only PC play for the crews its owner was in, once crews become groups", async () => {
    await withSchema(async (open) => {
      const db = open();
      // A database the release before crew_machines left behind: Alex's crew
      // with Sam in it, whose PC is crew-only, and Jo's open PC.
      const before = MIGRATIONS.findIndex((m) => m.some((s) => s.includes("CREATE TABLE crew_machines")));
      assert.ok(before > 0);
      await db.query(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)",
      );
      for (const [i, statements] of MIGRATIONS.slice(0, before).entries()) {
        for (const statement of statements) await db.query(statement);
        await db.query("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, 0)", [i + 1]);
      }
      await db.query(
        `INSERT INTO crews (id, owner_id, owner_name, created_at) VALUES
           ('c-alex', 'alex', 'Alex', 1), ('c-sam', 'sam', 'Sam', 2)`,
      );
      await db.query(
        `INSERT INTO crew_members (id, crew_id, user_id, joined_at) VALUES
           ('m-1', 'c-alex', 'alex', 1), ('m-2', 'c-alex', 'sam', 3), ('m-3', 'c-sam', 'sam', 2),
           ('m-4', 'c-alex', 'jo', 4)`,
      );
      await db.query(
        `INSERT INTO crew_invites (id, crew_id, inviter_id, created_at) VALUES ('i-1', 'c-alex', 'alex', 1)`,
      );
      await db.query(
        `INSERT INTO machines (id, owner_id, status, last_seen_at, crew_only) VALUES
           ('pc-sam', 'sam', 'available', 1, TRUE), ('pc-jo', 'jo', 'available', 1, FALSE)`,
      );

      assert.equal(await migrate(db), LATEST);
      const { rows: plays } = await db.query(
        "SELECT crew_id, machine_id, added_by FROM crew_machines ORDER BY crew_id",
      );
      assert.deepEqual(plays, [
        { crew_id: "c-alex", machine_id: "pc-sam", added_by: "sam" },
        { crew_id: "c-sam", machine_id: "pc-sam", added_by: "sam" },
      ]);
      const { rows: members } = await db.query("SELECT id, pc FROM crew_members ORDER BY id");
      assert.deepEqual(members, [
        { id: "m-1", pc: null },
        { id: "m-2", pc: "yes" },
        { id: "m-3", pc: "yes" },
        { id: "m-4", pc: null },
      ]);
      // Both crews had Sam's PC already, so neither hears it arrive.
      const { rows: crews } = await db.query(
        "SELECT id, name, ready_at IS NOT NULL AS ready FROM crews ORDER BY id",
      );
      assert.deepEqual(crews, [
        { id: "c-alex", name: null, ready: true },
        { id: "c-sam", name: null, ready: true },
      ]);
      // Nor does anyone in them on their next visit.
      const { rows: told } = await db.query(
        "SELECT m.user_id FROM crew_members m JOIN crews c ON c.id = m.crew_id WHERE c.ready_at > m.joined_at",
      );
      assert.deepEqual(told, []);
      // A player may found a second crew now, and its link is its own.
      await db.query("INSERT INTO crews (id, owner_id, created_at) VALUES ('c-alex-2', 'alex', 5)");
      await db.query(
        `INSERT INTO crew_invites (id, crew_id, inviter_id, created_at) VALUES ('i-2', 'c-alex-2', 'alex', 5)`,
      );
      await assert.rejects(
        db.query(
          `INSERT INTO crew_invites (id, crew_id, inviter_id, created_at) VALUES ('i-3', 'c-alex', 'sam', 6)`,
        ),
        "one live link per crew",
      );
      await db.close();
    });
  });

  it("leaves alone a database a newer release migrated further", async () => {
    await withSchema(async (open) => {
      const db = open();
      await migrate(db);
      await db.query("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, 0)", [LATEST + 1]);
      assert.equal(await migrate(db), LATEST + 1);
      await db.close();
    });
  });
});
