// The platform database: Postgres through `pg` when DATABASE_URL names a
// server (Neon, in production), or PGlite, the same Postgres compiled to
// WebAssembly, in this process's memory when it does not, so local dev, the
// tests and the e2e runs need no database server. In memory, everything is gone
// when the process ends.
//
// Nothing is kept in local files: a host whose disk is thrown away, and that
// sleeps when idle, loses nothing that Postgres holds. The tables are made by
// the migrations in schema.ts.
//
// A Neon connection string works as it is given, sslmode=require included. A
// connection Neon drops while idle (its compute suspends) is replaced on the
// next query rather than taking the process down.

import { PGlite, types as pgliteTypes } from "@electric-sql/pglite";
import pg from "pg";

export type Row = Record<string, unknown>;

/** Somewhere statements run: the database, or one transaction in it. */
export type Queryable = {
  /** One statement, `$1`, `$2`… bound to `params`: the rows it returned and how many it changed. */
  query<T = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
};

export type Database = Queryable & {
  /**
   * Run `work` as one transaction on a connection of its own, opened with
   * `begin` (statements without parameters, e.g. "BEGIN; LOCK TABLE …"):
   * committed when `work` resolves, rolled back when it throws.
   */
  transaction<T>(work: (tx: Queryable) => Promise<T>, begin?: string): Promise<T>;
  close(): Promise<void>;
};

/**
 * Timestamps are Unix ms in BIGINT columns, which `pg` hands back as strings
 * unless told otherwise. Every value stored here is a safe integer.
 */
const PG_TYPES: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    oid === pg.types.builtins.INT8
      ? Number
      : pg.types.getTypeParser(oid, format as "text")) as pg.CustomTypesConfig["getTypeParser"],
};

/** A Postgres server, at a connection string such as Neon's. */
export function postgres(connectionString: string): Database {
  const pool = new pg.Pool({
    connectionString,
    types: PG_TYPES,
    // A suspended Neon compute takes a few seconds to wake.
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
  });
  // An idle connection the server closed (Neon suspending, a restart): the pool
  // drops it and opens another when next asked. Unhandled, it would crash us.
  pool.on("error", (error) => console.error("[swiff] database connection lost:", error.name));
  return {
    async query(sql, params) {
      const result = await pool.query(sql, params);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
    async transaction(work, begin = "BEGIN") {
      const client = await pool.connect();
      // A connection that cannot even roll back is broken: it is closed, not reused.
      let broken: Error | undefined;
      // One lost mid-transaction (the pool stops listening while it is checked
      // out) fails the statement waiting on it; unheard, it would crash us.
      const onError = (error: Error) => {
        console.error("[swiff] database connection lost:", error.name);
        broken = error;
      };
      client.on("error", onError);
      try {
        await client.query(begin);
        const result = await work({
          async query(sql, params) {
            const answer = await client.query(sql, params);
            return { rows: answer.rows, rowCount: answer.rowCount ?? 0 };
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch((rollback: Error) => (broken = rollback));
        throw error;
      } finally {
        client.off("error", onError);
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
}

/**
 * A database in this process's memory, gone when it ends. One connection, so
 * transactions and statements take turns rather than interleave.
 */
export function inMemory(): Database {
  const db = new PGlite({ parsers: { [pgliteTypes.INT8]: Number } });
  let last: Promise<unknown> = Promise.resolve();
  /** Run `work` once everything asked for before it has finished. */
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const run = last.then(work);
    last = run.catch(() => {});
    return run;
  };
  const statement: Queryable = {
    async query(sql, params) {
      const result = await db.query(sql, params);
      return { rows: result.rows as never[], rowCount: result.affectedRows ?? 0 };
    },
  };
  return {
    query: (sql, params) => inTurn(() => statement.query(sql, params)),
    transaction: (work, begin = "BEGIN") =>
      inTurn(async () => {
        await db.exec(begin);
        try {
          const result = await work(statement);
          await db.exec("COMMIT");
          return result;
        } catch (error) {
          await db.exec("ROLLBACK").catch(() => {});
          throw error;
        }
      }),
    close: () => inTurn(() => db.close()),
  };
}

/** The database DATABASE_URL names, or one in memory when it names none. */
export function openDatabase(url: string | undefined): Database {
  return url ? postgres(url) : inMemory();
}
