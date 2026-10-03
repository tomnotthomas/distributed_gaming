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
        "game_requirements",
        "key_sessions",
        "machine_games",
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
