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
  [
    // The renter's round trips the booking was made with, as JSON (platform.ts
    // Rtts): matching judges each machine's latency by them. Null for a booking
    // made before they were kept, which counts the renter's leg as nothing.
    `ALTER TABLE bookings ADD COLUMN rtts TEXT`,
    // How the renter plays: the controls they turned on, as JSON, and their
    // Picture setting, which matching ranks by. Null for a booking made before
    // they were kept, which asks for no controls and the best picture.
    `ALTER TABLE bookings ADD COLUMN controls TEXT`,
    `ALTER TABLE bookings ADD COLUMN picture TEXT`,
  ],
  [
    // When the reservation was made. Its renter's claim clock starts at their
    // first contact since then, so expires_at is no longer the match plus a
    // fixed window; one made before this was kept had its clock start at the
    // match.
    `ALTER TABLE reservations ADD COLUMN matched_at BIGINT`,
    `UPDATE reservations SET matched_at = expires_at - 60000`,
    `ALTER TABLE reservations ALTER COLUMN matched_at SET NOT NULL`,
  ],
  [
    // What the TPM attestation verifier keeps per machine (tpm-verifier.ts).
    // No foreign key: a machine registers its EK before it first checks in.
    // ek_certificate is base64 DER and ek_intermediates a JSON list of them;
    // firmware_pcrs holds PCRs 0-3 as JSON (pcr -> hex), the baseline from its
    // first attestation, and pending_firmware_pcrs a change seen since
    // pending_since and still cooling down; reset_count, restart_count and
    // tpm_clock (a decimal: it is 64 bits) are from its last accepted quote;
    // reenrolled_at is when the EK was registered again over a firmware
    // baseline, until the firmware has cooled down again.
    `CREATE TABLE machine_attestation (
      machine_id            TEXT PRIMARY KEY,
      ek_certificate        TEXT,
      ek_intermediates      TEXT,
      firmware_pcrs         TEXT,
      pending_firmware_pcrs TEXT,
      pending_since         BIGINT,
      reset_count           BIGINT,
      restart_count         BIGINT,
      tpm_clock             TEXT,
      reenrolled_at         BIGINT,
      updated_at            BIGINT NOT NULL
    )`,
  ],
  [
    // A rental-mode PC restarting between renters with a session claimed in
    // the instant before (platform.ts, the reset hold): until when its silence
    // does not end that session. Null when no reset is held.
    `ALTER TABLE machines ADD COLUMN reset_until BIGINT`,
  ],
  [
    // Each rental-mode PC's state key (state-key.ts): the server's share of
    // the key to its encrypted state partition. No foreign key, as for
    // machine_attestation. key_id names the share and sealed holds it,
    // encrypted with STATE_KEY_SECRET (base64), both null until the machine
    // first asks for one and after it is revoked; last_boot is the TPM
    // resetCount of the machine's latest attested boot; withheld is set when a
    // boot was not the one after the last (something else ran in between) and
    // stays set until the share is replaced; revoked_at is when it was revoked.
    `CREATE TABLE machine_state_keys (
      machine_id TEXT PRIMARY KEY,
      key_id     TEXT,
      sealed     TEXT,
      created_at BIGINT,
      last_boot  BIGINT,
      withheld   BOOLEAN NOT NULL DEFAULT FALSE,
      revoked_at BIGINT,
      updated_at BIGINT NOT NULL
    )`,
  ],
  [
    // A booking that carries on a session its machine lost (platform.ts
    // continueBooking): the lost booking's id, and the machine that lost it,
    // which it is never matched to. Null for every other booking.
    `ALTER TABLE bookings ADD COLUMN continues TEXT`,
    `ALTER TABLE bookings ADD COLUMN avoid_machine_id TEXT`,
    `CREATE INDEX bookings_continues ON bookings (continues) WHERE continues IS NOT NULL`,
  ],
  [
    // Whether Swiff can run each game (playable.ts), next to what it needs in
    // game_requirements: the verdict from the last complete check, its
    // reasons as a JSON list, the launcher account it asks for as JSON
    // ({ launcher, name }, null for none), and when that check was.
    `CREATE TABLE game_playability (
      appid            BIGINT PRIMARY KEY,
      verdict          TEXT NOT NULL CHECK (verdict IN ('playable', 'not-playable', 'unknown')),
      reasons          TEXT NOT NULL,
      requires_account TEXT,
      checked_at       BIGINT NOT NULL
    )`,
    // Launches that keep failing are read from the sessions that ended recently.
    `CREATE INDEX sessions_by_end ON sessions (ended_at)`,
  ],
  [
    // Crews (platform.ts, crews): a player and the friends they invited. Each
    // player owns at most one, made with their first invite link; owner_name
    // is their Steam persona as last read, what an invite says it is from.
    `CREATE TABLE crews (
      id         TEXT PRIMARY KEY,
      owner_id   TEXT NOT NULL UNIQUE,
      owner_name TEXT,
      created_at BIGINT NOT NULL
    )`,
    // Who is in each crew, its owner included. id is the membership's own
    // random id, what leaving or removing names instead of a Steam id; name is
    // their Steam persona as read when they joined. invite_id is the invite
    // they joined by, which names who invited them; null for the owner.
    `CREATE TABLE crew_members (
      id        TEXT NOT NULL UNIQUE,
      crew_id   TEXT NOT NULL REFERENCES crews (id),
      user_id   TEXT NOT NULL,
      name      TEXT,
      invite_id TEXT,
      joined_at BIGINT NOT NULL,
      PRIMARY KEY (crew_id, user_id)
    )`,
    `CREATE INDEX crew_members_by_user ON crew_members (user_id)`,
    // Personal invite links. The link carries the id signed (access.ts), so the
    // id alone opens nothing; revoked_at is when its inviter replaced it. One
    // live link per inviter.
    `CREATE TABLE crew_invites (
      id         TEXT PRIMARY KEY,
      crew_id    TEXT NOT NULL REFERENCES crews (id),
      inviter_id TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      revoked_at BIGINT
    )`,
    `CREATE UNIQUE INDEX crew_invites_live ON crew_invites (inviter_id) WHERE revoked_at IS NULL`,
    // A crew-only machine is offered only to its owner's crewmates (gate E7).
    `ALTER TABLE machines ADD COLUMN crew_only BOOLEAN NOT NULL DEFAULT FALSE`,
  ],
  [
    // The PC service's hosting socket registered as rental mode (said
    // rental: true, or holds an attested host certificate): a rental-mode PC
    // (Swiff OS), whose renter signs in to Steam before the session starts
    // (api.ts, claim).
    `ALTER TABLE machines ADD COLUMN rental_mode BOOLEAN NOT NULL DEFAULT false`,
  ],
  [
    // When the PC said its renter approved the Steam sign-in, on a rental-mode
    // session not yet started: its deadline is then the launch grace (platform.ts).
    `ALTER TABLE sessions ADD COLUMN signed_in_at BIGINT`,
  ],
  [
    // Crews become groups (platform.ts, crews): anyone may found several and
    // join several. owner_id is now the crew's admin, who renames it and
    // removes members, handed on to the longest-standing member when they
    // leave; owner_name stays their Steam persona as last read. name is the
    // crew's own name, null until someone gives it one (the page then calls it
    // after its admin). ready_at is when a PC playing for it was first on
    // offer, which everyone in it hears about once; archived_at is when its
    // last member left.
    `ALTER TABLE crews DROP CONSTRAINT crews_owner_id_key`,
    `CREATE INDEX crews_by_owner ON crews (owner_id)`,
    `ALTER TABLE crews ADD COLUMN name TEXT`,
    `ALTER TABLE crews ADD COLUMN ready_at BIGINT`,
    `ALTER TABLE crews ADD COLUMN archived_at BIGINT`,
    // Whether a member brings a gaming PC to the crew: 'yes' (their PCs play
    // for it, and so does one of theirs first heard from later), 'later' (they
    // put the question off), or null (not asked yet).
    `ALTER TABLE crew_members ADD COLUMN pc TEXT CHECK (pc IN ('yes', 'later'))`,
    // One live link per crew, which anyone in it may share; inviter_id is who
    // made it. Each crew had at most one already: its owner's.
    `DROP INDEX crew_invites_live`,
    `CREATE UNIQUE INDEX crew_invites_live ON crew_invites (crew_id) WHERE revoked_at IS NULL`,
    // The crews each PC plays for, as its owner picked them, in place of
    // playing for every crew its owner is in. machines.crew_only now says the
    // PC plays only for these (gate E7); a PC that is not is open to anyone.
    `CREATE TABLE crew_machines (
      crew_id    TEXT NOT NULL REFERENCES crews (id),
      machine_id TEXT NOT NULL REFERENCES machines (id),
      added_by   TEXT,
      added_at   BIGINT NOT NULL,
      PRIMARY KEY (crew_id, machine_id)
    )`,
    `CREATE INDEX crew_machines_by_machine ON crew_machines (machine_id)`,
    // A crew-only PC played for every crew its owner was in: it now plays for
    // each of them by name, and its owner counts as bringing it to them.
    `INSERT INTO crew_machines (crew_id, machine_id, added_by, added_at)
       SELECT m.crew_id, x.id, x.owner_id, (extract(epoch FROM now()) * 1000)::bigint
         FROM machines x JOIN crew_members m ON m.user_id = x.owner_id
         WHERE x.crew_only`,
    `UPDATE crew_members SET pc = 'yes'
       WHERE EXISTS (SELECT 1 FROM machines x WHERE x.owner_id = crew_members.user_id AND x.crew_only)`,
    // Those crews had their PC already: nobody is told it has just arrived,
    // as if it came with the crew, before anyone joined.
    `UPDATE crews SET ready_at = created_at
       WHERE EXISTS (SELECT 1 FROM crew_machines c WHERE c.crew_id = crews.id)`,
  ],
  [
    // Friend seats (platform.ts, seats): a host keeps a few named seats at
    // their PC for friends. The link carries the id signed (access.ts), so the
    // id alone opens nothing. crew_id is the crew taking the seat joins, one
    // the PC plays for; friend is the name the host gave it, host_name the
    // host's Steam persona as read when they made it. Until expires_at only
    // the friend's link takes it; user_id is who took it, member_id the crew
    // membership taking it made (null when they were in the crew already),
    // and revoked_at when the host took it back, or its holder left the crew.
    `CREATE TABLE seats (
      id          TEXT PRIMARY KEY,
      machine_id  TEXT NOT NULL REFERENCES machines (id),
      crew_id     TEXT NOT NULL REFERENCES crews (id),
      host_id     TEXT NOT NULL,
      host_name   TEXT,
      friend      TEXT NOT NULL,
      created_at  BIGINT NOT NULL,
      expires_at  BIGINT NOT NULL,
      user_id     TEXT,
      user_name   TEXT,
      member_id   TEXT,
      taken_at    BIGINT,
      revoked_at  BIGINT
    )`,
    `CREATE INDEX seats_by_machine ON seats (machine_id) WHERE revoked_at IS NULL`,
    `CREATE INDEX seats_by_user ON seats (user_id) WHERE revoked_at IS NULL`,
    // One seat per friend per PC.
    `CREATE UNIQUE INDEX seats_taken ON seats (machine_id, user_id) WHERE revoked_at IS NULL AND user_id IS NOT NULL`,
  ],
  [
    // Email sign-ups the marketing site once took, and the mails it rendered for
    // them (marketing_outbox). The site asks for no address any more: no code
    // reads or writes the marketing_* tables.
    `CREATE TABLE marketing_signups (
      id               TEXT PRIMARY KEY,
      email            TEXT NOT NULL,
      kind             TEXT NOT NULL CHECK (kind IN ('player', 'host')),
      lang             TEXT NOT NULL CHECK (lang IN ('de', 'en')),
      page             TEXT,
      invite_type      TEXT,
      invite_code      TEXT,
      referral         TEXT NOT NULL UNIQUE,
      confirm_hash     TEXT NOT NULL UNIQUE,
      unsubscribe      TEXT NOT NULL UNIQUE,
      created_at       BIGINT NOT NULL,
      confirm_sent_at  BIGINT NOT NULL,
      confirmed_at     BIGINT,
      unsubscribed_at  BIGINT,
      UNIQUE (email, kind)
    )`,
    `CREATE TABLE marketing_outbox (
      id         TEXT PRIMARY KEY,
      to_address TEXT NOT NULL,
      template   TEXT NOT NULL,
      subject    TEXT NOT NULL,
      html       TEXT NOT NULL,
      text       TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      sent_at    BIGINT
    )`,
  ],
  [
    // Reminders by email, asked for on the app's crew page by a player signed
    // in with Steam (steam_id). Gone since, like the other marketing sign-ups.
    `ALTER TABLE marketing_signups ADD COLUMN steam_id TEXT UNIQUE`,
    `ALTER TABLE marketing_signups DROP CONSTRAINT marketing_signups_kind_check`,
    `ALTER TABLE marketing_signups ADD CONSTRAINT marketing_signups_kind_check
       CHECK (kind IN ('player', 'host', 'reminders'))`,
    `ALTER TABLE marketing_signups ADD CONSTRAINT marketing_signups_reminders_steam_id
       CHECK ((kind = 'reminders') = (steam_id IS NOT NULL))`,
    `ALTER TABLE marketing_signups DROP CONSTRAINT marketing_signups_email_kind_key`,
    `CREATE UNIQUE INDEX marketing_signups_email_kind ON marketing_signups (email, kind) WHERE steam_id IS NULL`,
  ],
  [
    // When each reminder address last got a confirm mail. Unused since.
    `CREATE TABLE marketing_confirm_sends (
      steam_id   TEXT NOT NULL,
      email_hash TEXT NOT NULL,
      sent_at    BIGINT NOT NULL,
      PRIMARY KEY (steam_id, email_hash)
    )`,
  ],
  [
    // A crew's next Zockrunde (platform.ts, setCrewSession): session_at is when
    // it starts (Unix ms), null until its admin sets one; shared_at when someone
    // in it last shared the invite since then, the crew page's "get your
    // people" step. Each member's answer to it is rsvp: 'yes', 'no', or null
    // while open. Moving the date asks everyone again.
    `ALTER TABLE crews ADD COLUMN session_at BIGINT`,
    `ALTER TABLE crews ADD COLUMN shared_at BIGINT`,
    `ALTER TABLE crew_members ADD COLUMN rsvp TEXT CHECK (rsvp IN ('yes', 'no'))`,
  ],
  [
    // Who plays next on a crew's PC (platform.ts, queueNext): the Steam appid a
    // member wants to play next and since when (Unix ms), null while they are
    // not in line. Starting a game takes them out of every crew's line.
    `ALTER TABLE crew_members ADD COLUMN next_game INTEGER`,
    `ALTER TABLE crew_members ADD COLUMN next_at BIGINT`,
  ],
  [
    // The games each member of a crew wants to play at its Zockrunden
    // (platform.ts, wantCrewGame): one row per member and Steam appid, of the
    // games installed on the crew's PCs. Leaving the crew drops a member's.
    `CREATE TABLE crew_game_wants (
      crew_id TEXT NOT NULL REFERENCES crews (id),
      user_id TEXT NOT NULL,
      appid   BIGINT NOT NULL,
      at      BIGINT NOT NULL,
      PRIMARY KEY (crew_id, user_id, appid)
    )`,
  ],
  [
    // Founding a crew is idempotent (platform.ts, createCrew): the key the
    // page founding it sent, so the same founding sent again, retried or
    // tapped twice, is the crew it made rather than a second one. Each
    // founder's keys are their own.
    `ALTER TABLE crews ADD COLUMN found_key TEXT`,
    `CREATE UNIQUE INDEX crews_found_key ON crews (owner_id, found_key) WHERE found_key IS NOT NULL`,
  ],
  [
    // A crew's link made because its admin removed someone (platform.ts,
    // leaveCrew), which renews the link: the crew page says why it is new.
    `ALTER TABLE crew_invites ADD COLUMN after_removal BOOLEAN NOT NULL DEFAULT false`,
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
