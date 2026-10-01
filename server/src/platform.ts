// The platform's state: machines, bookings, reservations and sessions, one
// SQLite table each, and the rules that move a booking through them.
//
//   renter  book ─► queued ─► matched ─► claimed ─► playing ─► ended
//                     │  ▲      │
//                     │  └──────┤ (lapses unclaimed, renter away since the match: back in its place)
//                     │         └──────────► expired (lapses unclaimed, renter saw the match)
//                     └ (renter silent for QUEUE_TIMEOUT_MS) ─► expired
//
//   machine idle ─► available ─► reserved ─► in_session ─► available
//                 (socket dropped, or silent for LIVENESS_MS: offline; taken back: idle)
//
// SQLite through node:sqlite: built into Node 22, so local dev, the tests and
// CI need no database server, no native build and no new dependency. The file
// is DATABASE_PATH; unset, it lives in memory and resets with the process.
//
// Everything here is synchronous and runs in one process, so each method is
// one transaction and nothing else can interleave with it. That, plus the
// unique indexes below, is what gives a machine to at most one booking.
//
// Matching runs in tick(): every call that can free a machine or add a booking
// runs it straight away, and one timer is armed for the next deadline (a
// machine's liveness, a reservation or queued booking lapsing, a session
// running out), so nothing polls. A booking is matched only to a machine with
// its game installed and the hardware the game asks for, judged by
// @swiff/rank's gates against the requirements table.
//
// Presence: a machine whose PC holds its socket open to the server is there
// for as long as it stays open, with no check-in needed. That is kept in
// memory, not in the table: after a restart nobody is connected until they
// reconnect. A renter is there only while their page speaks: a check on the
// booking, opening its event stream, or the page's heartbeat while the stream
// is open. A stream merely held open is no contact: a sleeping laptop's can
// stay open long after the page stopped running.
//
// The host sessions of sessions.ts live here too, in key_sessions, so a server
// restart keeps them and ending a platform session revokes its keys in the
// same transaction.
//
// Every session records why it ended, and machine_uptime keeps each machine's
// offered time, the part a heartbeat or open socket covered and its liveness
// drops per day: with the renter's QoS reports, that is the seven-day
// stability rank() sorts by (stability.ts).
//
// A booking belongs to the renter who made it (renter_id, their Steam id): only
// they can check on it, watch it or claim it. A machine records its owner's
// Steam id (owner_id) each time it checks in, and gate E5 keeps it from its own
// owner.

import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  failedGates,
  gpuScore,
  type Control,
  type Encoder,
  type GameRequirements,
  type GateId,
  type HostProfile,
  type RenterPrefs,
  type StabilityStats,
} from "@swiff/rank";
import type { Display, Hardware, HostReport, Net } from "./profile.js";
import { RequirementsTable } from "./requirements.js";
import type { KeySession, KeySessionStore } from "./sessions.js";
import {
  addQos,
  splitByDay,
  stabilityFrom,
  STABILITY_WINDOW_MS,
  utcDay,
  type EndedSession,
  type EndReason,
  type QosReport,
  type QosSummary,
  type UptimeTotals,
} from "./stability.js";

/**
 * A machine with no open socket that has not checked in for this long is no
 * longer offered. A host without its socket beats every 5 s.
 */
export const LIVENESS_MS = 15_000;
/** How long a matched renter has to claim the machine. A renter who checked in since the match and let it lapse loses the booking. */
export const RESERVATION_MS = 60_000;
/** A queued booking the renter has not checked on for this long is dropped. */
export const QUEUE_TIMEOUT_MS = 2 * 60_000;
/** The longest booking accepted. */
export const MAX_MINUTES = 12 * 60;
/** A renter's last QoS report may arrive this long after the session ended, while its join ticket is still valid. */
export const QOS_GRACE_MS = 60_000;
/** A host's end this close to the session's expiry is time_up, to absorb clock skew between host and server. */
export const TIME_UP_GRACE_MS = 10_000;

export type MachineStatus = "idle" | "available" | "reserved" | "in_session" | "offline";
/** Every status but idle: the owner is offering the machine, whether or not it is answering. */
const OFFERED: MachineStatus[] = ["available", "reserved", "in_session", "offline"];
export type BookingStatus = "queued" | "matched" | "claimed" | "playing" | "ended" | "expired";

/** What an availability call carries: the host's report, plus its terms. */
export type MachineSpec = HostReport & {
  /** Cents per hour. */
  price?: number | undefined;
  /** Unix ms after which the machine is not offered. Omitted: until taken back. */
  availableUntil?: number | null | undefined;
};

export type MachineView = {
  id: string;
  status: MachineStatus;
  gpu: string | null;
  cpu: string | null;
  price: number;
  /** The session running on it, when there is one: the host starts and ends it by this id. */
  session?: { id: string };
};

/** A machine's stored report, as its host last sent it. */
export type MachineProfile = {
  id: string;
  name: string | null;
  /** Null until the host reports its hardware. `gpuScore` is from the GPU score table, 0 when unknown. */
  hardware: (Hardware & { gpuScore: number }) | null;
  games: number[];
  controls: Control[];
  net: Net | null;
};

export type BookingView = {
  bookingId: string;
  status: BookingStatus;
  gameId: number;
  minutes: number;
  /** The machine it was matched to, once there is one. */
  machine?: { id: string; gpu: string | null; cpu: string | null; price: number };
  /** Unix ms by which a matched booking must be claimed. */
  claimBy?: number;
  sessionId?: string;
  /** Cents charged for the time played, once the session has ended. */
  price?: number;
};

/** What the PC is told when a renter claims it: the session to start, the game and the time booked. */
export type ClaimedSession = { sessionId: string; gameId: number; minutes: number };

export type ClaimResult =
  | ({ ok: true; roomId: string } & ClaimedSession)
  | { ok: false; reason: "not-found" | "not-claimable"; status?: BookingStatus };

/** What became of a renter's ticket-authenticated call (a QoS report or leaving): done, or why not. */
export type QosResult = "ok" | "not-found" | "wrong-ticket" | "over";

type MachineRow = {
  id: string;
  owner_id: string | null;
  name: string | null;
  gpu_model: string | null;
  gpu_score: number | null;
  vram_mb: number | null;
  ram_mb: number | null;
  cpu_model: string | null;
  cpu_cores: number | null;
  /** JSON, as are display and controls. */
  encoders: string | null;
  display: string | null;
  controls: string | null;
  rtt_ms: number | null;
  jitter_ms: number | null;
  up_mbps: number | null;
  price: number;
  status: MachineStatus;
  available_until: number | null;
  last_seen_at: number;
  /** The instant offered time has been counted up to in machine_uptime. */
  uptime_at: number | null;
};
type BookingRow = {
  id: string;
  renter_id: string | null;
  game_id: number;
  minutes: number;
  status: BookingStatus;
  last_seen_at: number;
};
type ReservationRow = { id: string; booking_id: string; machine_id: string; expires_at: number };
type SessionRow = {
  id: string;
  booking_id: string;
  machine_id: string;
  started_at: number | null;
  ended_at: number | null;
  expires_at: number;
  price: number | null;
  ticket_id: string | null;
  end_reason: EndReason | null;
  /** JSON QosSummary, null until the renter reports. */
  qos: string | null;
};

// The host's report fills the columns in REPORT_COLUMNS, added below.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS machines (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT,
  price           INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL
                  CHECK (status IN ('idle', 'available', 'reserved', 'in_session', 'offline')),
  available_until INTEGER,
  last_seen_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  id         TEXT PRIMARY KEY,
  renter_id  TEXT,
  game_id    INTEGER NOT NULL,
  minutes    INTEGER NOT NULL,
  status     TEXT NOT NULL
             CHECK (status IN ('queued', 'matched', 'claimed', 'playing', 'ended', 'expired')),
  created_at INTEGER NOT NULL,
  -- The renter's last contact (booking or checking on it); a queue timeout.
  last_seen_at INTEGER NOT NULL
);
-- A reservation lives only while it is waiting to be claimed, so one per
-- machine and one per booking is the whole rule.
CREATE TABLE IF NOT EXISTS reservations (
  id         TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings (id),
  machine_id TEXT NOT NULL UNIQUE REFERENCES machines (id),
  expires_at INTEGER NOT NULL
);
-- started_at is when the renter arrived (the host says so); expires_at is when
-- the join ticket runs out, the backstop if the host never ends it. ticket_id is
-- the join ticket handed out at claim; it stops opening the room once ended_at
-- is set.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings (id),
  machine_id TEXT NOT NULL REFERENCES machines (id),
  started_at INTEGER,
  ended_at   INTEGER,
  expires_at INTEGER NOT NULL,
  price      INTEGER,
  ticket_id  TEXT UNIQUE
);
-- The live host session (sessions.ts) of a machine's open session: which
-- session keys still register its room. grant_id is new with every start, so
-- keys from a host session that was ended stay dead if the same session starts
-- again. The row goes when the host session or the session ends.
CREATE TABLE IF NOT EXISTS key_sessions (
  machine_id TEXT PRIMARY KEY REFERENCES machines (id),
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions (id),
  grant_id   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_open_per_machine
  ON sessions (machine_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_by_machine ON sessions (machine_id, ended_at);
CREATE INDEX IF NOT EXISTS bookings_queue ON bookings (status, created_at);
-- The Steam games installed on each machine, replaced whole when the host reports them.
CREATE TABLE IF NOT EXISTS machine_games (
  machine_id TEXT NOT NULL REFERENCES machines (id),
  appid      INTEGER NOT NULL,
  PRIMARY KEY (machine_id, appid)
) WITHOUT ROWID;
-- Per machine and UTC day (YYYY-MM-DD): how long it was offered, how much of
-- that a heartbeat or open socket covered, and how often it was dropped as offline.
CREATE TABLE IF NOT EXISTS machine_uptime (
  machine_id TEXT NOT NULL REFERENCES machines (id),
  day        TEXT NOT NULL,
  offered_ms INTEGER NOT NULL DEFAULT 0,
  seen_ms    INTEGER NOT NULL DEFAULT 0,
  drops      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (machine_id, day)
) WITHOUT ROWID;
`;

/**
 * The machine columns the host's report fills, all null until it sends one.
 * Added when missing, so a database file made before them gains them on open.
 * gpu_score is gpu_model's score in @swiff/rank's GPU table (RTX 3060 = 100);
 * encoders, display and controls hold JSON.
 */
const REPORT_COLUMNS: [name: string, type: string][] = [
  ["name", "TEXT"],
  ["gpu_model", "TEXT"],
  ["gpu_score", "INTEGER"],
  ["vram_mb", "INTEGER"],
  ["ram_mb", "INTEGER"],
  ["cpu_model", "TEXT"],
  ["cpu_cores", "INTEGER"],
  ["encoders", "TEXT"],
  ["display", "TEXT"],
  ["controls", "TEXT"],
  ["rtt_ms", "REAL"],
  ["jitter_ms", "REAL"],
  ["up_mbps", "REAL"],
];

/**
 * Session columns added after the table, the same way. end_reason is set when
 * the session ends; qos holds the renter's QosSummary as JSON.
 */
const SESSION_COLUMNS: [name: string, type: string][] = [
  [
    "end_reason",
    "TEXT CHECK (end_reason IN ('renter', 'time_up', 'host_offline', 'owner_kill', 'host_end', 'grace_expired'))",
  ],
  ["qos", "TEXT"],
];

/**
 * The gates a match must pass. E4 needs the renter's controls and E6 a probe
 * from the renter; a booking carries neither yet.
 */
const MATCH_GATES: GateId[] = ["E1", "E2", "E3", "E5"];

const MB_PER_GB = 1024;

/** A JSON column read back, or `fallback` when it is empty. */
function fromJson<T>(value: string | null, fallback: T): T {
  return value === null ? fallback : (JSON.parse(value) as T);
}

/** rank() wants a history with every candidate; the match gates never read it. */
const NO_HISTORY: StabilityStats = {
  heartbeatCoverage: 0,
  dropsPerHour: 0,
  sessionCompletion: 0,
  packetLoss: 0,
  sessions: 0,
  offeredHours: 0,
};

/**
 * Whether the machine passes MATCH_GATES for this booking's game. `installed`
 * need only say whether the booking's game is there. A machine with no
 * reported hardware has no GPU score, so it fails E3.
 */
function passesMatchGates(
  machine: MachineRow,
  installed: number[],
  booking: BookingRow,
  game: GameRequirements,
  now: number,
): boolean {
  const display = fromJson<Display | null>(machine.display, null);
  const host: HostProfile = {
    id: machine.id,
    // Unknown on either side, it cannot be the renter's own machine.
    ownerId: machine.owner_id ?? `machine:${machine.id}`,
    status: "available",
    lastHeartbeatAt: machine.last_seen_at,
    installed,
    gpu: machine.gpu_model ?? "",
    ramGb: (machine.ram_mb ?? 0) / MB_PER_GB,
    vramGb: (machine.vram_mb ?? 0) / MB_PER_GB,
    controls: fromJson<Control[]>(machine.controls, []),
    encoders: fromJson<Encoder[]>(machine.encoders, []),
    uploadMbps: machine.up_mbps ?? 0,
    fps120: (display?.refreshHz ?? 0) >= 120,
    priceCentsPerHour: machine.price,
    availableUntil: machine.available_until ?? Number.MAX_SAFE_INTEGER,
  };
  const renter: RenterPrefs = {
    id: booking.renter_id ?? `booking:${booking.id}`,
    controls: [],
    picture: "best",
    sessionMinutes: booking.minutes,
  };
  const failed = failedGates({ host, link: null, history: NO_HISTORY }, game, renter, {
    now,
    heartbeatMaxAgeMs: LIVENESS_MS,
  });
  return !failed.some((gate) => MATCH_GATES.includes(gate));
}

/** Unguessable, so one id cannot be guessed from another. */
const newId = () => randomBytes(16).toString("base64url");

/** The longest delay setTimeout takes; a later deadline is woken for early and re-armed. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** How soon a wake that failed (a locked database) is tried again. */
const RETRY_MS = 1_000;

export class Platform {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  /** What each game needs, on the same database: gate E3 compares a machine with it. */
  readonly #requirements: RequirementsTable;
  readonly #onSessionEnded: (machineId: string, sessionId: string) => void;
  readonly #onSessionClaimed: (machineId: string, claim: ClaimedSession) => void;
  readonly #onBookingChanged: (bookingId: string) => void;
  readonly #owners: ReadonlyMap<string, string>;
  /** Notices from the open transaction, delivered once it commits. */
  #notices: (() => void)[] = [];
  /** Bookings whose status the open transaction changed, told once it commits. */
  #changed = new Set<string>();
  /** Machines whose PC holds a socket open to the server. */
  readonly #present = new Set<string>();
  /** The one timer, armed for the next deadline. */
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  /** No machine is dropped for silence before this: after a restart nobody is connected yet. */
  readonly #graceUntil: number;

  /**
   * `onSessionEnded` hears of every session that ends, however it ends, with its
   * machine and id; `onSessionClaimed` of every claim, with the machine claimed;
   * `onBookingChanged` of every booking whose status moved, once per change.
   * All run after the change is committed, so what they do (evicting a
   * streamer, telling the PC or the renter) never outlives a rolled-back
   * change, and their failure undoes nothing.
   *
   * Opening grants every machine on offer and every queued booking a fresh
   * deadline: nobody is connected yet after a restart, and each gets
   * LIVENESS_MS or QUEUE_TIMEOUT_MS to reconnect before it is dropped. A
   * machine keeps its real last contact meanwhile, so one that never comes
   * back is seen, and lets go of what it held, as of then.
   * `owners` maps a machine id to its owner's Steam id; a machine missing from
   * it has no recorded owner.
   */
  constructor({
    path = ":memory:",
    now = Date.now,
    owners = new Map(),
    onSessionEnded = () => {},
    onSessionClaimed = () => {},
    onBookingChanged = () => {},
  }: {
    path?: string;
    now?: () => number;
    owners?: ReadonlyMap<string, string>;
    onSessionEnded?: (machineId: string, sessionId: string) => void;
    onSessionClaimed?: (machineId: string, claim: ClaimedSession) => void;
    onBookingChanged?: (bookingId: string) => void;
  } = {}) {
    this.#db = new DatabaseSync(path);
    this.#now = now;
    this.#owners = owners;
    this.#onSessionEnded = onSessionEnded;
    this.#onSessionClaimed = onSessionClaimed;
    this.#onBookingChanged = onBookingChanged;
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(SCHEMA);
    this.#addMissingColumns("machines", [...REPORT_COLUMNS, ["uptime_at", "INTEGER"]]);
    this.#addMissingColumns("sessions", SESSION_COLUMNS);
    this.#requirements = new RequirementsTable(this.#db, now);
    const start = this.#now();
    this.#graceUntil = start + LIVENESS_MS;
    this.#transaction(() => {
      this.#db
        .prepare("UPDATE bookings SET last_seen_at = max(last_seen_at, ?) WHERE status = 'queued'")
        .run(start);
    });
  }

  /** Stop the deadline timer and close the database. */
  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#db.close();
  }

  /** Add each column the table lacks, so a database file made before it gains it on open. */
  #addMissingColumns(table: string, columns: [name: string, type: string][]): void {
    const present = new Set(
      (this.#db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, type] of columns) {
      if (!present.has(name)) this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }

  // --- host ------------------------------------------------------------------

  /**
   * Offer the machine (available) or take it back (not), storing whatever the
   * host reported with it. Taking it back ends whatever it was doing.
   */
  setAvailability(machineId: string, available: boolean, spec: MachineSpec = {}): MachineView {
    return this.#transaction(() => {
      const now = this.#now();
      const machine = this.#touch(machineId, now);
      this.#saveReport(machineId, spec);
      this.#db
        .prepare("UPDATE machines SET price = coalesce(?, price), available_until = ? WHERE id = ?")
        .run(spec.price ?? null, spec.availableUntil ?? null, machineId);

      if (!available) {
        this.#release(machine, now, "owner_kill");
        this.#setStatus(machineId, "idle");
      } else if (machine.status === "idle" || machine.status === "offline") {
        this.#setStatus(machineId, "available");
      }
      this.#tick(now);
      return this.#machineView(machineId);
    });
  }

  /**
   * The machine is alive, and any part of its report that changed. A machine
   * dropped for silence comes back as it was offered.
   */
  heartbeat(machineId: string, report: HostReport = {}): MachineView {
    return this.#transaction(() => {
      const now = this.#now();
      const machine = this.#touch(machineId, now);
      this.#saveReport(machineId, report);
      if (machine.status === "offline") this.#setStatus(machineId, "available");
      // Back online, or a new game or more hardware, can match a waiting booking.
      if (machine.status === "offline" || Object.keys(report).length) this.#tick(now);
      return this.#machineView(machineId);
    });
  }

  /**
   * The PC opened its socket to the server: the machine is there for as long as
   * it stays open, with no heartbeat needed. A machine dropped as offline comes
   * back as it was offered. Nothing is stored for a machine never heard from.
   * The time before the socket opened is counted first, as seen only up to its
   * last contact.
   */
  hostConnected(machineId: string): void {
    this.#transaction(() => {
      const now = this.#now();
      const machine = this.#machineRow(machineId);
      if (machine) this.#touch(machineId, now);
      this.#present.add(machineId);
      if (!machine) return;
      if (machine.status === "offline") this.#setStatus(machineId, "available");
      this.#tick(now);
    });
  }

  /**
   * The PC's socket is gone. `dropped`: it closed or stopped answering, so a
   * machine on offer (available or reserved) is offline at once, as if it had
   * gone silent. A claimed machine is not: from the claim the room is being
   * handed to the streamer, and a renter's session must not end with one
   * socket. Neither is one the server handed over (to the streamer, or back
   * from it). Those have LIVENESS_MS from now to reconnect or beat.
   */
  hostDisconnected(machineId: string, dropped: boolean): void {
    try {
      this.#transaction(() => {
        const now = this.#now();
        // Touched while still present: its offered time up to now counts as seen.
        const machine = this.#machineRow(machineId) && this.#touch(machineId, now);
        this.#present.delete(machineId);
        if (!machine) return;
        if (dropped && (machine.status === "available" || machine.status === "reserved")) {
          this.#goOffline(machine, now);
        }
        this.#tick(now);
      });
    } finally {
      // Gone whatever the database says: a socket that closed is not presence.
      // If the work above failed, the retried tick finds the machine silent.
      this.#present.delete(machineId);
    }
  }

  /**
   * The PCs whose sockets answered a ping lately are still there: store that
   * contact, with their offered time up to now counted as seen. Called once per
   * ping round rather than per ping, so a crash or restart leaves each present
   * machine's last contact at most one round stale. A machine whose socket has
   * since gone, or that was never heard from, is left alone.
   */
  hostsAlive(machineIds: Iterable<string>): void {
    this.#transaction(() => {
      const now = this.#now();
      for (const machineId of machineIds) {
        if (this.#present.has(machineId) && this.#machineRow(machineId)) this.#touch(machineId, now);
      }
    });
  }

  /** The machine's stored report, or null when it has never been heard from. */
  machineProfile(machineId: string): MachineProfile | null {
    const m = this.#db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as
      MachineRow | undefined;
    if (!m) return null;
    const games = this.#db
      .prepare("SELECT appid FROM machine_games WHERE machine_id = ? ORDER BY appid")
      .all(machineId) as { appid: number }[];
    return {
      id: m.id,
      name: m.name,
      hardware:
        m.gpu_model === null
          ? null
          : {
              gpu: m.gpu_model,
              gpuScore: m.gpu_score ?? 0,
              vramMb: m.vram_mb ?? 0,
              ramMb: m.ram_mb ?? 0,
              cpu: m.cpu_model ?? "",
              cores: m.cpu_cores ?? 0,
              encoders: fromJson<Encoder[]>(m.encoders, []),
              display: fromJson<Display>(m.display, { width: 0, height: 0, refreshHz: 0 }),
            },
      games: games.map((g) => g.appid),
      controls: fromJson<Control[]>(m.controls, []),
      net: m.rtt_ms === null ? null : { rttMs: m.rtt_ms, jitterMs: m.jitter_ms ?? 0, upMbps: m.up_mbps ?? 0 },
    };
  }

  /** The machine a session runs on, so the caller can check that machine's key. */
  sessionMachine(sessionId: string): string | null {
    const row = this.#db.prepare("SELECT machine_id FROM sessions WHERE id = ?").get(sessionId) as
      { machine_id: string } | undefined;
    return row?.machine_id ?? null;
  }

  /** The session running on the machine, if any: the only one its host session may start for. */
  claimedSession(machineId: string): ClaimedSession | null {
    const row = this.#db
      .prepare(
        `SELECT s.id, b.game_id, b.minutes FROM sessions s JOIN bookings b ON b.id = s.booking_id
         WHERE s.machine_id = ? AND s.ended_at IS NULL`,
      )
      .get(machineId) as { id: string; game_id: number; minutes: number } | undefined;
    return row ? { sessionId: row.id, gameId: row.game_id, minutes: row.minutes } : null;
  }

  /** The host sessions of sessions.ts, kept in key_sessions. */
  readonly keySessions: KeySessionStore = {
    get: (machineId) => {
      const row = this.#db
        .prepare("SELECT session_id, grant_id FROM key_sessions WHERE machine_id = ?")
        .get(machineId) as { session_id: string; grant_id: string } | undefined;
      return row ? { sessionId: row.session_id, grantId: row.grant_id } : null;
    },
    add: (machineId, { sessionId, grantId }: KeySession) =>
      this.#db
        .prepare(
          "INSERT INTO key_sessions (machine_id, session_id, grant_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .run(machineId, sessionId, grantId).changes > 0,
    remove: (machineId) => {
      const row = this.#db
        .prepare("DELETE FROM key_sessions WHERE machine_id = ? RETURNING session_id")
        .get(machineId) as { session_id: string } | undefined;
      return row?.session_id ?? null;
    },
  };

  /** The renter arrived. False when the session is not this machine's or is already over. */
  startSession(machineId: string, sessionId: string): boolean {
    return this.#transaction(() => {
      const now = this.#now();
      this.#touch(machineId, now);
      const session = this.#openSession(machineId, sessionId);
      if (!session) return false;
      if (session.started_at === null) {
        this.#db.prepare("UPDATE sessions SET started_at = ? WHERE id = ?").run(now, sessionId);
        this.#setBookingStatus(session.booking_id, "playing");
      }
      return true;
    });
  }

  /**
   * The host ended the session. `endedAt` is the host's own clock, kept only
   * between the start and now. The host says nothing about why: once the server
   * sees the session within TIME_UP_GRACE_MS of its expiry it is time_up, and
   * any earlier end is host_end, which neither credits nor blames the machine,
   * since only the renter's own ticket can record that they left.
   */
  endSession(machineId: string, sessionId: string, endedAt?: number): boolean {
    return this.#transaction(() => {
      const now = this.#now();
      const machine = this.#touch(machineId, now);
      const session = this.#openSession(machineId, sessionId);
      if (!session) return false;
      const floor = session.started_at ?? now;
      const at = Math.min(now, Math.max(floor, endedAt ?? now));
      this.#endSession(session, at, now >= session.expires_at - TIME_UP_GRACE_MS ? "time_up" : "host_end");
      if (machine.status === "in_session") this.#setStatus(machineId, "available");
      this.#tick(now);
      return true;
    });
  }

  // --- renter ----------------------------------------------------------------

  /** Queue a booking for `renterId` (a Steam id; null only in tests) and match at once. */
  book(gameId: number, minutes: number, renterId: string | null = null): BookingView {
    return this.#transaction(() => {
      const now = this.#now();
      const id = newId();
      this.#db
        .prepare(
          `INSERT INTO bookings (id, renter_id, game_id, minutes, status, created_at, last_seen_at)
             VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(id, renterId, gameId, minutes, now, now);
      this.#tick(now);
      return this.#bookingView(id)!;
    });
  }

  /**
   * The booking as it stands, or null when there is none or it is not
   * `renterId`'s. It counts as the renter's contact: a check on it, an event
   * stream opening on it, or the page's heartbeat. That contact is what keeps
   * a queued booking in the queue.
   */
  booking(bookingId: string, renterId: string | null = null): BookingView | null {
    return this.#transaction(() => {
      const now = this.#now();
      this.#tick(now);
      if (!this.#bookingRow(bookingId, renterId)) return null;
      this.#db.prepare("UPDATE bookings SET last_seen_at = ? WHERE id = ?").run(now, bookingId);
      return this.#bookingView(bookingId);
    });
  }

  /**
   * The booking as it stands, without counting as the renter's contact or
   * running the matcher: what an event stream sends after a change.
   */
  viewBooking(bookingId: string): BookingView | null {
    return this.#bookingView(bookingId);
  }

  /**
   * Take the matched machine. Only `renterId`'s own matched booking whose
   * reservation is still live can be claimed; anyone else's reads as not found.
   */
  claim(bookingId: string, renterId: string | null = null): ClaimResult {
    return this.#transaction(() => {
      const now = this.#now();
      this.#tick(now); // a reservation that lapsed a moment ago is not claimable
      const booking = this.#bookingRow(bookingId, renterId);
      if (!booking) return { ok: false, reason: "not-found" };
      const reservation = this.#db
        .prepare("SELECT * FROM reservations WHERE booking_id = ?")
        .get(bookingId) as ReservationRow | undefined;
      if (booking.status !== "matched" || !reservation) {
        return { ok: false, reason: "not-claimable", status: booking.status };
      }
      // Never the renter's own machine, even when the reservation predates its
      // owner being known (configured since, the machine not yet checked in).
      const { owner_id } = this.#db
        .prepare("SELECT owner_id FROM machines WHERE id = ?")
        .get(reservation.machine_id) as { owner_id: string | null };
      const owner = this.#owners.get(reservation.machine_id) ?? owner_id;
      if (owner !== null && owner === booking.renter_id) {
        this.#releaseOwnersReservation(reservation.machine_id, owner);
        return { ok: false, reason: "not-claimable", status: "queued" };
      }

      const sessionId = newId();
      this.#db.prepare("DELETE FROM reservations WHERE id = ?").run(reservation.id);
      this.#db
        .prepare("INSERT INTO sessions (id, booking_id, machine_id, expires_at) VALUES (?, ?, ?, ?)")
        .run(sessionId, bookingId, reservation.machine_id, now + booking.minutes * 60_000);
      this.#setBookingStatus(bookingId, "claimed");
      this.#setStatus(reservation.machine_id, "in_session");
      const claimed = { sessionId, gameId: booking.game_id, minutes: booking.minutes };
      this.#notices.push(() => this.#onSessionClaimed(reservation.machine_id, claimed));
      return { ok: true, roomId: reservation.machine_id, ...claimed };
    });
  }

  /** Tie the join ticket handed out at claim to its session, so ending the session revokes it. */
  recordTicket(sessionId: string, ticketId: string): void {
    this.#db.prepare("UPDATE sessions SET ticket_id = ? WHERE id = ?").run(ticketId, sessionId);
  }

  /**
   * The renter left, ending the session as renter. Only the join ticket handed
   * out for this session may do it, and only while the session runs.
   */
  leaveSession(sessionId: string, ticketId: string): QosResult {
    return this.#transaction(() => {
      const now = this.#now();
      const session = this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
        SessionRow | undefined;
      if (!session) return "not-found";
      if (session.ticket_id === null || session.ticket_id !== ticketId) return "wrong-ticket";
      if (session.ended_at !== null) return "over";
      this.#endSession(session, Math.max(now, session.started_at ?? now), "renter");
      const machine = this.#db
        .prepare("SELECT status FROM machines WHERE id = ?")
        .get(session.machine_id) as {
        status: MachineStatus;
      };
      if (machine.status === "in_session") this.#setStatus(session.machine_id, "available");
      this.#tick(now);
      return "ok";
    });
  }

  /**
   * Fold a renter's stream-quality report into the session's summary. Only the
   * join ticket handed out for this session may report, while it runs and for
   * QOS_GRACE_MS after it ends.
   */
  recordQos(sessionId: string, ticketId: string, report: QosReport): QosResult {
    return this.#transaction(() => {
      const session = this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
        SessionRow | undefined;
      if (!session) return "not-found";
      if (session.ticket_id === null || session.ticket_id !== ticketId) return "wrong-ticket";
      if (session.ended_at !== null && this.#now() - session.ended_at > QOS_GRACE_MS) return "over";
      const summary = addQos(fromJson<QosSummary | null>(session.qos, null), report);
      this.#db.prepare("UPDATE sessions SET qos = ? WHERE id = ?").run(JSON.stringify(summary), sessionId);
      return "ok";
    });
  }

  /** The renter's QoS summary for a session, or null when none has been reported. */
  sessionQos(sessionId: string): QosSummary | null {
    const row = this.#db.prepare("SELECT qos FROM sessions WHERE id = ?").get(sessionId) as
      { qos: string | null } | undefined;
    return fromJson<QosSummary | null>(row?.qos ?? null, null);
  }

  /** Why a session ended, or null while it runs (or for one ended before reasons were kept). */
  sessionEndReason(sessionId: string): EndReason | null {
    const row = this.#db.prepare("SELECT end_reason FROM sessions WHERE id = ?").get(sessionId) as
      { end_reason: EndReason | null } | undefined;
    return row?.end_reason ?? null;
  }

  // --- stability ---------------------------------------------------------------

  /**
   * The machine's last seven days as rank()'s StabilityStats, and the bucket
   * they fall in. Offered time since the last check-in counts too, so a machine
   * that went offline and stayed away loses coverage without checking in again.
   * Uptime is kept per whole UTC day, so its window can reach up to a day
   * further back than the exact cutoff used for sessions.
   */
  stability(machineId: string): ReturnType<typeof stabilityFrom> {
    const now = this.#now();
    const since = now - STABILITY_WINDOW_MS;
    const totals = this.#db
      .prepare(
        `SELECT coalesce(sum(offered_ms), 0) AS offeredMs, coalesce(sum(seen_ms), 0) AS seenMs,
                coalesce(sum(drops), 0) AS drops
           FROM machine_uptime WHERE machine_id = ? AND day >= ?`,
      )
      .get(machineId, utcDay(since)) as UptimeTotals;
    const machine = this.#db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as
      MachineRow | undefined;
    if (machine) {
      for (const piece of this.#pendingUptime(machine, now, since)) {
        totals.offeredMs += piece.offeredMs;
        totals.seenMs += piece.seenMs;
      }
    }
    const rows = this.#db
      .prepare(
        `SELECT end_reason, qos FROM sessions
           WHERE machine_id = ? AND ended_at > ? AND end_reason IS NOT NULL`,
      )
      .all(machineId, since) as Pick<SessionRow, "end_reason" | "qos">[];
    const sessions: EndedSession[] = rows.map((row) => ({
      endReason: row.end_reason!,
      packetLoss: fromJson<QosSummary | null>(row.qos, null)?.packetLoss ?? null,
    }));
    return stabilityFrom(totals, sessions);
  }

  /** True when the ticket was handed out for a session that has since ended. A ticket minted by hand has none. */
  ticketRevoked(ticketId: string): boolean {
    return Boolean(
      this.#db.prepare("SELECT 1 FROM sessions WHERE ticket_id = ? AND ended_at IS NOT NULL").get(ticketId),
    );
  }

  // --- matching and deadlines ------------------------------------------------

  /** Settle whatever is due now and match. The deadline timer calls it; so may a test. */
  tick(): void {
    this.#transaction(() => this.#tick(this.#now()));
  }

  /**
   * When the next thing falls due with no call to cause it: a machine with no
   * socket going silent, a reservation lapsing, a session running out, a queued
   * booking nobody checks on timing out. Null when nothing is waiting on time.
   */
  nextDeadline(): number | null {
    const row = this.#db
      .prepare(
        `SELECT min(at) AS at FROM (
           SELECT max(last_seen_at + ?, ?) AS at FROM machines
             WHERE status NOT IN ('idle', 'offline') AND id NOT IN (SELECT value FROM json_each(?))
           UNION ALL SELECT expires_at FROM reservations
           UNION ALL SELECT expires_at FROM sessions WHERE ended_at IS NULL
           UNION ALL SELECT last_seen_at + ? FROM bookings WHERE status = 'queued'
         )`,
      )
      .get(LIVENESS_MS, this.#graceUntil, this.#presentJson(), QUEUE_TIMEOUT_MS) as { at: number | null };
    return row.at;
  }

  /** Arm the one timer for the next deadline, replacing the last. */
  #arm(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#closed) return;
    let delay: number;
    try {
      const at = this.nextDeadline();
      if (at === null) return;
      delay = Math.min(MAX_TIMER_MS, Math.max(0, at - this.#now()));
    } catch (error) {
      console.error("[swiff] platform timer failed:", error instanceof Error ? error.name : typeof error);
      delay = RETRY_MS;
    }
    this.#timer = setTimeout(() => this.#wake(), delay);
    this.#timer.unref?.();
  }

  /** The timer fired: settle what fell due. A failure is retried rather than left unarmed. */
  #wake(): void {
    this.#timer = undefined;
    try {
      this.tick();
    } catch (error) {
      // A locked or broken database file must not take the server down with it.
      console.error("[swiff] platform tick failed:", error instanceof Error ? error.name : typeof error);
      this.#retrySoon();
    }
  }

  /**
   * Wake again in RETRY_MS: a transaction failed, so whatever it would have
   * settled is settled by the next tick that succeeds rather than left waiting
   * for the next call.
   */
  #retrySoon(): void {
    if (this.#closed) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#wake(), RETRY_MS);
    this.#timer.unref?.();
  }

  /**
   * Refresh what is present, drop silent machines, settle lapsed reservations
   * and overrun sessions, then match. A silent machine counts a drop unless its
   * offer ended within LIVENESS_MS of its last check-in: a host that beat until
   * the end of its offer and then went quiet stopped as planned.
   */
  #tick(now: number): void {
    // An open socket is contact right now, so the rules below that read
    // last_seen_at treat it as such.
    this.#db
      .prepare("UPDATE machines SET last_seen_at = ? WHERE id IN (SELECT value FROM json_each(?))")
      .run(now, this.#presentJson());

    // Silent machines first, so nothing below hands a booking to one.
    const silent = (
      now < this.#graceUntil
        ? []
        : this.#db
            .prepare("SELECT * FROM machines WHERE status NOT IN ('idle', 'offline') AND last_seen_at <= ?")
            .all(now - LIVENESS_MS)
    ) as MachineRow[];
    for (const machine of silent) this.#goOffline(machine, now);

    // An unclaimed reservation: a renter who checked in since the match saw it
    // and let it go, so the booking expires. One who has not been heard from
    // since was away; the booking goes back to the queue in its old place, and
    // the queue timeout decides whether they are coming back.
    const lapsed = this.#db
      .prepare("SELECT * FROM reservations WHERE expires_at <= ?")
      .all(now) as ReservationRow[];
    for (const reservation of lapsed) {
      const { last_seen_at } = this.#bookingRow(reservation.booking_id)!;
      const matchedAt = reservation.expires_at - RESERVATION_MS;
      this.#db.prepare("DELETE FROM reservations WHERE id = ?").run(reservation.id);
      this.#setBookingStatus(reservation.booking_id, last_seen_at >= matchedAt ? "expired" : "queued");
      this.#setStatus(reservation.machine_id, "available");
    }

    // The host ends a session when the time runs out; this is the backstop for
    // one that never says so (time_up), and for a renter who claimed and never
    // arrived (grace_expired).
    const overrun = this.#db
      .prepare("SELECT * FROM sessions WHERE ended_at IS NULL AND expires_at <= ?")
      .all(now) as SessionRow[];
    for (const session of overrun) {
      this.#endSession(
        session,
        session.expires_at,
        session.started_at === null ? "grace_expired" : "time_up",
      );
      this.#setStatus(session.machine_id, "available");
    }

    // A renter who stopped checking on a queued booking has gone; matching it
    // would only hold a machine for nobody.
    const gone = this.#db
      .prepare("SELECT id FROM bookings WHERE status = 'queued' AND last_seen_at <= ?")
      .all(now - QUEUE_TIMEOUT_MS) as { id: string }[];
    for (const { id } of gone) this.#setBookingStatus(id, "expired");

    this.#match(now);
  }

  /**
   * Take a machine that stopped answering offline: count its offered time,
   * count a liveness drop unless its offer ended within LIVENESS_MS of its last
   * check-in (it stopped as planned), and let go of what it held as of that
   * check-in.
   */
  #goOffline(machine: MachineRow, now: number): void {
    this.#accrue(machine, now);
    if (machine.available_until === null || machine.available_until > machine.last_seen_at + LIVENESS_MS) {
      this.#db
        .prepare(
          `INSERT INTO machine_uptime (machine_id, day, drops) VALUES (?, ?, 1)
             ON CONFLICT (machine_id, day) DO UPDATE SET drops = drops + 1`,
        )
        .run(machine.id, utcDay(now));
    }
    this.#release(machine, machine.last_seen_at, "host_offline");
    this.#setStatus(machine.id, "offline");
  }

  /**
   * Oldest booking first, each to the cheapest live machine free for the whole
   * booking that has the game installed and meets its minimum (MATCH_GATES).
   */
  #match(now: number): void {
    const queued = this.#db
      .prepare("SELECT * FROM bookings WHERE status = 'queued' ORDER BY created_at, rowid")
      .all() as BookingRow[];
    const free = this.#db.prepare(
      `SELECT m.*, EXISTS (SELECT 1 FROM machine_games g WHERE g.machine_id = m.id AND g.appid = ?) AS has_game
         FROM machines m
         WHERE status = 'available' AND last_seen_at > ?
           AND (available_until IS NULL OR available_until >= ?)
         ORDER BY price, id`,
    );
    for (const booking of queued) {
      const game = this.#requirements.lookup(booking.game_id);
      const machines = free.all(
        booking.game_id,
        now - LIVENESS_MS,
        now + booking.minutes * 60_000,
      ) as (MachineRow & { has_game: number })[];
      // The configured owner counts at once, before the machine next checks in
      // and #touch records it, so a restart never matches an owner to their PC.
      const machine = machines.find((m) =>
        passesMatchGates(
          { ...m, owner_id: this.#owners.get(m.id) ?? m.owner_id },
          m.has_game ? [booking.game_id] : [],
          booking,
          game,
          now,
        ),
      );
      if (!machine) continue; // a booking behind this one may still fit
      this.#db
        .prepare("INSERT INTO reservations (id, booking_id, machine_id, expires_at) VALUES (?, ?, ?, ?)")
        .run(newId(), booking.id, machine.id, now + RESERVATION_MS);
      this.#setBookingStatus(booking.id, "matched");
      this.#setStatus(machine.id, "reserved");
    }
  }

  /**
   * Let go of whatever the machine holds: a waiting booking goes back to the
   * front of the queue for another machine, a running session ends at `at`
   * for `reason`.
   */
  #release(machine: MachineRow, at: number, reason: EndReason): void {
    if (machine.status === "reserved") {
      const reservation = this.#db
        .prepare("SELECT * FROM reservations WHERE machine_id = ?")
        .get(machine.id) as ReservationRow | undefined;
      if (reservation) {
        this.#db.prepare("DELETE FROM reservations WHERE id = ?").run(reservation.id);
        this.#setBookingStatus(reservation.booking_id, "queued");
      }
    }
    if (machine.status === "in_session") {
      const session = this.#db
        .prepare("SELECT * FROM sessions WHERE machine_id = ? AND ended_at IS NULL")
        .get(machine.id) as SessionRow | undefined;
      if (session) this.#endSession(session, Math.max(at, session.started_at ?? at), reason);
    }
  }

  /**
   * The one way a session ends: close it, record why, price the time actually
   * played at the machine's hourly rate, and end its host session so its keys
   * die with it.
   */
  #endSession(session: SessionRow, endedAt: number, reason: EndReason): void {
    const { price } = this.#db.prepare("SELECT price FROM machines WHERE id = ?").get(session.machine_id) as {
      price: number;
    };
    const played = session.started_at === null ? 0 : Math.max(0, endedAt - session.started_at);
    this.#db
      .prepare("UPDATE sessions SET ended_at = ?, price = ?, end_reason = ? WHERE id = ?")
      .run(endedAt, Math.round((price * played) / 3_600_000), reason, session.id);
    this.#db.prepare("DELETE FROM key_sessions WHERE session_id = ?").run(session.id);
    this.#setBookingStatus(session.booking_id, "ended");
    this.#notices.push(() => this.#onSessionEnded(session.machine_id, session.id));
  }

  // --- rows ------------------------------------------------------------------

  /** Store each section the report carries; a section it leaves out keeps what was stored. */
  #saveReport(machineId: string, report: HostReport): void {
    if (report.name !== undefined) {
      this.#db.prepare("UPDATE machines SET name = ? WHERE id = ?").run(report.name, machineId);
    }
    const hw = report.hardware;
    if (hw) {
      this.#db
        .prepare(
          `UPDATE machines SET gpu_model = ?, gpu_score = ?, vram_mb = ?, ram_mb = ?, cpu_model = ?,
             cpu_cores = ?, encoders = ?, display = ? WHERE id = ?`,
        )
        .run(
          hw.gpu,
          gpuScore(hw.gpu),
          hw.vramMb,
          hw.ramMb,
          hw.cpu,
          hw.cores,
          JSON.stringify(hw.encoders),
          JSON.stringify(hw.display),
          machineId,
        );
    }
    if (report.controls) {
      this.#db
        .prepare("UPDATE machines SET controls = ? WHERE id = ?")
        .run(JSON.stringify(report.controls), machineId);
    }
    if (report.net) {
      this.#db
        .prepare("UPDATE machines SET rtt_ms = ?, jitter_ms = ?, up_mbps = ? WHERE id = ?")
        .run(report.net.rttMs, report.net.jitterMs, report.net.upMbps, machineId);
    }
    if (report.games) {
      this.#db.prepare("DELETE FROM machine_games WHERE machine_id = ?").run(machineId);
      const insert = this.#db.prepare(
        "INSERT OR IGNORE INTO machine_games (machine_id, appid) VALUES (?, ?)",
      );
      for (const appid of report.games) insert.run(machineId, appid);
    }
  }

  /**
   * Record a check-in, creating the machine the first time it is heard from,
   * and its owner as configured now, so a changed owner applies at once: a
   * reservation the new owner already holds on it goes back to the queue.
   * Time offered since the last one is counted first (see #accrue).
   */
  #touch(machineId: string, now: number): MachineRow {
    const before = this.#db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as
      MachineRow | undefined;
    if (before) this.#accrue(before, now);
    const owner = this.#owners.get(machineId) ?? null;
    this.#db
      .prepare(
        `INSERT INTO machines (id, owner_id, status, last_seen_at, uptime_at) VALUES (?, ?, 'idle', ?, ?)
           ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, last_seen_at = excluded.last_seen_at,
             uptime_at = excluded.uptime_at`,
      )
      .run(machineId, owner, now, now);
    if (owner !== null && owner !== before?.owner_id) this.#releaseOwnersReservation(machineId, owner);
    return this.#db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as MachineRow;
  }

  /**
   * Hand back a reservation on the machine held by a booking of its own owner,
   * made before the owner was known: the booking returns to the queue, where
   * matching keeps it off this machine, and the machine is free again.
   * True when there was one.
   */
  #releaseOwnersReservation(machineId: string, owner: string): boolean {
    const reservation = this.#db
      .prepare(
        `SELECT r.* FROM reservations r JOIN bookings b ON b.id = r.booking_id
           WHERE r.machine_id = ? AND b.renter_id = ?`,
      )
      .get(machineId, owner) as ReservationRow | undefined;
    if (!reservation) return false;
    this.#db.prepare("DELETE FROM reservations WHERE id = ?").run(reservation.id);
    this.#setBookingStatus(reservation.booking_id, "queued");
    this.#setStatus(machineId, "available");
    return true;
  }

  /**
   * Add the machine's offered time from uptime_at to `now` to machine_uptime,
   * split by UTC day, and move uptime_at to `now`. Offered time ends early at
   * available_until; the stretch within LIVENESS_MS of the last check-in counts
   * as seen. Rows for days before the one the stability window starts in are
   * dropped.
   */
  #accrue(machine: MachineRow, now: number): void {
    const add = this.#db.prepare(
      `INSERT INTO machine_uptime (machine_id, day, offered_ms, seen_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT (machine_id, day) DO UPDATE
           SET offered_ms = offered_ms + excluded.offered_ms, seen_ms = seen_ms + excluded.seen_ms`,
    );
    for (const piece of this.#pendingUptime(machine, now)) {
      add.run(machine.id, piece.day, piece.offeredMs, piece.seenMs);
    }
    this.#db.prepare("UPDATE machines SET uptime_at = ? WHERE id = ?").run(now, machine.id);
    this.#db
      .prepare("DELETE FROM machine_uptime WHERE machine_id = ? AND day < ?")
      .run(machine.id, utcDay(now - STABILITY_WINDOW_MS));
  }

  /**
   * Offered time not yet in machine_uptime, from uptime_at (or `since`, if
   * later) to `now`, by day. A machine whose socket is open is seen right up
   * to now, whenever it last beat.
   */
  #pendingUptime(machine: MachineRow, now: number, since = -Infinity) {
    if (!OFFERED.includes(machine.status)) return [];
    const start = Math.max(machine.uptime_at ?? machine.last_seen_at, since);
    const end = Math.min(now, machine.available_until ?? now);
    const lastSeen = this.#present.has(machine.id) ? now : machine.last_seen_at;
    return splitByDay(start, end, lastSeen + LIVENESS_MS);
  }

  /** The session, if it runs on this machine and has not ended. */
  #openSession(machineId: string, sessionId: string): SessionRow | null {
    const row = this.#db
      .prepare("SELECT * FROM sessions WHERE id = ? AND machine_id = ? AND ended_at IS NULL")
      .get(sessionId, machineId) as SessionRow | undefined;
    return row ?? null;
  }

  /** The machine row, or null when it has never been heard from. */
  #machineRow(machineId: string): MachineRow | null {
    const row = this.#db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as
      MachineRow | undefined;
    return row ?? null;
  }

  /** The machines holding a socket open, as a JSON array for json_each(). */
  #presentJson(): string {
    return JSON.stringify([...this.#present]);
  }

  /** The booking row, or null when there is none or, given a renter, it is not theirs. */
  #bookingRow(bookingId: string, renterId?: string | null): BookingRow | null {
    const row = this.#db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId) as
      BookingRow | undefined;
    if (!row || (renterId !== undefined && row.renter_id !== renterId)) return null;
    return row;
  }

  /** Move a machine to `status`. */
  #setStatus(machineId: string, status: MachineStatus): void {
    this.#db.prepare("UPDATE machines SET status = ? WHERE id = ?").run(status, machineId);
  }

  /** Move a booking to `status`; whoever watches it is told once the change commits. */
  #setBookingStatus(bookingId: string, status: BookingStatus): void {
    this.#db.prepare("UPDATE bookings SET status = ? WHERE id = ?").run(status, bookingId);
    this.#changed.add(bookingId);
  }

  /** What the host is told about its machine, with the session running on it. */
  #machineView(machineId: string): MachineView {
    const m = this.#db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as MachineRow;
    const session = this.#db
      .prepare("SELECT id FROM sessions WHERE machine_id = ? AND ended_at IS NULL")
      .get(machineId) as { id: string } | undefined;
    return {
      id: m.id,
      status: m.status,
      gpu: m.gpu_model,
      cpu: m.cpu_model,
      price: m.price,
      ...(session ? { session: { id: session.id } } : {}),
    };
  }

  /** What the renter is told about a booking: its machine, claim deadline, session and price. */
  #bookingView(bookingId: string): BookingView | null {
    const booking = this.#bookingRow(bookingId);
    if (!booking) return null;
    const view: BookingView = {
      bookingId: booking.id,
      status: booking.status,
      gameId: booking.game_id,
      minutes: booking.minutes,
    };
    const reservation = this.#db.prepare("SELECT * FROM reservations WHERE booking_id = ?").get(bookingId) as
      ReservationRow | undefined;
    const session = this.#db.prepare("SELECT * FROM sessions WHERE booking_id = ?").get(bookingId) as
      SessionRow | undefined;
    const machineId = reservation?.machine_id ?? session?.machine_id;
    if (machineId) {
      const m = this.#db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as MachineRow;
      view.machine = { id: m.id, gpu: m.gpu_model, cpu: m.cpu_model, price: m.price };
    }
    if (reservation) view.claimBy = reservation.expires_at;
    if (session) view.sessionId = session.id;
    if (session?.price != null) view.price = session.price;
    return view;
  }

  /**
   * Run `work` as one transaction. Once it commits, re-arm the deadline timer
   * and deliver the notices it queued; a rollback drops them and arms a retry.
   */
  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = work();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#notices = [];
      this.#changed.clear();
      this.#retrySoon();
      this.#db.exec("ROLLBACK");
      throw error;
    }
    this.#arm();
    const notices = this.#notices;
    this.#notices = [];
    for (const bookingId of this.#changed) notices.push(() => this.#onBookingChanged(bookingId));
    this.#changed.clear();
    for (const notice of notices) {
      try {
        notice();
      } catch (error) {
        // The change is committed either way; one failed notice must not stop
        // the rest, or the tick that made it.
        console.error("[swiff] platform notice failed:", error instanceof Error ? error.name : typeof error);
      }
    }
    return result;
  }
}
