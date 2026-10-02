// The database layer (db.ts) on whichever Postgres the tests run on: what
// comes back, what a transaction keeps, and a connection the server cut.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDatabase, postgres } from "../db.js";
import { serverDatabase, testDatabase } from "./db.js";

describe("database", () => {
  it("hands back BIGINT times as numbers", async () => {
    const db = await testDatabase();
    const at = Date.UTC(2026, 8, 30, 12);
    const { rows } = await db.query<{ at: unknown }>("SELECT $1::bigint AS at", [at]);
    assert.deepEqual(rows, [{ at }]);
    await db.close();
  });

  it("keeps a transaction that resolves and undoes one that throws", async () => {
    const db = await testDatabase();
    await db.query("CREATE TABLE n (n INTEGER)");
    assert.equal(
      await db.transaction(async (tx) => (await tx.query("INSERT INTO n VALUES (1)")).rowCount),
      1,
    );
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO n VALUES (2)");
        throw new Error("changed its mind");
      }),
      /changed its mind/,
    );
    assert.deepEqual((await db.query("SELECT n FROM n")).rows, [{ n: 1 }]);
    await db.close();
  });

  it("keeps a database in memory when DATABASE_URL names none", async () => {
    const db = openDatabase(undefined);
    assert.deepEqual((await db.query("SELECT 1 AS one")).rows, [{ one: 1 }]);
    await db.close();
  });

  it("opens a new connection for one the server cut while it was idle", async () => {
    const server = await serverDatabase();
    const db = postgres(server.url);
    try {
      assert.deepEqual((await db.query("SELECT 1 AS one")).rows, [{ one: 1 }]);
      await server.dropConnections();
      // The pool hears its idle connection go, and drops it without crashing.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual((await db.query("SELECT 2 AS two")).rows, [{ two: 2 }]);
    } finally {
      await db.close();
      await server.close();
    }
  });
});
