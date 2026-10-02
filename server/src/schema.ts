// The platform's tables, made by migrations: on open, each one the database
// has not had yet runs, in order, and is recorded in schema_migrations, all in
// one transaction. A database already at the latest version is left as it is,
// so a server restarting against it starts at once. A released migration is
// never edited: a change is a new one at the end of MIGRATIONS.
//
// Two processes opening the same database at once (a deploy overlapping the
// instance it replaces, the seed-requirements CLI) take turns on an advisory
// lock, so the tables are made once.

import type { Database } from "./db.js";

/** Held while migrating. Any constant will do: nothing else here takes advisory locks. */
const MIGRATION_LOCK = 5_317_001;

/** Each migration's statements, in order; the version is its place in the list, from 1. */
export const MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE machines (
      id              TEXT PRIMARY KEY,
      -- Its owner's Steam id, as configured at its last check-in.
      owner_id        TEXT,
      -- Cents per hour.
      price           BIGINT NOT NULL DEFAULT 0,
      status          TEXT NOT NULL
                      CHECK (status IN ('idle', 'available', 'reserved', 'in_session', 'offline')),
      available_until BIGINT,
      last_seen_at    BIGINT NOT NULL,
      -- The instant offered time has been counted up to in machine_uptime.
      uptime_at       BIGINT,
      -- The host's report, all null until it sends one. gpu_score is gpu_model's
      -- score in @swiff/rank's GPU table (RTX 3060 = 100); encoders, display
      -- and controls hold JSON.
      name            TEXT,
      gpu_model       TEXT,
      gpu_score       INTEGER,
      vram_mb         INTEGER,
      ram_mb          INTEGER,
      cpu_model       TEXT,
      cpu_cores       INTEGER,
      encoders        TEXT,
      display         TEXT,
      controls        TEXT,
      rtt_ms          DOUBLE PRECISION,
      jitter_ms       DOUBLE PRECISION,
      up_mbps         DOUBLE PRECISION
    )`,
    `CREATE TABLE bookings (
      id           TEXT PRIMARY KEY,
      -- The order bookings were made in, for the queue: two can share a millisecond.
      seq          BIGINT GENERATED ALWAYS AS IDENTITY,
      renter_id    TEXT,
      game_id      BIGINT NOT NULL,
      minutes      INTEGER NOT NULL,
      status       TEXT NOT NULL
                   CHECK (status IN ('queued', 'matched', 'claimed', 'playing', 'ended', 'expired')),
      created_at   BIGINT NOT NULL,
      -- The renter's last contact (booking or checking on it); a queue timeout.
      last_seen_at BIGINT NOT NULL
    )`,
    // A reservation lives only while it is waiting to be claimed, so one per
    // machine and one per booking is the whole rule.
    `CREATE TABLE reservations (
      id         TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL UNIQUE REFERENCES bookings (id),
      machine_id TEXT NOT NULL UNIQUE REFERENCES machines (id),
      expires_at BIGINT NOT NULL
    )`,
    // started_at is when the renter arrived (the host says so); expires_at is
    // when the join ticket runs out, the backstop if the host never ends it.
    // ticket_id is the join ticket handed out at claim; it stops opening the
    // room once ended_at is set. end_reason is set when the session ends; qos
    // holds the renter's QosSummary as JSON.
    `CREATE TABLE sessions (
      id         TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL UNIQUE REFERENCES bookings (id),
      machine_id TEXT NOT NULL REFERENCES machines (id),
      started_at BIGINT,
      ended_at   BIGINT,
      expires_at BIGINT NOT NULL,
      -- Cents charged for the time played.
      price      BIGINT,
      ticket_id  TEXT UNIQUE,
      end_reason TEXT CHECK (end_reason IN
                   ('renter', 'time_up', 'host_offline', 'owner_kill', 'host_end', 'grace_expired')),
      qos        TEXT
    )`,
    // The live host session (sessions.ts) of a machine's open session: which
    // session keys still register its room. grant_id is new with every start,
    // so keys from a host session that was ended stay dead if the same session
    // starts again. The row goes when the host session or the session ends.
    `CREATE TABLE key_sessions (
      machine_id TEXT PRIMARY KEY REFERENCES machines (id),
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions (id),
      grant_id   TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX sessions_one_open_per_machine ON sessions (machine_id) WHERE ended_at IS NULL`,
    `CREATE INDEX sessions_by_machine ON sessions (machine_id, ended_at)`,
    `CREATE INDEX bookings_queue ON bookings (status, created_at, seq)`,
    // The Steam games installed on each machine, replaced whole when the host reports them.
    `CREATE TABLE machine_games (
      machine_id TEXT NOT NULL REFERENCES machines (id),
      appid      BIGINT NOT NULL,
      PRIMARY KEY (machine_id, appid)
    )`,
    // Per machine and UTC day (YYYY-MM-DD): how long it was offered, how much
    // of that a heartbeat or open socket covered, and how often it was dropped
    // as offline.
    `CREATE TABLE machine_uptime (
      machine_id TEXT NOT NULL REFERENCES machines (id),
      day        TEXT NOT NULL,
      offered_ms BIGINT NOT NULL DEFAULT 0,
      seen_ms    BIGINT NOT NULL DEFAULT 0,
      drops      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (machine_id, day)
    )`,
    // What each game needs (requirements.ts).
    `CREATE TABLE game_requirements (
      appid         BIGINT PRIMARY KEY,
      min_gpu_score INTEGER NOT NULL,
      rec_gpu_score INTEGER NOT NULL,
      -- 0: not stated.
      min_ram_mb    INTEGER NOT NULL DEFAULT 0,
      min_vram_mb   INTEGER NOT NULL DEFAULT 0,
      source        TEXT NOT NULL CHECK (source IN ('steam', 'curated', 'default')),
      updated_at    BIGINT NOT NULL
    )`,
  ],
];

/**
 * Bring the database up to the latest migration, making its tables on first
 * open. Resolves with the version it is at. A database a newer release
 * migrated further is left alone.
 */
export async function migrate(db: Database): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await tx.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    INTEGER PRIMARY KEY,
         applied_at BIGINT NOT NULL
       )`,
    );
    const { rows } = await tx.query<{ version: number }>(
      "SELECT coalesce(max(version), 0) AS version FROM schema_migrations",
    );
    let version = rows[0]!.version;
    for (; version < MIGRATIONS.length; version++) {
      for (const statement of MIGRATIONS[version]!) await tx.query(statement);
      await tx.query("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)", [
        version + 1,
        Date.now(),
      ]);
    }
    return version;
  });
}
