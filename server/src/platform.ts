// The platform's state: machines, bookings, reservations and sessions, one
// Postgres table each, and the rules that move a booking through them.
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
// The database is Postgres at DATABASE_URL; unset, one in memory that resets
// with the process (db.ts). Its tables are made by schema.ts.
//
// Calls take turns: each runs once every call made before it has finished, as
// one transaction, so nothing else in this process interleaves with it. A call
// that may write first locks the machines table, so neither can another server
// on the same database (a deploy overlapping the instance it replaces). That,
// plus the unique indexes, is what gives a machine to at most one booking.
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
import type { Database, Queryable } from "./db.js";
import type { Display, Hardware, HostReport, Net } from "./profile.js";
import { RequirementsTable, type Requirements } from "./requirements.js";
import { migrate } from "./schema.js";
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

/**
 * A machine on offer and answering, as renters' reads of what they could play
 * see it: rank()'s view of it, its stored report and seven-day history, and,
 * when it is busy, when it is free again at the latest.
 */
export type OfferedMachine = {
  host: HostProfile;
  profile: MachineProfile;
  history: StabilityStats;
  /** Unix ms by which a reserved or in-session machine is free again; null when it is free. */
  backAt: number | null;
};

/** The machines on offer as one read saw them, and when (Unix ms). */
export type OfferedSnapshot = { at: number; machines: OfferedMachine[] };

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
 * The machine as rank() reads it. `installed` lists the games to judge it on;
 * `lastSeenAt` is its last contact, now for one whose socket is open. Without
 * reported hardware it has no GPU score, so it fails E3; with no owner known on
 * either side it cannot be anybody's own machine.
 */
function hostProfileOf(
  machine: MachineRow,
  installed: number[],
  status: HostProfile["status"],
  lastSeenAt: number,
): HostProfile {
  const display = fromJson<Display | null>(machine.display, null);
  return {
    id: machine.id,
    ownerId: machine.owner_id ?? `machine:${machine.id}`,
    status,
    lastHeartbeatAt: lastSeenAt,
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
}

/** A machine row and its installed games as the host reported them. */
function profileOf(m: MachineRow, games: number[]): MachineProfile {
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
    games,
    controls: fromJson<Control[]>(m.controls, []),
    net: m.rtt_ms === null ? null : { rttMs: m.rtt_ms, jitterMs: m.jitter_ms ?? 0, upMbps: m.up_mbps ?? 0 },
  };
}

/**
 * Whether the machine passes MATCH_GATES for this booking's game. `installed`
 * need only say whether the booking's game is there.
 */
function passesMatchGates(
  machine: MachineRow,
  installed: number[],
  booking: BookingRow,
  game: GameRequirements,
  now: number,
): boolean {
  const host = hostProfileOf(machine, installed, "available", machine.last_seen_at);
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
/** How soon a wake that failed (the database unreachable) is tried again. */
export const RETRY_MS = 1_000;

/** Opens a call that may write: it takes the machines table first, so one such call runs at a time on the database. */
const WRITE = "BEGIN; LOCK TABLE machines IN EXCLUSIVE MODE";
/** Opens a call that only reads: one consistent view, however many statements it takes. */
const READ = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

export type PlatformOptions = {
  /** Where the state is kept (db.ts). The platform makes its tables there, and closes it when it closes. */
  database: Database;
  now?: () => number;
  owners?: ReadonlyMap<string, string>;
  onSessionEnded?: (machineId: string, sessionId: string) => void;
  onSessionClaimed?: (machineId: string, claim: ClaimedSession) => void;
  onBookingChanged?: (bookingId: string) => void;
};

export class Platform {
  readonly #db: Database;
  readonly #now: () => number;
  /** What each game needs, on the same database: gate E3 compares a machine with it. */
  readonly #requirements: RequirementsTable;
  readonly #onSessionEnded: (machineId: string, sessionId: string) => void;
  readonly #onSessionClaimed: (machineId: string, claim: ClaimedSession) => void;
  readonly #onBookingChanged: (bookingId: string) => void;
  readonly #owners: ReadonlyMap<string, string>;
  /** The transaction of the call running now: every statement goes through it. */
  #tx: Queryable | null = null;
  /** The last call queued: the next one runs once it has finished. */
  #queue: Promise<unknown> = Promise.resolve();
  /** Notices from the open transaction, delivered once it commits. */
  #notices: (() => void)[] = [];
  /** Bookings whose status the open transaction changed, told once it commits. */
  #changed = new Set<string>();
  /** Machines whose PC holds a socket open to the server. */
  readonly #present = new Set<string>();
  /** The one timer, armed for the next deadline. */
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  /** No machine is dropped for silence before this: after a restart nobody is connected yet. */
  #graceUntil = 0;

  private constructor({
    database,
    now = Date.now,
    owners = new Map(),
    onSessionEnded = () => {},
    onSessionClaimed = () => {},
    onBookingChanged = () => {},
  }: PlatformOptions) {
    this.#db = database;
    this.#now = now;
    this.#owners = owners;
    this.#onSessionEnded = onSessionEnded;
    this.#onSessionClaimed = onSessionClaimed;
    this.#onBookingChanged = onBookingChanged;
    this.#requirements = new RequirementsTable(
      { query: (sql, params) => this.#active().query(sql, params) },
      now,
    );
  }

  /**
   * The platform on `database`, its tables made or brought up to date first.
   *
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
  static async open(options: PlatformOptions): Promise<Platform> {
    await migrate(options.database);
    const platform = new Platform(options);
    const start = platform.#now();
    platform.#graceUntil = start + LIVENESS_MS;
    await platform.#transaction(() =>
      platform.#run(
        "UPDATE bookings SET last_seen_at = GREATEST(last_seen_at, $1) WHERE status = 'queued'",
        start,
      ),
    );
    return platform;
  }

  /** Stop the deadline timer, let the calls already made finish, and close the database. Once. */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#closed = true;
      clearTimeout(this.#timer);
      await this.#queue;
      await this.#db.close();
    })();
    return this.#closing;
  }

  // --- host ------------------------------------------------------------------

  /**
   * Offer the machine (available) or take it back (not), storing whatever the
   * host reported with it. Taking it back ends whatever it was doing.
   */
  setAvailability(machineId: string, available: boolean, spec: MachineSpec = {}): Promise<MachineView> {
    return this.#transaction(async () => {
      const now = this.#now();
      const machine = await this.#touch(machineId, now);
      await this.#saveReport(machineId, spec);
      await this.#run(
        "UPDATE machines SET price = coalesce($1, price), available_until = $2 WHERE id = $3",
        spec.price ?? null,
        spec.availableUntil ?? null,
        machineId,
      );

      if (!available) {
        await this.#release(machine, now, "owner_kill");
        await this.#setStatus(machineId, "idle");
      } else if (machine.status === "idle" || machine.status === "offline") {
        await this.#setStatus(machineId, "available");
      }
      await this.#tick(now);
      return this.#machineView(machineId);
    });
  }

  /**
   * The machine is alive, and any part of its report that changed. A machine
   * dropped for silence comes back as it was offered.
   */
  heartbeat(machineId: string, report: HostReport = {}): Promise<MachineView> {
    return this.#transaction(async () => {
      const now = this.#now();
      const machine = await this.#touch(machineId, now);
      await this.#saveReport(machineId, report);
      if (machine.status === "offline") await this.#setStatus(machineId, "available");
      // Back online, or a new game or more hardware, can match a waiting booking.
      if (machine.status === "offline" || Object.keys(report).length) await this.#tick(now);
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
  hostConnected(machineId: string): Promise<void> {
    return this.#transaction(async () => {
      const now = this.#now();
      const machine = await this.#machineRow(machineId);
      if (machine) await this.#touch(machineId, now);
      this.#present.add(machineId);
      if (!machine) return;
      if (machine.status === "offline") await this.#setStatus(machineId, "available");
      await this.#tick(now);
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
  hostDisconnected(machineId: string, dropped: boolean): Promise<void> {
    return this.#transaction(async () => {
      try {
        const now = this.#now();
        // Touched while still present: its offered time up to now counts as seen.
        const machine = (await this.#machineRow(machineId)) && (await this.#touch(machineId, now));
        this.#present.delete(machineId);
        if (!machine) return;
        if (dropped && (machine.status === "available" || machine.status === "reserved")) {
          await this.#goOffline(machine, now);
        }
        await this.#tick(now);
      } finally {
        // Gone whatever the database says: a socket that closed is not presence.
        // If the work above failed, the retried tick finds the machine silent.
        this.#present.delete(machineId);
      }
    });
  }

  /**
   * The PCs whose sockets answered a ping lately are still there: store that
   * contact, with their offered time up to now counted as seen. Called once per
   * ping round rather than per ping, so a crash or restart leaves each present
   * machine's last contact at most one round stale. A machine whose socket has
   * since gone, or that was never heard from, is left alone.
   */
  hostsAlive(machineIds: Iterable<string>): Promise<void> {
    const ids = [...machineIds];
    return this.#transaction(async () => {
      const now = this.#now();
      for (const machineId of ids) {
        if (this.#present.has(machineId) && (await this.#machineRow(machineId))) {
          await this.#touch(machineId, now);
        }
      }
    });
  }

  /** The machine's stored report, or null when it has never been heard from. */
  machineProfile(machineId: string): Promise<MachineProfile | null> {
    return this.#read(async () => {
      const m = await this.#machineRow(machineId);
      if (!m) return null;
      const games = await this.#all<{ appid: number }>(
        "SELECT appid FROM machine_games WHERE machine_id = $1 ORDER BY appid",
        machineId,
      );
      return profileOf(
        m,
        games.map((g) => g.appid),
      );
    });
  }

  /**
   * Every machine on offer that is not offline (available, reserved or in
   * session) and whose offer has not run out, for the renter-facing reads of
   * what can be played where. A machine whose socket is open counts as seen
   * now. A busy machine is free again when its session runs out, or, while
   * reserved, when a claim at the last moment would run out. Read only:
   * nothing is settled or matched. `at` is the time they were read at, for
   * judging them.
   */
  offeredMachines(): Promise<OfferedSnapshot> {
    return this.#read(async () => {
      const now = this.#now();
      const rows = await this.#all<MachineRow>(
        `SELECT * FROM machines WHERE status IN ('available', 'reserved', 'in_session')
           AND (available_until IS NULL OR available_until > $1) ORDER BY id COLLATE "C"`,
        now,
      );
      const installed = new Map<string, number[]>();
      const games = await this.#all<{ machine_id: string; appid: number }>(
        `SELECT g.machine_id, g.appid FROM machine_games g JOIN machines m ON m.id = g.machine_id
           WHERE m.status IN ('available', 'reserved', 'in_session') ORDER BY g.appid`,
      );
      for (const { machine_id, appid } of games) {
        const list = installed.get(machine_id) ?? [];
        list.push(appid);
        installed.set(machine_id, list);
      }
      const machines: OfferedMachine[] = [];
      for (const m of rows) {
        const appids = installed.get(m.id) ?? [];
        const busy = m.status !== "available";
        const lastSeenAt = this.#present.has(m.id) ? now : m.last_seen_at;
        // The configured owner counts before the machine next checks in, as in matching.
        const row = { ...m, owner_id: this.#owners.get(m.id) ?? m.owner_id };
        const back = busy
          ? await this.#get<{ at: number }>(
              `SELECT expires_at AS at FROM sessions WHERE machine_id = $1 AND ended_at IS NULL
               UNION ALL
               SELECT r.expires_at + b.minutes * 60000 FROM reservations r JOIN bookings b ON b.id = r.booking_id
                 WHERE r.machine_id = $1`,
              m.id,
            )
          : undefined;
        machines.push({
          host: hostProfileOf(row, appids, busy ? "busy" : "available", lastSeenAt),
          profile: profileOf(m, appids),
          history: (await this.#stability(m.id)).stats,
          backAt: back?.at ?? null,
        });
      }
      return { at: now, machines };
    });
  }

  /**
   * What each game needs, in the order asked, from the requirements table:
   * curated, seeded from Steam, or the labelled default.
   */
  requirements(appids: number[]): Promise<Requirements[]> {
    return this.#read(() => this.#requirements.lookupAll(appids));
  }

  /** The machine a session runs on, so the caller can check that machine's key. */
  sessionMachine(sessionId: string): Promise<string | null> {
    return this.#read(async () => {
      const row = await this.#get<{ machine_id: string }>(
        "SELECT machine_id FROM sessions WHERE id = $1",
        sessionId,
      );
      return row?.machine_id ?? null;
    });
  }

  /** The session running on the machine, if any: the only one its host session may start for. */
  claimedSession(machineId: string): Promise<ClaimedSession | null> {
    return this.#read(async () => {
      const row = await this.#get<{ id: string; game_id: number; minutes: number }>(
        `SELECT s.id, b.game_id, b.minutes FROM sessions s JOIN bookings b ON b.id = s.booking_id
         WHERE s.machine_id = $1 AND s.ended_at IS NULL`,
        machineId,
      );
      return row ? { sessionId: row.id, gameId: row.game_id, minutes: row.minutes } : null;
    });
  }

  /**
   * The host sessions of sessions.ts, kept in key_sessions. One is added only
   * while its session is still open on that machine: the caller checks that
   * first, and the session may end before the add's turn comes.
   */
  readonly keySessions: KeySessionStore = {
    get: (machineId) =>
      this.#read(async () => {
        const row = await this.#get<{ session_id: string; grant_id: string }>(
          "SELECT session_id, grant_id FROM key_sessions WHERE machine_id = $1",
          machineId,
        );
        return row ? { sessionId: row.session_id, grantId: row.grant_id } : null;
      }),
    add: (machineId, { sessionId, grantId }: KeySession) =>
      this.#transaction(
        async () =>
          (await this.#run(
            `INSERT INTO key_sessions (machine_id, session_id, grant_id)
               SELECT $1, $2, $3 WHERE EXISTS
                 (SELECT 1 FROM sessions WHERE id = $2 AND machine_id = $1 AND ended_at IS NULL)
             ON CONFLICT DO NOTHING`,
            machineId,
            sessionId,
            grantId,
          )) > 0,
      ),
    remove: (machineId) =>
      this.#transaction(async () => {
        const row = await this.#get<{ session_id: string }>(
          "DELETE FROM key_sessions WHERE machine_id = $1 RETURNING session_id",
          machineId,
        );
        return row?.session_id ?? null;
      }),
  };

  /** The renter arrived. False when the session is not this machine's or is already over. */
  startSession(machineId: string, sessionId: string): Promise<boolean> {
    return this.#transaction(async () => {
      const now = this.#now();
      await this.#touch(machineId, now);
      const session = await this.#openSession(machineId, sessionId);
      if (!session) return false;
      if (session.started_at === null) {
        await this.#run("UPDATE sessions SET started_at = $1 WHERE id = $2", now, sessionId);
        await this.#setBookingStatus(session.booking_id, "playing");
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
  endSession(machineId: string, sessionId: string, endedAt?: number): Promise<boolean> {
    return this.#transaction(async () => {
      const now = this.#now();
      const machine = await this.#touch(machineId, now);
      const session = await this.#openSession(machineId, sessionId);
      if (!session) return false;
      const floor = session.started_at ?? now;
      // Whole ms, as every time is kept: the host's clock may say otherwise.
      const at = Math.round(Math.min(now, Math.max(floor, endedAt ?? now)));
      await this.#endSession(
        session,
        at,
        now >= session.expires_at - TIME_UP_GRACE_MS ? "time_up" : "host_end",
      );
      if (machine.status === "in_session") await this.#setStatus(machineId, "available");
      await this.#tick(now);
      return true;
    });
  }

  // --- renter ----------------------------------------------------------------

  /** Queue a booking for `renterId` (a Steam id; null only in tests) and match at once. */
  book(gameId: number, minutes: number, renterId: string | null = null): Promise<BookingView> {
    return this.#transaction(async () => {
      const now = this.#now();
      const id = newId();
      await this.#run(
        `INSERT INTO bookings (id, renter_id, game_id, minutes, status, created_at, last_seen_at)
           VALUES ($1, $2, $3, $4, 'queued', $5, $5)`,
        id,
        renterId,
        gameId,
        minutes,
        now,
      );
      await this.#tick(now);
      return (await this.#bookingView(id))!;
    });
  }

  /**
   * The booking as it stands, or null when there is none or it is not
   * `renterId`'s. It counts as the renter's contact: a check on it, an event
   * stream opening on it, or the page's heartbeat. That contact is what keeps
   * a queued booking in the queue.
   */
  booking(bookingId: string, renterId: string | null = null): Promise<BookingView | null> {
    return this.#transaction(async () => {
      const now = this.#now();
      await this.#tick(now);
      if (!(await this.#bookingRow(bookingId, renterId))) return null;
      await this.#run("UPDATE bookings SET last_seen_at = $1 WHERE id = $2", now, bookingId);
      return this.#bookingView(bookingId);
    });
  }

  /**
   * The booking as it stands, without counting as the renter's contact or
   * running the matcher: what an event stream sends after a change.
   */
  viewBooking(bookingId: string): Promise<BookingView | null> {
    return this.#read(() => this.#bookingView(bookingId));
  }

  /**
   * Take the matched machine. Only `renterId`'s own matched booking whose
   * reservation is still live can be claimed; anyone else's reads as not found.
   */
  claim(bookingId: string, renterId: string | null = null): Promise<ClaimResult> {
    return this.#transaction(async (): Promise<ClaimResult> => {
      const now = this.#now();
      await this.#tick(now); // a reservation that lapsed a moment ago is not claimable
      const booking = await this.#bookingRow(bookingId, renterId);
      if (!booking) return { ok: false, reason: "not-found" };
      const reservation = await this.#get<ReservationRow>(
        "SELECT * FROM reservations WHERE booking_id = $1",
        bookingId,
      );
      if (booking.status !== "matched" || !reservation) {
        return { ok: false, reason: "not-claimable", status: booking.status };
      }
      // Never the renter's own machine, even when the reservation predates its
      // owner being known (configured since, the machine not yet checked in).
      const { owner_id } = (await this.#get<{ owner_id: string | null }>(
        "SELECT owner_id FROM machines WHERE id = $1",
        reservation.machine_id,
      ))!;
      const owner = this.#owners.get(reservation.machine_id) ?? owner_id;
      if (owner !== null && owner === booking.renter_id) {
        await this.#releaseOwnersReservation(reservation.machine_id, owner);
        return { ok: false, reason: "not-claimable", status: "queued" };
      }

      const sessionId = newId();
      await this.#run("DELETE FROM reservations WHERE id = $1", reservation.id);
      await this.#run(
        "INSERT INTO sessions (id, booking_id, machine_id, expires_at) VALUES ($1, $2, $3, $4)",
        sessionId,
        bookingId,
        reservation.machine_id,
        now + booking.minutes * 60_000,
      );
      await this.#setBookingStatus(bookingId, "claimed");
      await this.#setStatus(reservation.machine_id, "in_session");
      const claimed = { sessionId, gameId: booking.game_id, minutes: booking.minutes };
      this.#notices.push(() => this.#onSessionClaimed(reservation.machine_id, claimed));
      return { ok: true, roomId: reservation.machine_id, ...claimed };
    });
  }

  /** Tie the join ticket handed out at claim to its session, so ending the session revokes it. */
  recordTicket(sessionId: string, ticketId: string): Promise<void> {
    return this.#transaction(async () => {
      await this.#run("UPDATE sessions SET ticket_id = $1 WHERE id = $2", ticketId, sessionId);
    });
  }

  /**
   * The renter left, ending the session as renter. Only the join ticket handed
   * out for this session may do it, and only while the session runs.
   */
  leaveSession(sessionId: string, ticketId: string): Promise<QosResult> {
    return this.#transaction(async (): Promise<QosResult> => {
      const now = this.#now();
      const session = await this.#get<SessionRow>("SELECT * FROM sessions WHERE id = $1", sessionId);
      if (!session) return "not-found";
      if (session.ticket_id === null || session.ticket_id !== ticketId) return "wrong-ticket";
      if (session.ended_at !== null) return "over";
      await this.#endSession(session, Math.max(now, session.started_at ?? now), "renter");
      const machine = (await this.#get<{ status: MachineStatus }>(
        "SELECT status FROM machines WHERE id = $1",
        session.machine_id,
      ))!;
      if (machine.status === "in_session") await this.#setStatus(session.machine_id, "available");
      await this.#tick(now);
      return "ok";
    });
  }

  /**
   * Fold a renter's stream-quality report into the session's summary. Only the
   * join ticket handed out for this session may report, while it runs and for
   * QOS_GRACE_MS after it ends.
   */
  recordQos(sessionId: string, ticketId: string, report: QosReport): Promise<QosResult> {
    return this.#transaction(async (): Promise<QosResult> => {
      const session = await this.#get<SessionRow>("SELECT * FROM sessions WHERE id = $1", sessionId);
      if (!session) return "not-found";
      if (session.ticket_id === null || session.ticket_id !== ticketId) return "wrong-ticket";
      if (session.ended_at !== null && this.#now() - session.ended_at > QOS_GRACE_MS) return "over";
      const summary = addQos(fromJson<QosSummary | null>(session.qos, null), report);
      await this.#run("UPDATE sessions SET qos = $1 WHERE id = $2", JSON.stringify(summary), sessionId);
      return "ok";
    });
  }

  /** The renter's QoS summary for a session, or null when none has been reported. */
  sessionQos(sessionId: string): Promise<QosSummary | null> {
    return this.#read(async () => {
      const row = await this.#get<{ qos: string | null }>(
        "SELECT qos FROM sessions WHERE id = $1",
        sessionId,
      );
      return fromJson<QosSummary | null>(row?.qos ?? null, null);
    });
  }

  /** Why a session ended, or null while it runs. */
  sessionEndReason(sessionId: string): Promise<EndReason | null> {
    return this.#read(async () => {
      const row = await this.#get<{ end_reason: EndReason | null }>(
        "SELECT end_reason FROM sessions WHERE id = $1",
        sessionId,
      );
      return row?.end_reason ?? null;
    });
  }

  // --- stability ---------------------------------------------------------------

  /**
   * The machine's last seven days as rank()'s StabilityStats, and the bucket
   * they fall in. Offered time since the last check-in counts too, so a machine
   * that went offline and stayed away loses coverage without checking in again.
   * Uptime is kept per whole UTC day, so its window can reach up to a day
   * further back than the exact cutoff used for sessions.
   */
  stability(machineId: string): Promise<ReturnType<typeof stabilityFrom>> {
    return this.#read(() => this.#stability(machineId));
  }

  /** True when the ticket was handed out for a session that has since ended. A ticket minted by hand has none. */
  ticketRevoked(ticketId: string): Promise<boolean> {
    return this.#read(async () =>
      Boolean(
        await this.#get("SELECT 1 FROM sessions WHERE ticket_id = $1 AND ended_at IS NOT NULL", ticketId),
      ),
    );
  }

  // --- matching and deadlines ------------------------------------------------

  /** Settle whatever is due now and match. The deadline timer calls it; so may a test. */
  tick(): Promise<void> {
    return this.#transaction(() => this.#tick(this.#now()));
  }

  /**
   * When the next thing falls due with no call to cause it: a machine with no
   * socket going silent, a reservation lapsing, a session running out, a queued
   * booking nobody checks on timing out. Null when nothing is waiting on time.
   */
  nextDeadline(): Promise<number | null> {
    return this.#read(() => this.#nextDeadline());
  }

  async #nextDeadline(): Promise<number | null> {
    const row = await this.#get<{ at: number | null }>(
      `SELECT min(at) AS at FROM (
         SELECT GREATEST(last_seen_at + $1, $2) AS at FROM machines
           WHERE status NOT IN ('idle', 'offline') AND NOT (id = ANY ($3::text[]))
         UNION ALL SELECT expires_at FROM reservations
         UNION ALL SELECT expires_at FROM sessions WHERE ended_at IS NULL
         UNION ALL SELECT last_seen_at + $4 FROM bookings WHERE status = 'queued'
       ) AS deadlines`,
      LIVENESS_MS,
      this.#graceUntil,
      this.#presentIds(),
      QUEUE_TIMEOUT_MS,
    );
    return row!.at;
  }

  /** Arm the one timer for the deadline `at` (null: nothing is waiting on time), replacing the last. */
  #arm(at: number | null): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#closed || at === null) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, at - this.#now()));
    this.#timer = setTimeout(() => this.#wake(), delay);
    this.#timer.unref?.();
  }

  /** The timer fired: settle what fell due. A failure is retried rather than left unarmed. */
  #wake(): void {
    this.#timer = undefined;
    this.tick().catch((error: unknown) => {
      // An unreachable or broken database must not take the server down with it.
      console.error("[swiff] platform tick failed:", error instanceof Error ? error.name : typeof error);
      this.#retrySoon();
    });
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
  async #tick(now: number): Promise<void> {
    // An open socket is contact right now, so the rules below that read
    // last_seen_at treat it as such.
    if (this.#present.size) {
      await this.#run(
        "UPDATE machines SET last_seen_at = $1 WHERE id = ANY ($2::text[])",
        now,
        this.#presentIds(),
      );
    }

    // Silent machines first, so nothing below hands a booking to one.
    const silent =
      now < this.#graceUntil
        ? []
        : await this.#all<MachineRow>(
            "SELECT * FROM machines WHERE status NOT IN ('idle', 'offline') AND last_seen_at <= $1",
            now - LIVENESS_MS,
          );
    for (const machine of silent) await this.#goOffline(machine, now);

    // An unclaimed reservation: a renter who checked in since the match saw it
    // and let it go, so the booking expires. One who has not been heard from
    // since was away; the booking goes back to the queue in its old place, and
    // the queue timeout decides whether they are coming back.
    const lapsed = await this.#all<ReservationRow>("SELECT * FROM reservations WHERE expires_at <= $1", now);
    for (const reservation of lapsed) {
      const { last_seen_at } = (await this.#bookingRow(reservation.booking_id))!;
      const matchedAt = reservation.expires_at - RESERVATION_MS;
      await this.#run("DELETE FROM reservations WHERE id = $1", reservation.id);
      await this.#setBookingStatus(reservation.booking_id, last_seen_at >= matchedAt ? "expired" : "queued");
      await this.#setStatus(reservation.machine_id, "available");
    }

    // The host ends a session when the time runs out; this is the backstop for
    // one that never says so (time_up), and for a renter who claimed and never
    // arrived (grace_expired).
    const overrun = await this.#all<SessionRow>(
      "SELECT * FROM sessions WHERE ended_at IS NULL AND expires_at <= $1",
      now,
    );
    for (const session of overrun) {
      await this.#endSession(
        session,
        session.expires_at,
        session.started_at === null ? "grace_expired" : "time_up",
      );
      await this.#setStatus(session.machine_id, "available");
    }

    // A renter who stopped checking on a queued booking has gone; matching it
    // would only hold a machine for nobody.
    const gone = await this.#all<{ id: string }>(
      "SELECT id FROM bookings WHERE status = 'queued' AND last_seen_at <= $1",
      now - QUEUE_TIMEOUT_MS,
    );
    for (const { id } of gone) await this.#setBookingStatus(id, "expired");

    await this.#match(now);
  }

  /**
   * Take a machine that stopped answering offline: count its offered time,
   * count a liveness drop unless its offer ended within LIVENESS_MS of its last
   * check-in (it stopped as planned), and let go of what it held as of that
   * check-in.
   */
  async #goOffline(machine: MachineRow, now: number): Promise<void> {
    await this.#accrue(machine, now);
    if (machine.available_until === null || machine.available_until > machine.last_seen_at + LIVENESS_MS) {
      await this.#run(
        `INSERT INTO machine_uptime (machine_id, day, drops) VALUES ($1, $2, 1)
           ON CONFLICT (machine_id, day) DO UPDATE SET drops = machine_uptime.drops + 1`,
        machine.id,
        utcDay(now),
      );
    }
    await this.#release(machine, machine.last_seen_at, "host_offline");
    await this.#setStatus(machine.id, "offline");
  }

  /**
   * Oldest booking first, each to the cheapest live machine free for the whole
   * booking that has the game installed and meets its minimum (MATCH_GATES).
   */
  async #match(now: number): Promise<void> {
    const queued = await this.#all<BookingRow>(
      "SELECT * FROM bookings WHERE status = 'queued' ORDER BY created_at, seq",
    );
    for (const booking of queued) {
      const game = await this.#requirements.lookup(booking.game_id);
      const machines = await this.#all<MachineRow & { has_game: boolean }>(
        `SELECT m.*, EXISTS (SELECT 1 FROM machine_games g WHERE g.machine_id = m.id AND g.appid = $1) AS has_game
           FROM machines m
           WHERE status = 'available' AND last_seen_at > $2
             AND (available_until IS NULL OR available_until >= $3)
           ORDER BY price, id COLLATE "C"`,
        booking.game_id,
        now - LIVENESS_MS,
        now + booking.minutes * 60_000,
      );
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
      await this.#run(
        "INSERT INTO reservations (id, booking_id, machine_id, expires_at) VALUES ($1, $2, $3, $4)",
        newId(),
        booking.id,
        machine.id,
        now + RESERVATION_MS,
      );
      await this.#setBookingStatus(booking.id, "matched");
      await this.#setStatus(machine.id, "reserved");
    }
  }

  /**
   * Let go of whatever the machine holds: a waiting booking goes back to the
   * front of the queue for another machine, a running session ends at `at`
   * for `reason`.
   */
  async #release(machine: MachineRow, at: number, reason: EndReason): Promise<void> {
    if (machine.status === "reserved") {
      const reservation = await this.#get<ReservationRow>(
        "SELECT * FROM reservations WHERE machine_id = $1",
        machine.id,
      );
      if (reservation) {
        await this.#run("DELETE FROM reservations WHERE id = $1", reservation.id);
        await this.#setBookingStatus(reservation.booking_id, "queued");
      }
    }
    if (machine.status === "in_session") {
      const session = await this.#get<SessionRow>(
        "SELECT * FROM sessions WHERE machine_id = $1 AND ended_at IS NULL",
        machine.id,
      );
      if (session) await this.#endSession(session, Math.max(at, session.started_at ?? at), reason);
    }
  }

  /**
   * The one way a session ends: close it, record why, price the time actually
   * played at the machine's hourly rate, and end its host session so its keys
   * die with it.
   */
  async #endSession(session: SessionRow, endedAt: number, reason: EndReason): Promise<void> {
    const { price } = (await this.#get<{ price: number }>(
      "SELECT price FROM machines WHERE id = $1",
      session.machine_id,
    ))!;
    const played = session.started_at === null ? 0 : Math.max(0, endedAt - session.started_at);
    await this.#run(
      "UPDATE sessions SET ended_at = $1, price = $2, end_reason = $3 WHERE id = $4",
      endedAt,
      Math.round((price * played) / 3_600_000),
      reason,
      session.id,
    );
    await this.#run("DELETE FROM key_sessions WHERE session_id = $1", session.id);
    await this.#setBookingStatus(session.booking_id, "ended");
    this.#notices.push(() => this.#onSessionEnded(session.machine_id, session.id));
  }

  // --- rows ------------------------------------------------------------------

  /** Store each section the report carries; a section it leaves out keeps what was stored. */
  async #saveReport(machineId: string, report: HostReport): Promise<void> {
    if (report.name !== undefined) {
      await this.#run("UPDATE machines SET name = $1 WHERE id = $2", report.name, machineId);
    }
    const hw = report.hardware;
    if (hw) {
      await this.#run(
        `UPDATE machines SET gpu_model = $1, gpu_score = $2, vram_mb = $3, ram_mb = $4, cpu_model = $5,
           cpu_cores = $6, encoders = $7, display = $8 WHERE id = $9`,
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
      await this.#run(
        "UPDATE machines SET controls = $1 WHERE id = $2",
        JSON.stringify(report.controls),
        machineId,
      );
    }
    if (report.net) {
      await this.#run(
        "UPDATE machines SET rtt_ms = $1, jitter_ms = $2, up_mbps = $3 WHERE id = $4",
        report.net.rttMs,
        report.net.jitterMs,
        report.net.upMbps,
        machineId,
      );
    }
    if (report.games) {
      await this.#run("DELETE FROM machine_games WHERE machine_id = $1", machineId);
      // One statement for the whole list: up to MAX_GAMES rows.
      await this.#run(
        `INSERT INTO machine_games (machine_id, appid) SELECT $1, unnest($2::bigint[])
           ON CONFLICT DO NOTHING`,
        machineId,
        report.games,
      );
    }
  }

  /**
   * Record a check-in, creating the machine the first time it is heard from,
   * and its owner as configured now, so a changed owner applies at once: a
   * reservation the new owner already holds on it goes back to the queue.
   * Time offered since the last one is counted first (see #accrue).
   */
  async #touch(machineId: string, now: number): Promise<MachineRow> {
    const before = await this.#machineRow(machineId);
    if (before) await this.#accrue(before, now);
    const owner = this.#owners.get(machineId) ?? null;
    const machine = (await this.#get<MachineRow>(
      `INSERT INTO machines (id, owner_id, status, last_seen_at, uptime_at) VALUES ($1, $2, 'idle', $3, $3)
         ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, last_seen_at = excluded.last_seen_at,
           uptime_at = excluded.uptime_at
         RETURNING *`,
      machineId,
      owner,
      now,
    ))!;
    if (
      owner !== null &&
      owner !== before?.owner_id &&
      (await this.#releaseOwnersReservation(machineId, owner))
    ) {
      return (await this.#machineRow(machineId))!;
    }
    return machine;
  }

  /**
   * Hand back a reservation on the machine held by a booking of its own owner,
   * made before the owner was known: the booking returns to the queue, where
   * matching keeps it off this machine, and the machine is free again.
   * True when there was one.
   */
  async #releaseOwnersReservation(machineId: string, owner: string): Promise<boolean> {
    const reservation = await this.#get<ReservationRow>(
      `SELECT r.* FROM reservations r JOIN bookings b ON b.id = r.booking_id
         WHERE r.machine_id = $1 AND b.renter_id = $2`,
      machineId,
      owner,
    );
    if (!reservation) return false;
    await this.#run("DELETE FROM reservations WHERE id = $1", reservation.id);
    await this.#setBookingStatus(reservation.booking_id, "queued");
    await this.#setStatus(machineId, "available");
    return true;
  }

  /**
   * Add the machine's offered time from uptime_at to `now` to machine_uptime,
   * split by UTC day, and move uptime_at to `now`. Offered time ends early at
   * available_until; the stretch within LIVENESS_MS of the last check-in counts
   * as seen. Rows for days before the one the stability window starts in are
   * dropped.
   */
  async #accrue(machine: MachineRow, now: number): Promise<void> {
    for (const piece of this.#pendingUptime(machine, now)) {
      await this.#run(
        `INSERT INTO machine_uptime (machine_id, day, offered_ms, seen_ms) VALUES ($1, $2, $3, $4)
           ON CONFLICT (machine_id, day) DO UPDATE
             SET offered_ms = machine_uptime.offered_ms + excluded.offered_ms,
                 seen_ms = machine_uptime.seen_ms + excluded.seen_ms`,
        machine.id,
        piece.day,
        piece.offeredMs,
        piece.seenMs,
      );
    }
    await this.#run("UPDATE machines SET uptime_at = $1 WHERE id = $2", now, machine.id);
    await this.#run(
      "DELETE FROM machine_uptime WHERE machine_id = $1 AND day < $2",
      machine.id,
      utcDay(now - STABILITY_WINDOW_MS),
    );
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

  /** stability(), within the running call. */
  async #stability(machineId: string): Promise<ReturnType<typeof stabilityFrom>> {
    const now = this.#now();
    const since = now - STABILITY_WINDOW_MS;
    const totals = (await this.#get<UptimeTotals>(
      `SELECT coalesce(sum(offered_ms), 0)::bigint AS "offeredMs", coalesce(sum(seen_ms), 0)::bigint AS "seenMs",
              coalesce(sum(drops), 0)::bigint AS drops
         FROM machine_uptime WHERE machine_id = $1 AND day >= $2`,
      machineId,
      utcDay(since),
    ))!;
    const machine = await this.#machineRow(machineId);
    if (machine) {
      for (const piece of this.#pendingUptime(machine, now, since)) {
        totals.offeredMs += piece.offeredMs;
        totals.seenMs += piece.seenMs;
      }
    }
    const rows = await this.#all<Pick<SessionRow, "end_reason" | "qos">>(
      `SELECT end_reason, qos FROM sessions
         WHERE machine_id = $1 AND ended_at > $2 AND end_reason IS NOT NULL`,
      machineId,
      since,
    );
    const sessions: EndedSession[] = rows.map((row) => ({
      endReason: row.end_reason!,
      packetLoss: fromJson<QosSummary | null>(row.qos, null)?.packetLoss ?? null,
    }));
    return stabilityFrom(totals, sessions);
  }

  /** The session, if it runs on this machine and has not ended. */
  async #openSession(machineId: string, sessionId: string): Promise<SessionRow | null> {
    const row = await this.#get<SessionRow>(
      "SELECT * FROM sessions WHERE id = $1 AND machine_id = $2 AND ended_at IS NULL",
      sessionId,
      machineId,
    );
    return row ?? null;
  }

  /** The machine row, or null when it has never been heard from. */
  async #machineRow(machineId: string): Promise<MachineRow | null> {
    return (await this.#get<MachineRow>("SELECT * FROM machines WHERE id = $1", machineId)) ?? null;
  }

  /** The machines holding a socket open. */
  #presentIds(): string[] {
    return [...this.#present];
  }

  /** The booking row, or null when there is none or, given a renter, it is not theirs. */
  async #bookingRow(bookingId: string, renterId?: string | null): Promise<BookingRow | null> {
    const row = await this.#get<BookingRow>("SELECT * FROM bookings WHERE id = $1", bookingId);
    if (!row || (renterId !== undefined && row.renter_id !== renterId)) return null;
    return row;
  }

  /** Move a machine to `status`. */
  async #setStatus(machineId: string, status: MachineStatus): Promise<void> {
    await this.#run("UPDATE machines SET status = $1 WHERE id = $2", status, machineId);
  }

  /** Move a booking to `status`; whoever watches it is told once the change commits. */
  async #setBookingStatus(bookingId: string, status: BookingStatus): Promise<void> {
    await this.#run("UPDATE bookings SET status = $1 WHERE id = $2", status, bookingId);
    this.#changed.add(bookingId);
  }

  /** What the host is told about its machine, with the session running on it. */
  async #machineView(machineId: string): Promise<MachineView> {
    const m = (await this.#get<MachineRow & { session_id: string | null }>(
      `SELECT m.*, s.id AS session_id FROM machines m
         LEFT JOIN sessions s ON s.machine_id = m.id AND s.ended_at IS NULL
         WHERE m.id = $1`,
      machineId,
    ))!;
    return {
      id: m.id,
      status: m.status,
      gpu: m.gpu_model,
      cpu: m.cpu_model,
      price: m.price,
      ...(m.session_id ? { session: { id: m.session_id } } : {}),
    };
  }

  /** What the renter is told about a booking: its machine, claim deadline, session and price. */
  async #bookingView(bookingId: string): Promise<BookingView | null> {
    const booking = await this.#bookingRow(bookingId);
    if (!booking) return null;
    const view: BookingView = {
      bookingId: booking.id,
      status: booking.status,
      gameId: booking.game_id,
      minutes: booking.minutes,
    };
    const reservation = await this.#get<ReservationRow>(
      "SELECT * FROM reservations WHERE booking_id = $1",
      bookingId,
    );
    const session = await this.#get<SessionRow>("SELECT * FROM sessions WHERE booking_id = $1", bookingId);
    const machineId = reservation?.machine_id ?? session?.machine_id;
    if (machineId) {
      const m = (await this.#machineRow(machineId))!;
      view.machine = { id: m.id, gpu: m.gpu_model, cpu: m.cpu_model, price: m.price };
    }
    if (reservation) view.claimBy = reservation.expires_at;
    if (session) view.sessionId = session.id;
    if (session?.price != null) view.price = session.price;
    return view;
  }

  // --- statements and calls ---------------------------------------------------

  /** The running call's transaction. A statement outside any call is a bug. */
  #active(): Queryable {
    if (!this.#tx) throw new Error("no platform call is running");
    return this.#tx;
  }

  /** The statement's first row, if any. */
  async #get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return (await this.#active().query<T>(sql, params)).rows[0];
  }

  /** Every row of the statement. */
  async #all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    return (await this.#active().query<T>(sql, params)).rows;
  }

  /** Run the statement; how many rows it changed. */
  async #run(sql: string, ...params: unknown[]): Promise<number> {
    return (await this.#active().query(sql, params)).rowCount;
  }

  /** Run `work` once every call made before it has finished, and before any made after it starts. */
  #inTurn<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work);
    this.#queue = run.catch(() => {});
    return run;
  }

  /** Run `work` in its turn, as one read-only transaction. */
  #read<T>(work: () => Promise<T>): Promise<T> {
    return this.#inTurn(() =>
      this.#db.transaction(async (tx) => {
        this.#tx = tx;
        try {
          return await work();
        } finally {
          this.#tx = null;
        }
      }, READ),
    );
  }

  /**
   * Run `work` in its turn, as one transaction that may write. Once it
   * commits, re-arm the deadline timer and deliver the notices it queued; a
   * rollback drops them and arms a retry.
   */
  #transaction<T>(work: () => Promise<T>): Promise<T> {
    return this.#inTurn(async () => {
      let done: { result: T; next: number | null };
      try {
        done = await this.#db.transaction(async (tx) => {
          this.#tx = tx;
          try {
            const result = await work();
            return { result, next: await this.#nextDeadline() };
          } finally {
            this.#tx = null;
          }
        }, WRITE);
      } catch (error) {
        this.#notices = [];
        this.#changed.clear();
        this.#retrySoon();
        throw error;
      }
      this.#arm(done.next);
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
          console.error(
            "[swiff] platform notice failed:",
            error instanceof Error ? error.name : typeof error,
          );
        }
      }
      return done.result;
    });
  }
}
