// The platform's state: machines, bookings, reservations and sessions, one
// SQLite table each, and the rules that move a booking through them.
//
//   renter  book ─► queued ─► matched ─► claimed ─► playing ─► ended
//                               │  (reservation lapses unclaimed)
//                               └──────────► expired
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
// that can free a machine or add a booking runs it straight away.

import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/** A machine that has not checked in for this long is no longer offered. Hosts beat every 5 s. */
export const LIVENESS_MS = 15_000;
/** How long a matched renter has to claim the machine. */
export const RESERVATION_MS = 60_000;
/** The longest booking accepted. */
export const MAX_MINUTES = 12 * 60;

export type MachineStatus = "idle" | "available" | "reserved" | "in_session" | "offline";
export type BookingStatus = "queued" | "matched" | "claimed" | "playing" | "ended" | "expired";

export type MachineSpec = {
  gpu?: string | undefined;
  cpu?: string | undefined;
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

export type ClaimResult =
  | { ok: true; sessionId: string; roomId: string; minutes: number }
  | { ok: false; reason: "not-found" | "not-claimable"; status?: BookingStatus };

type MachineRow = {
  id: string;
  gpu: string | null;
  cpu: string | null;
  price: number;
  status: MachineStatus;
  available_until: number | null;
  last_seen_at: number;
};
type BookingRow = { id: string; game_id: number; minutes: number; status: BookingStatus };
type ReservationRow = { id: string; booking_id: string; machine_id: string; expires_at: number };
type SessionRow = {
  id: string;
  booking_id: string;
  machine_id: string;
  started_at: number | null;
  ended_at: number | null;
  expires_at: number;
  price: number | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS machines (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT,
  gpu             TEXT,
  cpu             TEXT,
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
  created_at INTEGER NOT NULL
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
-- the join ticket runs out, the backstop if the host never ends it.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings (id),
  machine_id TEXT NOT NULL REFERENCES machines (id),
  started_at INTEGER,
  ended_at   INTEGER,
  expires_at INTEGER NOT NULL,
  price      INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_open_per_machine
  ON sessions (machine_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS bookings_queue ON bookings (status, created_at);
`;

/** Unguessable: a booking id is all a renter needs to claim it. */
const newId = () => randomBytes(16).toString("base64url");

export class Platform {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor({ path = ":memory:", now = Date.now }: { path?: string; now?: () => number } = {}) {
    this.#db = new DatabaseSync(path);
    this.#now = now;
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  // --- host ------------------------------------------------------------------

  /** Offer the machine (available) or take it back (not). Taking it back ends whatever it was doing. */
  setAvailability(machineId: string, available: boolean, spec: MachineSpec = {}): MachineView {
    return this.#transaction(() => {
      const now = this.#now();
      const machine = this.#touch(machineId, now);
      this.#db
        .prepare(
          `UPDATE machines SET gpu = coalesce(?, gpu), cpu = coalesce(?, cpu), price = coalesce(?, price),
             available_until = ? WHERE id = ?`,
        )
        .run(spec.gpu ?? null, spec.cpu ?? null, spec.price ?? null, spec.availableUntil ?? null, machineId);

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

  /** The machine is alive. A machine dropped for silence comes back as it was offered. */
  heartbeat(machineId: string): MachineView {
    return this.#transaction(() => {
      const now = this.#now();
      const machine = this.#touch(machineId, now);
      if (machine.status === "offline") {
        this.#setStatus(machineId, "available");
        this.#tick(now);
      }
      return this.#machineView(machineId);
    });
  }

  /** The machine a session runs on, so the caller can check that machine's key. */
  sessionMachine(sessionId: string): string | null {
    const row = this.#db.prepare("SELECT machine_id FROM sessions WHERE id = ?").get(sessionId) as
      { machine_id: string } | undefined;
    return row?.machine_id ?? null;
  }

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
          `INSERT INTO bookings (id, renter_id, game_id, minutes, status, created_at)
             VALUES (?, ?, ?, ?, 'queued', ?)`,
        )
        .run(id, renterId, gameId, minutes, now);
      this.#tick(now);
      return this.#bookingView(id)!;
    });
  }

  booking(bookingId: string): BookingView | null {
    return this.#transaction(() => {
      this.#tick(this.#now());
      return this.#bookingView(bookingId);
    });
  }

  /** Take the matched machine. Only a matched booking whose reservation is still live can be claimed. */
  claim(bookingId: string): ClaimResult {
    return this.#transaction(() => {
      const now = this.#now();
      this.#tick(now); // a reservation that lapsed a moment ago is expired, not claimable
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
      return { ok: true, sessionId, roomId: reservation.machine_id, minutes: booking.minutes };
    });
  }

  // --- matching and sweeps ---------------------------------------------------

  tick(): void {
    this.#transaction(() => this.#tick(this.#now()));
  }

  #tick(now: number): void {
    // Silent machines first, so nothing below hands a booking to one.
    const silent = this.#db
      .prepare("SELECT * FROM machines WHERE status NOT IN ('idle', 'offline') AND last_seen_at <= ?")
      .all(now - LIVENESS_MS) as MachineRow[];
    for (const machine of silent) {
      this.#release(machine, machine.last_seen_at);
      this.#setStatus(machine.id, "offline");
    }

    const lapsed = this.#db
      .prepare("SELECT * FROM reservations WHERE expires_at <= ?")
      .all(now) as ReservationRow[];
    for (const reservation of lapsed) {
      this.#db.prepare("DELETE FROM reservations WHERE id = ?").run(reservation.id);
      this.#setBookingStatus(reservation.booking_id, "expired");
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

    this.#match(now);
  }

  /** Oldest booking first, each to the cheapest live machine free for the whole booking. */
  #match(now: number): void {
    const queued = this.#db
      .prepare("SELECT * FROM bookings WHERE status = 'queued' ORDER BY created_at, rowid")
      .all() as BookingRow[];
    const pick = this.#db.prepare(
      `SELECT id FROM machines
         WHERE status = 'available' AND last_seen_at > ?
           AND (available_until IS NULL OR available_until >= ?)
         ORDER BY price, id LIMIT 1`,
    );
    for (const booking of queued) {
      const machine = pick.get(now - LIVENESS_MS, now + booking.minutes * 60_000) as
        { id: string } | undefined;
      if (!machine) continue; // a shorter booking behind this one may still fit
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

  /** Close the session and price the time actually played at the machine's hourly rate. */
  #endSession(session: SessionRow, endedAt: number): void {
    const { price } = this.#db.prepare("SELECT price FROM machines WHERE id = ?").get(session.machine_id) as {
      price: number;
    };
    const played = session.started_at === null ? 0 : Math.max(0, endedAt - session.started_at);
    this.#db
      .prepare("UPDATE sessions SET ended_at = ?, price = ? WHERE id = ?")
      .run(endedAt, Math.round((price * played) / 3_600_000), session.id);
    this.#setBookingStatus(session.booking_id, "ended");
  }

  // --- rows ------------------------------------------------------------------

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

  #openSession(machineId: string, sessionId: string): SessionRow | null {
    const row = this.#db
      .prepare("SELECT * FROM sessions WHERE id = ? AND machine_id = ? AND ended_at IS NULL")
      .get(sessionId, machineId) as SessionRow | undefined;
    return row ?? null;
  }

  #bookingRow(bookingId: string): BookingRow | null {
    const row = this.#db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId) as
      BookingRow | undefined;
    return row ?? null;
  }

  #setStatus(machineId: string, status: MachineStatus): void {
    this.#db.prepare("UPDATE machines SET status = ? WHERE id = ?").run(status, machineId);
  }

  #setBookingStatus(bookingId: string, status: BookingStatus): void {
    this.#db.prepare("UPDATE bookings SET status = ? WHERE id = ?").run(status, bookingId);
  }

  #machineView(machineId: string): MachineView {
    const m = this.#db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as MachineRow;
    const session = this.#db
      .prepare("SELECT id FROM sessions WHERE machine_id = ? AND ended_at IS NULL")
      .get(machineId) as { id: string } | undefined;
    return {
      id: m.id,
      status: m.status,
      gpu: m.gpu,
      cpu: m.cpu,
      price: m.price,
      ...(session ? { session: { id: session.id } } : {}),
    };
  }

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
      view.machine = { id: m.id, gpu: m.gpu, cpu: m.cpu, price: m.price };
    }
    if (reservation) view.claimBy = reservation.expires_at;
    if (session) view.sessionId = session.id;
    if (session?.price != null) view.price = session.price;
    return view;
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}
