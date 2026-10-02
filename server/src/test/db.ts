// The databases the tests run on.
//
// With TEST_DATABASE_URL set (CI sets it to its Postgres service), every test
// gets a schema of its own on that server, dropped afterwards, so test files
// running side by side never meet. Without it, the tests need no database
// server: an in-process test gets a schema of its own in one PGlite database
// in memory, and a test that starts the real server gets a fresh PGlite
// served over the Postgres protocol, which the server reaches through `pg`
// exactly as it reaches Neon.
//
//   docker run --rm -e POSTGRES_HOST_AUTH_METHOD=trust -p 5432:5432 postgres:17
//   TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm test -w @swiff/server

import { randomBytes } from "node:crypto";
import { after } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import pg from "pg";
import { inMemory, postgres, type Database } from "../db.js";

const SERVER = process.env.TEST_DATABASE_URL || null;

/** A schema name no other test has. */
const freshSchema = () => `t_${randomBytes(6).toString("hex")}`;

/** `url` with every connection's search_path set to `schema`, and named after it. */
function inSchema(url: string, schema: string): string {
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  scoped.searchParams.set("application_name", schema);
  return scoped.toString();
}

/** Run `sql` on a connection of its own to `url`. */
async function withClient(url: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `sql` on the test server. */
const onServer = (sql: string) => withClient(SERVER!, sql);

/** The in-memory database this file's in-process tests share, one schema each. */
let shared: Database | null = null;
// Left open, Postgres's own idle timers would hold the process for seconds
// after the file's last test.
after(() => shared?.close());

/** An empty schema of one test's own. */
export type TestSchema = {
  /** A connection to it, as often as the test likes: a platform restarting opens another. */
  open(): Database;
  /** Remove it and everything in it. */
  drop(): Promise<void>;
};

/** A fresh, empty schema for one test. */
export async function testSchema(): Promise<TestSchema> {
  const schema = freshSchema();
  if (SERVER) {
    await onServer(`CREATE SCHEMA ${schema}`);
    return {
      open: () => postgres(inSchema(SERVER, schema)),
      drop: () => onServer(`DROP SCHEMA ${schema} CASCADE`),
    };
  }
  shared ??= inMemory();
  const db = shared;
  await db.query(`CREATE SCHEMA ${schema}`);
  // One connection: the schema is chosen afresh for every statement and transaction.
  const within = `SET search_path TO ${schema}`;
  return {
    open: () => ({
      query: (sql, params) => db.transaction((tx) => tx.query(sql, params), `${within}; BEGIN`),
      transaction: (work, begin = "BEGIN", setup) => db.transaction(work, `${within}; ${begin}`, setup),
      close: async () => {},
    }),
    drop: async () => {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
    },
  };
}

/**
 * An empty database of its own for one test: give it to Platform.open, or
 * migrate it. Closing it drops everything the test made.
 */
export async function testDatabase(): Promise<Database> {
  const schema = await testSchema();
  const db = schema.open();
  return {
    ...db,
    async close() {
      await db.close();
      await schema.drop();
    },
  };
}

/** A database the real server can be started on, and the test can reach behind its back. */
export type ServerDatabase = {
  /** For the server's DATABASE_URL. */
  url: string;
  /** Run statements without parameters on the database, as another client would. */
  exec(sql: string): Promise<void>;
  /** Cut every connection to it, as Neon does when its compute suspends. */
  dropConnections(): Promise<void>;
  close(): Promise<void>;
};

/**
 * A fresh database for a server process: a schema on TEST_DATABASE_URL, or a
 * PGlite in this process that the server reaches over a local socket. Several
 * servers in turn may open the same one, as after a restart.
 */
export async function serverDatabase(): Promise<ServerDatabase> {
  if (SERVER) {
    const schema = freshSchema();
    await onServer(`CREATE SCHEMA ${schema}`);
    const url = inSchema(SERVER, schema);
    return {
      url,
      exec: (sql) => withClient(url, sql),
      dropConnections: () =>
        onServer(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = '${schema}'`,
        ),
      close: () => onServer(`DROP SCHEMA ${schema} CASCADE`),
    };
  }
  const db = new PGlite();
  // Takes turns between connections, a transaction at a time.
  const socket = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1", maxConnections: 16 });
  await socket.start();
  const url = `postgres://postgres@${socket.getServerConn()}/postgres`;
  return {
    url,
    exec: (sql) => withClient(url, sql),
    async dropConnections() {
      await socket.stop();
      await socket.start();
    },
    async close() {
      // A connection still detaching when PGlite closes throws where nothing
      // catches it: let the ones already closing finish first.
      for (let i = 0; i < 40 && socket.getStats().activeConnections > 0; i++) await settle(50);
      await socket.stop();
      await settle(50);
      await db.close();
    },
  };
}
