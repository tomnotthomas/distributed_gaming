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
//                 (silent for LIVENESS_MS: offline; taken back: idle)
//
// SQLite through node:sqlite: built into Node 22, so local dev, the tests and
// CI need no database server, no native build and no new dependency. The file
// is DATABASE_PATH; unset, it lives in memory and resets with the process.
//
// Everything here is synchronous and runs in one process, so each method is
// one transaction and nothing else can interleave with it. That, plus the
// unique indexes below, is what gives a machine to at most one booking.
//
// Matching runs in tick(): the server calls it every second, and every call
// that can free a machine or add a booking runs it straight away. A booking is
// matched only to a machine with its game installed and the hardware the game
// asks for, judged by @swiff/rank's gates against the requirements table.
//
// The host sessions of sessions.ts live here too, in key_sessions, so a server
// restart keeps them and ending a platform session revokes its keys in the
// same transaction.

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

/** A machine that has not checked in for this long is no longer offered. Hosts beat every 5 s. */
export const LIVENESS_MS = 15_000;
/** How long a matched renter has to claim the machine. A renter who checked in since the match and let it lapse loses the booking. */
export const RESERVATION_MS = 60_000;
/** A queued booking the renter has not checked on for this long is dropped. */
export const QUEUE_TIMEOUT_MS = 2 * 60_000;
/** The longest booking accepted. */
export const MAX_MINUTES = 12 * 60;

export type MachineStatus = "idle" | "available" | "reserved" | "in_session" | "offline";
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
CREATE INDEX IF NOT EXISTS bookings_queue ON bookings (status, created_at);
-- The Steam games installed on each machine, replaced whole when the host reports them.
CREATE TABLE IF NOT EXISTS machine_games (
  machine_id TEXT NOT NULL REFERENCES machines (id),
  appid      INTEGER NOT NULL,
  PRIMARY KEY (machine_id, appid)
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

/** Unguessable: a booking id is all a renter needs to claim it. */
const newId = () => randomBytes(16).toString("base64url");

export class Platform {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  /** What each game needs, on the same database: gate E3 compares a machine with it. */
  readonly #requirements: RequirementsTable;
  readonly #onSessionEnded: (machineId: string, sessionId: string) => void;
  readonly #onSessionClaimed: (machineId: string, claim: ClaimedSession) => void;
  /** Notices from the open transaction, delivered once it commits. */
  #notices: (() => void)[] = [];

  /**
   * `onSessionEnded` hears of every session that ends, however it ends, with its
   * machine and id; `onSessionClaimed` of every claim, with the machine claimed.
   * Both run after the change is committed, so what they do (evicting a
   * streamer, telling the PC) never outlives a rolled-back change, and their
   * failure undoes nothing.
   */
  constructor({
    path = ":memory:",
    now = Date.now,
    onSessionEnded = () => {},
    onSessionClaimed = () => {},
  }: {
    path?: string;
    now?: () => number;
    onSessionEnded?: (machineId: string, sessionId: string) => void;
    onSessionClaimed?: (machineId: string, claim: ClaimedSession) => void;
  } = {}) {
    this.#db = new DatabaseSync(path);
    this.#now = now;
    this.#onSessionEnded = onSessionEnded;
    this.#onSessionClaimed = onSessionClaimed;
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(SCHEMA);
    const columns = this.#db.prepare("PRAGMA table_info(machines)").all() as { name: string }[];
    const present = new Set(columns.map((column) => column.name));
    for (const [name, type] of REPORT_COLUMNS) {
      if (!present.has(name)) this.#db.exec(`ALTER TABLE machines ADD COLUMN ${name} ${type}`);
    }
    this.#requirements = new RequirementsTable(this.#db, now);
  }

  /** Close the database. */
  close(): void {
    this.#db.close();
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
        this.#release(machine, now);
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
   * The renter left, the time ran out or the owner pressed the kill switch.
   * `endedAt` is the host's own clock, kept only between the start and now.
   */
  endSession(machineId: string, sessionId: string, endedAt?: number): boolean {
    return this.#transaction(() => {
      const now = this.#now();
      const machine = this.#touch(machineId, now);
      const session = this.#openSession(machineId, sessionId);
      if (!session) return false;
      const floor = session.started_at ?? now;
      this.#endSession(session, Math.min(now, Math.max(floor, endedAt ?? now)));
      if (machine.status === "in_session") this.#setStatus(machineId, "available");
      this.#tick(now);
      return true;
    });
  }

  // --- renter ----------------------------------------------------------------

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

  /** The booking as it stands. Checking on it is what keeps a queued booking in the queue. */
  booking(bookingId: string): BookingView | null {
    return this.#transaction(() => {
      const now = this.#now();
      this.#tick(now);
      this.#db.prepare("UPDATE bookings SET last_seen_at = ? WHERE id = ?").run(now, bookingId);
      return this.#bookingView(bookingId);
    });
  }

  /** Take the matched machine. Only a matched booking whose reservation is still live can be claimed. */
  claim(bookingId: string): ClaimResult {
    return this.#transaction(() => {
      const now = this.#now();
      this.#tick(now); // a reservation that lapsed a moment ago is not claimable
      const booking = this.#bookingRow(bookingId);
      if (!booking) return { ok: false, reason: "not-found" };
      const reservation = this.#db
        .prepare("SELECT * FROM reservations WHERE booking_id = ?")
        .get(bookingId) as ReservationRow | undefined;
      if (booking.status !== "matched" || !reservation) {
        return { ok: false, reason: "not-claimable", status: booking.status };
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

  /** True when the ticket was handed out for a session that has since ended. A ticket minted by hand has none. */
  ticketRevoked(ticketId: string): boolean {
    return Boolean(
      this.#db.prepare("SELECT 1 FROM sessions WHERE ticket_id = ? AND ended_at IS NOT NULL").get(ticketId),
    );
  }

  // --- matching and sweeps ---------------------------------------------------

  tick(): void {
    this.#transaction(() => this.#tick(this.#now()));
  }

  /** Drop silent machines, settle lapsed reservations and overrun sessions, then match. */
  #tick(now: number): void {
    // Silent machines first, so nothing below hands a booking to one.
    const silent = this.#db
      .prepare("SELECT * FROM machines WHERE status NOT IN ('idle', 'offline') AND last_seen_at <= ?")
      .all(now - LIVENESS_MS) as MachineRow[];
    for (const machine of silent) {
      this.#release(machine, machine.last_seen_at);
      this.#setStatus(machine.id, "offline");
    }

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
    // one that never says so, and for a renter who claimed and never arrived.
    const overrun = this.#db
      .prepare("SELECT * FROM sessions WHERE ended_at IS NULL AND expires_at <= ?")
      .all(now) as SessionRow[];
    for (const session of overrun) {
      this.#endSession(session, session.expires_at);
      this.#setStatus(session.machine_id, "available");
    }

    // A renter who stopped checking on a queued booking has gone; matching it
    // would only hold a machine for nobody.
    this.#db
      .prepare("UPDATE bookings SET status = 'expired' WHERE status = 'queued' AND last_seen_at <= ?")
      .run(now - QUEUE_TIMEOUT_MS);

    this.#match(now);
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
      const machine = machines.find((m) =>
        passesMatchGates(m, m.has_game ? [booking.game_id] : [], booking, game, now),
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
   * front of the queue for another machine, a running session ends at `at`.
   */
  #release(machine: MachineRow, at: number): void {
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
      if (session) this.#endSession(session, Math.max(at, session.started_at ?? at));
    }
  }

  /**
   * Close the session, price the time actually played at the machine's hourly
   * rate, and end its host session so its keys die with it.
   */
  #endSession(session: SessionRow, endedAt: number): void {
    const { price } = this.#db.prepare("SELECT price FROM machines WHERE id = ?").get(session.machine_id) as {
      price: number;
    };
    const played = session.started_at === null ? 0 : Math.max(0, endedAt - session.started_at);
    this.#db
      .prepare("UPDATE sessions SET ended_at = ?, price = ? WHERE id = ?")
      .run(endedAt, Math.round((price * played) / 3_600_000), session.id);
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

  /** Record a check-in, creating the machine the first time it is heard from. */
  #touch(machineId: string, now: number): MachineRow {
    this.#db
      .prepare(
        `INSERT INTO machines (id, status, last_seen_at) VALUES (?, 'idle', ?)
           ON CONFLICT (id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .run(machineId, now);
    return this.#db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as MachineRow;
  }

  /** The session, if it runs on this machine and has not ended. */
  #openSession(machineId: string, sessionId: string): SessionRow | null {
    const row = this.#db
      .prepare("SELECT * FROM sessions WHERE id = ? AND machine_id = ? AND ended_at IS NULL")
      .get(sessionId, machineId) as SessionRow | undefined;
    return row ?? null;
  }

  /** The booking row, or null when there is none. */
  #bookingRow(bookingId: string): BookingRow | null {
    const row = this.#db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId) as
      BookingRow | undefined;
    return row ?? null;
  }

  /** Move a machine to `status`. */
  #setStatus(machineId: string, status: MachineStatus): void {
    this.#db.prepare("UPDATE machines SET status = ? WHERE id = ?").run(status, machineId);
  }

  /** Move a booking to `status`. */
  #setBookingStatus(bookingId: string, status: BookingStatus): void {
    this.#db.prepare("UPDATE bookings SET status = ? WHERE id = ?").run(status, bookingId);
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

  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = work();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#notices = [];
      this.#db.exec("ROLLBACK");
      throw error;
    }
    const notices = this.#notices;
    this.#notices = [];
    for (const notice of notices) {
      try {
        notice();
      } catch (error) {
        // The change is committed either way; one failed notice must not stop
        // the rest, or the sweep that made it.
        console.error("[swiff] platform notice failed:", error instanceof Error ? error.name : typeof error);
      }
    }
    return result;
  }
}
