// The platform's state: machines, bookings, reservations and sessions, one
// Postgres table each, and the rules that move a booking through them.
//
//   renter  book ─► queued ─► matched ─► claimed ─► playing ─► ended
//    bookMachine ───────────────┘ (the machine picked, while it is free)
//                     │         └──────────► expired (lapses unclaimed)
//                     └ (renter silent for QUEUE_TIMEOUT_MS) ─► expired
//
// The claim clock: a matched renter has RESERVATION_MS to claim from their
// first contact since the match, which is the match itself when they were
// there for it (their own call made it, or their event stream on the booking
// was open). One who was away (tab closed, laptop asleep) has the machine
// held for them until they are back, so the clock starts when their page
// speaks again, but never past MAX_HOLD_MS from the match.
//
//   machine idle ─► available ─► reserved ─► in_session ─► available
//                 (socket dropped, or silent for LIVENESS_MS: offline; taken back: idle)
//
// The reset hold: a rental-mode PC restarts between renters, while idle, so the
// next one gets a clean PC (docs/system-design/host.md). Before it restarts it
// takes itself off offer with `reset`. That is taking it back, idle, unless a
// renter claimed it and has not started: a reservation goes back to the queue,
// so nobody is matched to a PC that is about to restart, and a started session
// ends as owner_kill. A session claimed in the instant before, not yet
// started, is kept rather than ended, and the machine holds the reset for up
// to RESET_HOLD_MS: its silence while it restarts does not end that session. The hold ends once the PC is back (it starts the
// session's host session, or offers the machine again), when the owner takes
// it back, or when it runs out, after which the usual liveness rule applies. A
// held session that ends before the PC is back leaves the machine idle, as the
// reset would have with no session there.
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
// running out), so nothing polls. A booking is matched by @swiff/rank's rank(),
// the order the renter's own list of machines is in: only to a machine that
// passes its gates (the game installed, the hardware the game asks for against
// the requirements table, not the renter's own, close enough), and to the best
// of those, not merely the cheapest. A renter who picked a machine from that
// list books it straight away instead, when it is still free (bookMachine).
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
  gpuScore,
  rank,
  type Candidate,
  type Control,
  type Encoder,
  type HostProfile,
  type LinkStats,
  type PicturePref,
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
/**
 * How long a matched renter has to claim the machine, from their first contact
 * since the match: the match itself when they were there for it.
 */
export const RESERVATION_MS = 60_000;
/**
 * The longest a machine is held for a match, however late its renter comes
 * back: one away at the match never holds it longer than this.
 */
export const MAX_HOLD_MS = 2 * 60_000;
/**
 * How long a rental-mode PC's restart between renters may keep a session
 * claimed in the instant before it: the reset hold, from the reset call.
 */
export const RESET_HOLD_MS = 3 * 60_000;
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
  /**
   * Unix ms after which it is no longer offered, when the owner set one. A host
   * that takes the machine off offer for a while (rental mode, while it resets
   * between renters) sends it back when it offers the machine again.
   */
  until?: number;
  /** The session running on it, when there is one: the host starts and ends it by this id. */
  session?: { id: string };
  /** Unix ms until which a reset holds that session through the PC's restart, while it does. */
  resetUntil?: number;
};

/** How the host takes the machine off offer. */
export type OffOffer = {
  /**
   * For a rental-mode restart between renters: a session claimed in the instant
   * before, and not yet started, is kept, and held through the restart, rather
   * than ended. A started one ends as taking the machine back does.
   */
  reset?: boolean;
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
  /** The machine it was matched to, once there is one, by the name its owner gave it. */
  machine?: { id: string; name: string | null; gpu: string | null; cpu: string | null; price: number };
  /**
   * Unix ms by which a matched booking must be claimed: RESERVATION_MS from the
   * renter's first contact since the match, or, until they are back, the end
   * of MAX_HOLD_MS from the match.
   */
  claimBy?: number;
  sessionId?: string;
  /** Unix ms the session started (the renter arrived), while it runs. */
  startedAt?: number;
  /** Cents charged for the time played, once the session has ended. */
  price?: number;
};

/** What the PC is told when a renter claims it: the session to start, the game and the time booked. */
export type ClaimedSession = { sessionId: string; gameId: number; minutes: number };

export type ClaimResult =
  | ({ ok: true; roomId: string } & ClaimedSession)
  | { ok: false; reason: "not-found" | "not-claimable"; status?: BookingStatus };

/**
 * The renter's round trips in ms, as their page measured them: to the server,
 * and straight to any machine it probed, by machine id. Matching judges a
 * machine's latency by them (gate E6 and the sort).
 */
export type Rtts = { server?: number; machines?: Record<string, number> };

/** How the renter plays: the controls they turned on and their Picture setting. None and best when left out. */
export type PlayPrefs = { controls?: Control[]; picture?: PicturePref };

/** What became of the renter ending their booking: its view once ended, or why not. */
export type EndResult =
  | { ok: true; booking: BookingView }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "over"; status: BookingStatus };

/** What became of a renter's ticket-authenticated call (a QoS report or leaving): done, or why not. */
export type QosResult = "ok" | "not-found" | "wrong-ticket" | "over";

/**
 * A claimed booking's running session, for handing its ticket out again: the
 * room, the ticket id recorded at claim, and how long the session has left (ms).
 */
export type RunningSession =
  | { ok: true; sessionId: string; roomId: string; ticketId: string; remainingMs: number }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "not-running"; status: BookingStatus };

/**
 * What renters ask for, for one game: the renters who booked it within the
 * window or are still waiting for it, and the bookings for it in the queue now.
 */
export type GameDemand = { appid: number; looking: number; waiting: number };

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
  /** Until when a reset holds its session through the PC's restart; null when none is held. */
  reset_until: number | null;
};
type BookingRow = {
  id: string;
  renter_id: string | null;
  game_id: number;
  minutes: number;
  status: BookingStatus;
  last_seen_at: number;
  /** JSON Rtts, null when the renter sent none. */
  rtts: string | null;
  /** JSON Control[], null when the renter sent none. */
  controls: string | null;
  picture: PicturePref | null;
};
/** A machine free to be matched now: its row, the games installed on it and its seven days. */
type FreeMachine = { row: MachineRow; installed: number[]; history: StabilityStats };
type ReservationRow = {
  id: string;
  booking_id: string;
  machine_id: string;
  matched_at: number;
  expires_at: number;
};
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

const MB_PER_GB = 1024;

/** A JSON column read back, or `fallback` when it is empty. */
function fromJson<T>(value: string | null, fallback: T): T {
  return value === null ? fallback : (JSON.parse(value) as T);
}

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
 * The stage-1 estimate of the path from a renter to a host: both legs through
 * the server added up. Null when the host never reported its network, which
 * fails gate E6: a machine whose latency is unknown is not offered.
 */
export function estimateLink(renterRttMs: number, net: Net | null): LinkStats | null {
  if (!net) return null;
  return { rttMs: renterRttMs + net.rttMs, jitterP95Ms: net.jitterMs, relayed: false };
}

/**
 * The path from the renter who made a booking to a machine: the round trip
 * they measured straight to it, when they did, else the estimate through the
 * server from theirs to the server. A renter who sent no round trips counts
 * their own leg as nothing, so only the host's leg is judged.
 */
function bookingLink(rtts: Rtts, machine: MachineRow): LinkStats | null {
  const net = profileOf(machine, []).net;
  if (rtts.machines && Object.hasOwn(rtts.machines, machine.id)) {
    return { rttMs: rtts.machines[machine.id]!, jitterP95Ms: net?.jitterMs ?? 0, relayed: false };
  }
  return estimateLink(rtts.server ?? 0, net);
}

/** The renter who made the booking, as rank() reads them: by default no controls asked for, the best picture. */
function bookingRenter(
  booking: Pick<BookingRow, "id" | "renter_id" | "minutes" | "controls" | "picture">,
): RenterPrefs {
  return {
    id: booking.renter_id ?? `booking:${booking.id}`,
    controls: fromJson<Control[]>(booking.controls, []),
    picture: booking.picture ?? "best",
    sessionMinutes: booking.minutes,
  };
}

/** Unguessable, so one id cannot be guessed from another. */
const newId = () => randomBytes(16).toString("base64url");

/** The longest delay setTimeout takes; a later deadline is woken for early and re-armed. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** How soon a wake that failed (the database unreachable) is tried again. */
export const RETRY_MS = 1_000;

/**
 * What a call that may write does first: take the machines table, so one such
 * call runs at a time on the database, whichever server makes it.
 */
const WRITE = "LOCK TABLE machines IN EXCLUSIVE MODE";
/** Opens a call that only reads: one consistent view, however many statements it takes. */
const READ = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

export type PlatformOptions = {
  /** Where the state is kept (db.ts). The platform makes its tables there, and closes it when it closes. */
  database: Database;
  now?: () => number;
  owners?: ReadonlyMap<string, string>;
  /**
   * Offer and match a free machine only while its PC holds a socket open to
   * the server (hostConnected), never on heartbeats alone. Set when hosting
   * requires attestation: only an attested socket may host, so a machine with
   * none could be booked but never served.
   */
  offeredOnlyWhilePresent?: boolean;
  onSessionEnded?: (machineId: string, sessionId: string, ticketId: string | null) => void;
  onSessionClaimed?: (machineId: string, claim: ClaimedSession) => void;
  onBookingChanged?: (bookingId: string) => void;
  onAvailabilityChanged?: () => void;
};

export class Platform {
  readonly #db: Database;
  readonly #now: () => number;
  /** What each game needs, on the same database: gate E3 compares a machine with it. */
  readonly #requirements: RequirementsTable;
  readonly #onSessionEnded: (machineId: string, sessionId: string, ticketId: string | null) => void;
  readonly #onSessionClaimed: (machineId: string, claim: ClaimedSession) => void;
  readonly #onBookingChanged: (bookingId: string) => void;
  readonly #onAvailabilityChanged: () => void;
  readonly #owners: ReadonlyMap<string, string>;
  readonly #offeredOnlyWhilePresent: boolean;
  /** The transaction of the call running now: every statement goes through it. */
  #tx: Queryable | null = null;
  /** The last call queued: the next one runs once it has finished. */
  #queue: Promise<unknown> = Promise.resolve();
  /** Notices from the open transaction, delivered once it commits. */
  #notices: (() => void)[] = [];
  /** Bookings whose status the open transaction changed, told once it commits. */
  #changed = new Set<string>();
  /** Whether the open transaction changed what is on offer, told once it commits. */
  #offerChanged = false;
  /** Machines whose PC holds a socket open to the server. */
  readonly #present = new Set<string>();
  /** Open renter event streams per booking: a renter with one open is there for a match. */
  readonly #watched = new Map<string, number>();
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
    offeredOnlyWhilePresent = false,
    onSessionEnded = () => {},
    onSessionClaimed = () => {},
    onBookingChanged = () => {},
    onAvailabilityChanged = () => {},
  }: PlatformOptions) {
    this.#db = database;
    this.#now = now;
    this.#owners = owners;
    this.#offeredOnlyWhilePresent = offeredOnlyWhilePresent;
    this.#onSessionEnded = onSessionEnded;
    this.#onSessionClaimed = onSessionClaimed;
    this.#onBookingChanged = onBookingChanged;
    this.#onAvailabilityChanged = onAvailabilityChanged;
    this.#requirements = new RequirementsTable(
      { query: (sql, params) => this.#active().query(sql, params) },
      now,
    );
  }

  /**
   * The platform on `database`, its tables made or brought up to date first.
   *
   * `onSessionEnded` hears of every session that ends, however it ends, with its
   * machine, id and the ticket it handed out (null before one was);
   * `onSessionClaimed` of every claim, with the machine claimed;
   * `onBookingChanged` of every booking whose status moved, once per change;
   * `onAvailabilityChanged` once per change that offered a machine, took it
   * back, or moved it between free, busy and offline.
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
   * host reported with it. Taking it back ends whatever it was doing, except
   * a session not yet started that it is taken off offer from with `reset`:
   * that one is kept, and held through the restart (the reset hold).
   */
  setAvailability(
    machineId: string,
    available: boolean,
    spec: MachineSpec = {},
    { reset = false }: OffOffer = {},
  ): Promise<MachineView> {
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
      // Its terms (price, until when) are what renters see, whether or not its status moves.
      this.#offerChanged = true;

      const unstarted =
        !available &&
        reset &&
        machine.status === "in_session" &&
        (await this.#get<{ id: string }>(
          "SELECT id FROM sessions WHERE machine_id = $1 AND ended_at IS NULL AND started_at IS NULL",
          machineId,
        ));
      if (unstarted) {
        // Claimed in the instant before the restart, not yet served: served once the PC is back.
        // Asking again during a hold keeps its deadline: a hold never outlasts RESET_HOLD_MS.
        await this.#run(
          `UPDATE machines SET reset_until = CASE WHEN reset_until > $1 THEN reset_until ELSE $2 END
             WHERE id = $3`,
          now,
          now + RESET_HOLD_MS,
          machineId,
        );
      } else {
        await this.#run("UPDATE machines SET reset_until = NULL WHERE id = $1", machineId);
        if (!available) {
          await this.#release(machine, now, "owner_kill");
          await this.#setStatus(machineId, "idle");
        } else if (machine.status === "idle" || machine.status === "offline") {
          await this.#setStatus(machineId, "available");
        }
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
      if (this.#offeredOnlyWhilePresent && !this.#present.has(machineId)) this.#offerChanged = true;
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
    return this.#transaction(
      async () => {
        const now = this.#now();
        // Touched while still present: its offered time up to now counts as seen.
        const machine = (await this.#machineRow(machineId)) && (await this.#touch(machineId, now));
        if (this.#offeredOnlyWhilePresent && this.#present.has(machineId)) this.#offerChanged = true;
        this.#present.delete(machineId);
        if (!machine) return;
        if (dropped && (machine.status === "available" || machine.status === "reserved")) {
          await this.#goOffline(machine, now);
        }
        await this.#tick(now);
      },
      // Gone whatever the database says, even if the transaction never began: a
      // socket that closed is not presence. The retried tick finds the machine silent.
      () => this.#present.delete(machineId),
    );
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
   * now; with offeredOnlyWhilePresent, a free one without a socket open is not
   * on offer at all. A busy machine is free again when its session runs out, or, while
   * reserved, when a claim at the last moment would run out. Read only:
   * nothing is settled or matched. `at` is the time they were read at, for
   * judging them. The same few statements however many machines are on offer:
   * the calls behind this one wait on it.
   */
  offeredMachines(): Promise<OfferedSnapshot> {
    return this.#read(async () => {
      const now = this.#now();
      const rows = (
        await this.#all<MachineRow>(
          `SELECT * FROM machines WHERE status IN ('available', 'reserved', 'in_session')
           AND (available_until IS NULL OR available_until > $1) ORDER BY id COLLATE "C"`,
          now,
        )
      ).filter((m) => m.status !== "available" || this.#offerable(m.id));
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
      const busy = rows.filter((m) => m.status !== "available").map((m) => m.id);
      const backAt = new Map<string, number>();
      if (busy.length) {
        const backs = await this.#all<{ machine_id: string; at: number }>(
          `SELECT machine_id, expires_at AS at FROM sessions WHERE machine_id = ANY ($1::text[]) AND ended_at IS NULL
           UNION ALL
           SELECT r.machine_id, r.expires_at + b.minutes * 60000 FROM reservations r JOIN bookings b ON b.id = r.booking_id
             WHERE r.machine_id = ANY ($1::text[])`,
          busy,
        );
        for (const { machine_id, at } of backs) if (!backAt.has(machine_id)) backAt.set(machine_id, at);
      }
      const histories = await this.#stabilities(rows, now);
      const machines = rows.map((m): OfferedMachine => {
        const appids = installed.get(m.id) ?? [];
        const isBusy = m.status !== "available";
        const lastSeenAt = this.#present.has(m.id) ? now : m.last_seen_at;
        // The configured owner counts before the machine next checks in, as in matching.
        const row = { ...m, owner_id: this.#owners.get(m.id) ?? m.owner_id };
        return {
          host: hostProfileOf(row, appids, isBusy ? "busy" : "available", lastSeenAt),
          profile: profileOf(m, appids),
          history: histories.get(m.id)!.stats,
          backAt: isBusy ? (backAt.get(m.id) ?? null) : null,
        };
      });
      return { at: now, machines };
    });
  }

  /**
   * What renters ask for, by game, busiest first and at most `limit` games:
   * bookings made in the last `windowMs` and those still in the queue. Counts
   * only: no renter is named.
   */
  demand(windowMs: number, limit: number): Promise<GameDemand[]> {
    return this.#read(() =>
      this.#all<GameDemand>(
        `SELECT game_id AS appid, count(DISTINCT coalesce(renter_id, id))::int AS looking,
                count(*) FILTER (WHERE status = 'queued')::int AS waiting
           FROM bookings WHERE created_at > $1 OR status = 'queued'
           GROUP BY game_id ORDER BY looking DESC, waiting DESC, game_id LIMIT $2`,
        this.#now() - windowMs,
        limit,
      ),
    );
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
      this.#transaction(async () => {
        const added =
          (await this.#run(
            `INSERT INTO key_sessions (machine_id, session_id, grant_id)
               SELECT $1, $2, $3 WHERE EXISTS
                 (SELECT 1 FROM sessions WHERE id = $2 AND machine_id = $1 AND ended_at IS NULL)
             ON CONFLICT DO NOTHING`,
            machineId,
            sessionId,
            grantId,
          )) > 0;
        // Serving the session: the PC is back from any reset it held.
        if (added) await this.#run("UPDATE machines SET reset_until = NULL WHERE id = $1", machineId);
        return added;
      }),
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
   * The renter's first frame arrived: the session starts, as the host's start
   * does, if it has not already. Only the join ticket handed out for this
   * session may say so, and only while it runs. Answers the machine and the
   * game booked, which the PC is then told to launch.
   */
  renterStarted(
    sessionId: string,
    ticketId: string,
  ): Promise<{ machineId: string; gameId: number } | Exclude<QosResult, "ok">> {
    return this.#transaction(async () => {
      const session = await this.#get<SessionRow>("SELECT * FROM sessions WHERE id = $1", sessionId);
      if (!session) return "not-found";
      if (session.ticket_id === null || session.ticket_id !== ticketId) return "wrong-ticket";
      // Past its deadline it is over, even while the timer that ends it is still to run.
      if (session.ended_at !== null || session.expires_at <= this.#now()) return "over";
      if (session.started_at === null) {
        await this.#run("UPDATE sessions SET started_at = $1 WHERE id = $2", this.#now(), sessionId);
        await this.#setBookingStatus(session.booking_id, "playing");
      }
      const { game_id } = (await this.#get<{ game_id: number }>(
        "SELECT game_id FROM bookings WHERE id = $1",
        session.booking_id,
      ))!;
      return { machineId: session.machine_id, gameId: game_id };
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
      if (machine.status === "in_session") await this.#sessionOver(machineId);
      await this.#tick(now);
      return true;
    });
  }

  // --- renter ----------------------------------------------------------------

  /**
   * Queue a booking for `renterId` (a Steam id; null only in tests) and match
   * at once. `rtts` are the renter's round trips, which matching judges each
   * machine's latency by, and `prefs` how they play, which it ranks by, for as
   * long as the booking waits.
   */
  book(
    gameId: number,
    minutes: number,
    renterId: string | null = null,
    rtts: Rtts = {},
    prefs: PlayPrefs = {},
  ): Promise<BookingView> {
    return this.#transaction(async () => {
      const now = this.#now();
      const id = await this.#insertBooking(gameId, minutes, renterId, rtts, prefs, now);
      await this.#tick(now);
      return (await this.#bookingView(id))!;
    });
  }

  /**
   * Book the machine the renter picked from their list, reserved for them at
   * once (matched, to be claimed within RESERVATION_MS), when it is still free
   * for the whole booking and passes the same gates matching does. Null, with
   * no booking made, when it is not: taken a moment ago, gone, or never one
   * they could have.
   */
  bookMachine(
    machineId: string,
    gameId: number,
    minutes: number,
    renterId: string | null = null,
    rtts: Rtts = {},
    prefs: PlayPrefs = {},
  ): Promise<BookingView | null> {
    return this.#transaction(async () => {
      const now = this.#now();
      // The queue goes first: a machine a waiting booking fits is matched to it here.
      await this.#tick(now);
      const free = await this.#freeMachines(now, [machineId]);
      const ask = {
        id: "",
        renter_id: renterId,
        game_id: gameId,
        minutes,
        rtts: JSON.stringify(rtts),
        controls: JSON.stringify(prefs.controls ?? []),
        picture: prefs.picture ?? null,
      };
      if (!(await this.#best(ask, free, now))) return null;
      const id = await this.#insertBooking(gameId, minutes, renterId, rtts, prefs, now);
      await this.#reserve(id, machineId, now);
      return (await this.#bookingView(id))!;
    });
  }

  /**
   * The renter ends their booking, whatever it has come to: a queued one leaves
   * the queue, a matched one gives its machine back, and a claimed or playing
   * one ends its session as `renter`, as leaving with the join ticket does.
   * Ended either way, and the machine goes to whoever waits next. Only
   * `renterId`'s own booking; anyone else's reads as not found.
   */
  endBooking(bookingId: string, renterId: string | null = null): Promise<EndResult> {
    return this.#transaction(async (): Promise<EndResult> => {
      const now = this.#now();
      await this.#tick(now);
      const booking = await this.#bookingRow(bookingId, renterId);
      if (!booking) return { ok: false, reason: "not-found" };
      if (booking.status === "ended" || booking.status === "expired") {
        return { ok: false, reason: "over", status: booking.status };
      }
      if (booking.status === "matched") {
        const reservation = (await this.#get<ReservationRow>(
          "DELETE FROM reservations WHERE booking_id = $1 RETURNING *",
          bookingId,
        ))!;
        await this.#setStatus(reservation.machine_id, "available");
      }
      if (booking.status === "claimed" || booking.status === "playing") {
        const session = (await this.#get<SessionRow>(
          "SELECT * FROM sessions WHERE booking_id = $1",
          bookingId,
        ))!;
        await this.#renterEnds(session, now);
      } else {
        await this.#setBookingStatus(bookingId, "ended");
      }
      await this.#tick(now);
      return { ok: true, booking: (await this.#bookingView(bookingId))! };
    });
  }

  /**
   * A renter event stream opened on the booking: while one is, its renter is
   * there for a match. Call the function returned once it closes.
   */
  watchBooking(bookingId: string): () => void {
    this.#watched.set(bookingId, (this.#watched.get(bookingId) ?? 0) + 1);
    return () => {
      const left = (this.#watched.get(bookingId) ?? 1) - 1;
      if (left > 0) this.#watched.set(bookingId, left);
      else this.#watched.delete(bookingId);
    };
  }

  /**
   * The booking as it stands, or null when there is none or it is not
   * `renterId`'s. It counts as the renter's contact: a check on it, an event
   * stream opening on it, or the page's heartbeat. That contact is what keeps
   * a queued booking in the queue, and the first since a match made while the
   * renter was away starts its claim clock.
   */
  booking(bookingId: string, renterId: string | null = null): Promise<BookingView | null> {
    return this.#transaction(async () => {
      const now = this.#now();
      await this.#tick(now);
      const booking = await this.#bookingRow(bookingId, renterId);
      if (!booking) return null;
      await this.#run(
        `UPDATE reservations SET expires_at = LEAST($1::bigint + $2::bigint, matched_at + $3::bigint)
           WHERE booking_id = $4 AND matched_at > $5`,
        now,
        RESERVATION_MS,
        MAX_HOLD_MS,
        bookingId,
        booking.last_seen_at,
      );
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

  /**
   * The running session of `renterId`'s claimed booking, for a renter coming
   * back to it whose page no longer holds its ticket: the ticket is never
   * stored, so it is handed out again with the id recorded at claim, and
   * ending the session still revokes every copy. Anyone else's booking reads
   * as not found; one with no session running (not yet claimed, ended, or past
   * its deadline) as not running.
   */
  runningSession(bookingId: string, renterId: string): Promise<RunningSession> {
    return this.#read(async (): Promise<RunningSession> => {
      const booking = await this.#bookingRow(bookingId, renterId);
      if (!booking) return { ok: false, reason: "not-found" };
      const session = await this.#get<SessionRow>(
        "SELECT * FROM sessions WHERE booking_id = $1 AND ended_at IS NULL",
        bookingId,
      );
      const now = this.#now();
      const running =
        (booking.status === "claimed" || booking.status === "playing") &&
        session?.ticket_id != null &&
        session.expires_at > now;
      if (!running) return { ok: false, reason: "not-running", status: booking.status };
      return {
        ok: true,
        sessionId: session.id,
        roomId: session.machine_id,
        ticketId: session.ticket_id!,
        remainingMs: session.expires_at - now,
      };
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
   * out for this session may do it, and only while the session runs. A renter
   * who dropped and did not come back within the reconnect grace (grace.ts)
   * leaves the same way, as grace_expired.
   */
  leaveSession(
    sessionId: string,
    ticketId: string,
    reason: "renter" | "grace_expired" = "renter",
  ): Promise<QosResult> {
    return this.#transaction(async (): Promise<QosResult> => {
      const now = this.#now();
      const session = await this.#get<SessionRow>("SELECT * FROM sessions WHERE id = $1", sessionId);
      if (!session) return "not-found";
      if (session.ticket_id === null || session.ticket_id !== ticketId) return "wrong-ticket";
      if (session.ended_at !== null) return "over";
      await this.#renterEnds(session, now, reason);
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
    return this.#read(async () => {
      const machine = await this.#machineRow(machineId);
      const histories = await this.#stabilities(machine ? [machine] : [], this.#now(), [machineId]);
      return histories.get(machineId)!;
    });
  }

  /** The running session the ticket was handed out for, or null. A ticket minted by hand has none. */
  ticketSession(ticketId: string): Promise<string | null> {
    return this.#read(async () => {
      const row = await this.#get<{ id: string }>(
        "SELECT id FROM sessions WHERE ticket_id = $1 AND ended_at IS NULL",
        ticketId,
      );
      return row?.id ?? null;
    });
  }

  /** True when the ticket was handed out for a session that has since ended. A ticket minted by hand has none. */
  ticketRevoked(ticketId: string): Promise<boolean> {
    return this.#read(async () => (await this.#revoked([ticketId])).length > 0);
  }

  /** ticketRevoked() for many tickets, with one read: the ones revoked. */
  ticketsRevoked(ticketIds: string[]): Promise<string[]> {
    return this.#read(() => this.#revoked(ticketIds));
  }

  async #revoked(ticketIds: string[]): Promise<string[]> {
    if (!ticketIds.length) return [];
    const rows = await this.#all<{ ticket_id: string }>(
      "SELECT ticket_id FROM sessions WHERE ticket_id = ANY ($1::text[]) AND ended_at IS NOT NULL",
      ticketIds,
    );
    return rows.map((row) => row.ticket_id);
  }

  // --- matching and deadlines ------------------------------------------------

  /** Settle whatever is due now and match. The deadline timer calls it; so may a test. */
  tick(): Promise<void> {
    return this.#transaction(() => this.#tick(this.#now()));
  }

  /**
   * When the next thing falls due with no call to cause it: a machine with no
   * socket going silent (or its reset hold running out), a reservation
   * lapsing, a session running out, a queued booking nobody checks on timing
   * out. Null when nothing is waiting on time.
   */
  nextDeadline(): Promise<number | null> {
    return this.#read(() => this.#nextDeadline());
  }

  async #nextDeadline(): Promise<number | null> {
    const row = await this.#get<{ at: number | null }>(
      `SELECT min(at) AS at FROM (
         SELECT GREATEST(last_seen_at + $1, $2, coalesce(reset_until, 0)) AS at FROM machines
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
   * the end of its offer and then went quiet stopped as planned. One holding a
   * reset is not silent until the hold runs out: it is restarting.
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
            `SELECT * FROM machines WHERE status NOT IN ('idle', 'offline') AND last_seen_at <= $1
               AND (reset_until IS NULL OR reset_until <= $2)`,
            now - LIVENESS_MS,
            now,
          );
    for (const machine of silent) await this.#goOffline(machine, now);

    // An unclaimed reservation: its renter had their RESERVATION_MS from the
    // first contact since the match and let it go, or was away for all of
    // MAX_HOLD_MS. Either way the booking expires and the machine goes back.
    const lapsed = await this.#all<ReservationRow>("SELECT * FROM reservations WHERE expires_at <= $1", now);
    for (const reservation of lapsed) {
      await this.#run("DELETE FROM reservations WHERE id = $1", reservation.id);
      await this.#setBookingStatus(reservation.booking_id, "expired");
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
      await this.#sessionOver(session.machine_id);
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
    await this.#run("UPDATE machines SET reset_until = NULL WHERE id = $1", machine.id);
    await this.#setStatus(machine.id, "offline");
  }

  /**
   * Oldest booking first, each to the machine rank() puts first for it among
   * the live ones free for the whole booking (#best).
   */
  async #match(now: number): Promise<void> {
    const queued = await this.#all<BookingRow>(
      "SELECT * FROM bookings WHERE status = 'queued' ORDER BY created_at, seq",
    );
    if (!queued.length) return;
    let free = await this.#freeMachines(now);
    for (const booking of queued) {
      const machineId = await this.#best(booking, free, now);
      if (!machineId) continue; // a booking behind this one may still fit
      await this.#reserve(booking.id, machineId, now);
      free = free.filter((m) => m.row.id !== machineId);
    }
  }

  /**
   * The machines on offer, answering and free now (with offeredOnlyWhilePresent,
   * only those with a socket open), with what is installed on each and its
   * seven days for rank(), from four statements however many there are. `ids`
   * narrows them to those machines.
   */
  async #freeMachines(now: number, ids?: string[]): Promise<FreeMachine[]> {
    const answering = await this.#all<MachineRow>(
      `SELECT * FROM machines WHERE status = 'available' AND last_seen_at > $1
         AND (available_until IS NULL OR available_until > $2)
         AND ($3::text[] IS NULL OR id = ANY ($3::text[]))
         ORDER BY id COLLATE "C"`,
      now - LIVENESS_MS,
      now,
      ids ?? null,
    );
    const rows = answering.filter((m) => this.#offerable(m.id));
    if (!rows.length) return [];
    const installed = new Map<string, number[]>();
    const games = await this.#all<{ machine_id: string; appid: number }>(
      "SELECT machine_id, appid FROM machine_games WHERE machine_id = ANY ($1::text[]) ORDER BY appid",
      rows.map((m) => m.id),
    );
    for (const { machine_id, appid } of games) {
      const list = installed.get(machine_id) ?? [];
      list.push(appid);
      installed.set(machine_id, list);
    }
    const histories = await this.#stabilities(rows, now);
    return rows.map((row) => ({
      row,
      installed: installed.get(row.id) ?? [],
      history: histories.get(row.id)!.stats,
    }));
  }

  /**
   * The machine rank() puts first for the booking among `free`, or null when
   * none passes its gates: the game installed (E2), the hardware the game asks
   * for (E3), every control the booking asked for (E4), not the renter's own
   * (E5) and close enough by the renter's round trips (E6). Only a machine free for all of the booking's minutes is
   * considered. The order is the renter's own list's: free all session, most
   * reliable, best response, then picture, lowest latency, lowest price.
   */
  async #best(
    booking: Pick<BookingRow, "id" | "renter_id" | "game_id" | "minutes" | "rtts" | "controls" | "picture">,
    free: FreeMachine[],
    now: number,
  ): Promise<string | null> {
    const until = now + booking.minutes * 60_000;
    const fits = free.filter((m) => m.row.available_until === null || m.row.available_until >= until);
    if (!fits.length) return null;
    const game = await this.#requirements.lookup(booking.game_id);
    const rtts = fromJson<Rtts>(booking.rtts, {});
    const candidates = fits.map(({ row, installed, history }): Candidate => {
      // The configured owner counts at once, before the machine next checks in
      // and #touch records it, so a restart never matches an owner to their PC.
      const owned = { ...row, owner_id: this.#owners.get(row.id) ?? row.owner_id };
      return {
        host: hostProfileOf(owned, installed, "available", row.last_seen_at),
        link: bookingLink(rtts, row),
        history,
      };
    });
    const ranked = rank(game, bookingRenter(booking), candidates, { now, heartbeatMaxAgeMs: LIVENESS_MS });
    return ranked.hosts[0]?.host.id ?? null;
  }

  /**
   * Hold the machine for the booking: matched, waiting to be claimed. A renter
   * there at the match (the call that matched it was theirs, or their event
   * stream on it is open) has RESERVATION_MS from now; for one who was not,
   * the clock waits for their next contact (booking()) and the machine is held
   * up to MAX_HOLD_MS.
   */
  async #reserve(bookingId: string, machineId: string, now: number): Promise<void> {
    // An open stream at the match is the renter's contact then.
    if (this.#watched.has(bookingId)) {
      await this.#run("UPDATE bookings SET last_seen_at = $1 WHERE id = $2", now, bookingId);
    }
    await this.#run(
      `INSERT INTO reservations (id, booking_id, machine_id, matched_at, expires_at)
         SELECT $1, id, $2, $3::bigint, $3::bigint + CASE WHEN last_seen_at >= $3 THEN $4::bigint ELSE $5::bigint END
           FROM bookings WHERE id = $6`,
      newId(),
      machineId,
      now,
      RESERVATION_MS,
      MAX_HOLD_MS,
      bookingId,
    );
    await this.#setBookingStatus(bookingId, "matched");
    await this.#setStatus(machineId, "reserved");
  }

  /** Add a queued booking; its id. */
  async #insertBooking(
    gameId: number,
    minutes: number,
    renterId: string | null,
    rtts: Rtts,
    prefs: PlayPrefs,
    now: number,
  ): Promise<string> {
    const id = newId();
    await this.#run(
      `INSERT INTO bookings (id, renter_id, game_id, minutes, status, created_at, last_seen_at, rtts, controls, picture)
         VALUES ($1, $2, $3, $4, 'queued', $5, $5, $6, $7, $8)`,
      id,
      renterId,
      gameId,
      minutes,
      now,
      JSON.stringify(rtts),
      JSON.stringify(prefs.controls ?? []),
      prefs.picture ?? null,
    );
    return id;
  }

  /**
   * A machine whose session just ended: free for the next renter, or, while it
   * holds a reset, off offer (idle), as the reset left it with no session
   * there. Its host offers it again once the PC has restarted.
   */
  async #sessionOver(machineId: string): Promise<void> {
    const held = await this.#run(
      "UPDATE machines SET reset_until = NULL WHERE id = $1 AND reset_until IS NOT NULL",
      machineId,
    );
    await this.#setStatus(machineId, held ? "idle" : "available");
  }

  /** The renter ended the session, or never came back to it: closed for `reason`, its machine free again. */
  async #renterEnds(
    session: SessionRow,
    now: number,
    reason: "renter" | "grace_expired" = "renter",
  ): Promise<void> {
    await this.#endSession(session, Math.max(now, session.started_at ?? now), reason);
    const machine = (await this.#get<{ status: MachineStatus }>(
      "SELECT status FROM machines WHERE id = $1",
      session.machine_id,
    ))!;
    if (machine.status === "in_session") await this.#sessionOver(session.machine_id);
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
    this.#notices.push(() => this.#onSessionEnded(session.machine_id, session.id, session.ticket_id));
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

  /**
   * stability() for each of `ids` as of `now`, within the running call, from
   * two statements however many there are. `machines` are the rows already
   * read for them; an id with none has never been heard from.
   */
  async #stabilities(
    machines: MachineRow[],
    now: number,
    ids: string[] = machines.map((m) => m.id),
  ): Promise<Map<string, ReturnType<typeof stabilityFrom>>> {
    const since = now - STABILITY_WINDOW_MS;
    const totals = new Map<string, UptimeTotals>();
    const ended = new Map<string, EndedSession[]>();
    if (ids.length) {
      const uptime = await this.#all<UptimeTotals & { machine_id: string }>(
        `SELECT machine_id, sum(offered_ms)::bigint AS "offeredMs", sum(seen_ms)::bigint AS "seenMs",
                sum(drops)::bigint AS drops
           FROM machine_uptime WHERE machine_id = ANY ($1::text[]) AND day >= $2 GROUP BY machine_id`,
        ids,
        utcDay(since),
      );
      for (const { machine_id, offeredMs, seenMs, drops } of uptime) {
        totals.set(machine_id, { offeredMs, seenMs, drops });
      }
      const sessions = await this.#all<Pick<SessionRow, "machine_id" | "end_reason" | "qos">>(
        `SELECT machine_id, end_reason, qos FROM sessions
           WHERE machine_id = ANY ($1::text[]) AND ended_at > $2 AND end_reason IS NOT NULL`,
        ids,
        since,
      );
      for (const row of sessions) {
        const list = ended.get(row.machine_id) ?? [];
        list.push({
          endReason: row.end_reason!,
          packetLoss: fromJson<QosSummary | null>(row.qos, null)?.packetLoss ?? null,
        });
        ended.set(row.machine_id, list);
      }
    }
    const rows = new Map(machines.map((m) => [m.id, m]));
    return new Map(
      ids.map((id) => {
        const sum = { ...(totals.get(id) ?? { offeredMs: 0, seenMs: 0, drops: 0 }) };
        const machine = rows.get(id);
        if (machine) {
          for (const piece of this.#pendingUptime(machine, now, since)) {
            sum.offeredMs += piece.offeredMs;
            sum.seenMs += piece.seenMs;
          }
        }
        return [id, stabilityFrom(sum, ended.get(id) ?? [])];
      }),
    );
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

  /** Whether a free machine may be offered: always, or only while present (offeredOnlyWhilePresent). */
  #offerable(machineId: string): boolean {
    return !this.#offeredOnlyWhilePresent || this.#present.has(machineId);
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

  /** Move a machine to `status`; renters' walls are told once the change commits. */
  async #setStatus(machineId: string, status: MachineStatus): Promise<void> {
    const changes = await this.#run(
      "UPDATE machines SET status = $1 WHERE id = $2 AND status != $3",
      status,
      machineId,
      status,
    );
    if (changes) this.#offerChanged = true;
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
      ...(m.available_until !== null ? { until: m.available_until } : {}),
      ...(m.session_id ? { session: { id: m.session_id } } : {}),
      ...(m.session_id && m.reset_until !== null ? { resetUntil: m.reset_until } : {}),
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
      view.machine = { id: m.id, name: m.name, gpu: m.gpu_model, cpu: m.cpu_model, price: m.price };
    }
    if (reservation) view.claimBy = reservation.expires_at;
    if (session) view.sessionId = session.id;
    if (session?.started_at != null && session.ended_at === null) view.startedAt = session.started_at;
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
   * rollback drops them and arms a retry. `settled` runs once the transaction
   * is over, whether or not it ever began, still in its turn.
   */
  #transaction<T>(work: () => Promise<T>, settled: () => void = () => {}): Promise<T> {
    return this.#inTurn(async () => {
      let done: { result: T; next: number | null };
      try {
        done = await this.#db.transaction(
          async (tx) => {
            this.#tx = tx;
            try {
              const result = await work();
              return { result, next: await this.#nextDeadline() };
            } finally {
              this.#tx = null;
            }
          },
          "BEGIN",
          WRITE,
        );
      } catch (error) {
        this.#notices = [];
        this.#changed.clear();
        this.#offerChanged = false;
        this.#retrySoon();
        throw error;
      } finally {
        settled();
      }
      this.#arm(done.next);
      const notices = this.#notices;
      this.#notices = [];
      for (const bookingId of this.#changed) notices.push(() => this.#onBookingChanged(bookingId));
      this.#changed.clear();
      if (this.#offerChanged) notices.push(() => this.#onAvailabilityChanged());
      this.#offerChanged = false;
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
