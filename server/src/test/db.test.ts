// The database layer (db.ts) on whichever Postgres the tests run on: what
// comes back, what a transaction keeps, a connection the server cut, and the
// limits that keep one stuck statement from holding up every call.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIMITS, openDatabase, postgres, type Database, type Limits } from "../db.js";
import { serverDatabase, testDatabase } from "./db.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Why a limit test cannot run here: PGlite runs every statement inside this process. */
const NEEDS_SERVER = process.env.TEST_DATABASE_URL
  ? false
  : "needs a Postgres server: set TEST_DATABASE_URL (CI does)";

/** Run `work` on a fresh database on the test server, through `postgres()` with `limits`. */
async function withLimits(limits: Partial<Limits>, work: (db: Database, url: string) => Promise<void>) {
  const server = await serverDatabase();
  const db = postgres(server.url, { ...LIMITS, ...limits });
  try {
    await work(db, server.url);
  } finally {
    await db.close();
    await server.close();
  }
}

/** How long `promise` takes to reject, after checking that it does with `error`. */
async function rejectsWithin(promise: Promise<unknown>, error: RegExp | object): Promise<number> {
  const started = Date.now();
  await assert.rejects(promise, error);
  return Date.now() - started;
}

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

  it(
    "cancels a statement that runs past its limit, and the connection serves the next",
    { skip: NEEDS_SERVER },
    async () => {
      await withLimits({ statementMs: 200 }, async (db) => {
        const took = await rejectsWithin(
          db.transaction((tx) => tx.query("SELECT pg_sleep(5)")),
          { code: "57014" },
        );
        assert.ok(took < 3_000, `cancelled after ${took} ms`);
        assert.deepEqual((await db.transaction((tx) => tx.query("SELECT 1 AS one"))).rows, [{ one: 1 }]);
      });
    },
  );

  it("gives up waiting for a lock another server holds", { skip: NEEDS_SERVER }, async () => {
    await withLimits({ lockMs: 200 }, async (db, url) => {
      await db.query("CREATE TABLE shared (n INTEGER)");
      const other = postgres(url);
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => (locked = resolve));
      const held = other.transaction(
        async () => {
          locked();
          await wait(1_500);
        },
        "BEGIN",
        "LOCK TABLE shared IN EXCLUSIVE MODE",
      );
      await holding;
      const took = await rejectsWithin(
        db.transaction(async () => {}, "BEGIN", "LOCK TABLE shared IN EXCLUSIVE MODE"),
        { code: "55P03" },
      );
      assert.ok(took < 1_200, `gave up after ${took} ms`);
      await held;
      await other.close();
    });
  });

  it(
    "drops a connection whose statement never answers, without waiting on it",
    { skip: NEEDS_SERVER },
    async () => {
      // The server would let it run: only this side's limit can end the wait.
      await withLimits({ statementMs: 60_000, answerMs: 300 }, async (db) => {
        const took = await rejectsWithin(
          db.transaction((tx) => tx.query("SELECT pg_sleep(5)")),
          /Query read timeout/,
        );
        // A rollback on that connection would have waited out the sleep.
        assert.ok(took < 2_500, `gave up after ${took} ms`);
        assert.deepEqual((await db.transaction((tx) => tx.query("SELECT 2 AS two"))).rows, [{ two: 2 }]);
      });
    },
  );

  it("ends a transaction left idle past its limit, and serves the next", { skip: NEEDS_SERVER }, async () => {
    await withLimits({ idleInTransactionMs: 200 }, async (db) => {
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.query("SELECT 1");
          await wait(1_000);
          await tx.query("SELECT 2");
        }),
      );
      assert.deepEqual((await db.transaction((tx) => tx.query("SELECT 3 AS three"))).rows, [{ three: 3 }]);
    });
  });
});
