// The platform's HTTP API, over the state in platform.ts.
//
//   Booking API (renter, signed in)        Host API (gaming PC, machine key)
//   GET  /api/games          (signed out)  PUT  /api/machines/:id/availability
//   GET  /api/availability?appids=         POST /api/machines/:id/heartbeat
//   GET  /api/games/:appid/machines?minutes=
//   GET  /api/me
//   POST /api/me/refresh
//   POST /api/signout        (signed out)  POST /api/sessions/:id/start
//   POST /api/bookings                     POST /api/sessions/:id/end
//   GET  /api/bookings/:id
//   POST /api/bookings/:id/claim
//   POST /api/bookings/:id/seen
//   POST /api/bookings/:id/end
//   POST /api/sessions/:id/qos   (ticket)
//   POST /api/sessions/:id/leave (ticket)
//   GET  /api/events?booking=:id  (event stream, events.ts)
//   GET  /api/events              (availability events, events.ts)
//   GET  /api/ping           (signed out)
//
// The two reads of what can be played where (candidates.ts) are signed in
// only: working them out for every visitor would cost too much. For the same
// reason each renter has a budget of them (budget.ts), past which they get 429.
// Booking a machine the renter picked from that list that has been taken since
// answers 409 with the next best from the same ranking, which spends from the
// same budget: past it, the 409 names none.
//
// The host authenticates with `Authorization: Bearer <machine key>`, the same
// key it registers its room with (access.ts). The renter authenticates with the
// sign-in session cookie set after Steam sign-in (signin.ts), and sees and
// claims only their own bookings. Claiming mints the join ticket the way
// `npm run ticket` does, tied to the session so that ending it revokes the ticket.
// The renter's page reports stream quality, and says it is leaving, with that
// ticket as its bearer.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Control, PicturePref } from "@swiff/rank";
import { mintTicket, verifyMachineKey, verifyTicket, type Access, type RenterSession } from "./access.js";
import { RequestBudget } from "./budget.js";
import { availabilityFor, machinesFor, type MachineCandidate, type RenterAsk } from "./candidates.js";
import { popularGames } from "./catalog.js";
import type { RenterEvents } from "./events.js";
import { MAX_MINUTES, type Platform, type Rtts } from "./platform.js";
import { parseHostReport, ReportError, type HostReport } from "./profile.js";
import type { QosReport } from "./stability.js";
import { bearer, HttpError, readJson } from "./http.js";
import { clearedCookie, renterSessionOf } from "./signin.js";
import { emptyProfile, originFrom, readProfile, type ProfileReader } from "./steam.js";

/** A host report can list up to MAX_GAMES installed appids (profile.ts). */
const MAX_HOST_BODY_BYTES = 32 * 1024;
/** A QoS report is four numbers. */
const MAX_QOS_BODY_BYTES = 1024;
/** The most games one availability call may ask about: a wall's worth. */
const MAX_AVAILABILITY_APPIDS = 100;
/** The slowest round trip to the server a renter may report, in ms. */
const MAX_RENTER_RTT_MS = 10_000;
/** The most machines a booking may carry a measured round trip for: a list's worth. */
const MAX_PROBED_MACHINES = 50;
/** Machine ids are MACHINE_KEYS entries: short. */
const MAX_MACHINE_ID_LENGTH = 200;
const CONTROLS: readonly Control[] = ["kb", "mouse", "pad"];
const PICTURES: readonly PicturePref[] = ["best", "4k", "120fps"];

type Json = Record<string, unknown>;

export type ApiOptions = {
  platform: Platform;
  access: Access;
  /** Signs renters' session cookies (signin.ts). Null: nobody is signed in. */
  sessionSecret: string | null;
  /** The configured public origin sign-in uses (publicOriginFromEnv); null when there is none. */
  publicOrigin: string | null;
  /** Used when the request carries no host header. */
  fallbackOrigin: string;
  /** The games that can be booked. Defaults to Steam's most played (catalog.ts). */
  games?: () => Promise<{ id: number; name: string; image: string | null }[]>;
  /** The renter event streams. Without them GET /api/events is not served. */
  events?: RenterEvents;
  /** The signed-in renter's Steam profile. Defaults to reading it without an API key. */
  profile?: ProfileReader;
  /** Each renter's budget of availability and machine-list reads. Defaults to one for this API alone. */
  discovery?: RequestBudget;
};

/** Answer with a JSON body that no cache keeps. */
function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** The signed-in renter's session; 401 when the request carries no live one. */
function requireRenterSession(req: IncomingMessage, sessionSecret: string | null): RenterSession {
  const session = renterSessionOf(req, sessionSecret);
  if (!session) throw new HttpError(401, "sign in with Steam first");
  return session;
}

/** The signed-in renter's Steam id; 401 when the request carries no live session. */
function requireRenter(req: IncomingMessage, sessionSecret: string | null): string {
  return requireRenterSession(req, sessionSecret).steamId;
}

/** 401 unless the request carries this machine's own key. */
function requireMachine(req: IncomingMessage, access: Access, machineId: string): void {
  if (!verifyMachineKey(access.machines, machineId, bearer(req))) throw new HttpError(401, "bad machine key");
}

/** The host report in a Host API body, or a 400 naming the bad field. */
function hostReport(body: Json): HostReport {
  try {
    return parseHostReport(body);
  } catch (error) {
    if (error instanceof ReportError) throw new HttpError(400, error.message);
    throw error;
  }
}

/** An ISO date or unix ms, as whole unix ms: the database keeps times to the ms. */
const optionalTime = (value: unknown, field: string): number | undefined => {
  if (value === undefined || value === null) return undefined;
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new HttpError(400, `${field} must be a date`);
  return Math.round(ms);
};

/** A whole number from 1 to `max`, or a 400 naming the field. */
function positiveInt(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) {
    throw new HttpError(400, `${field} must be a whole number from 1 to ${max}`);
  }
  return value as number;
}

const positiveIntOrZero = (value: unknown, field: string) => (value === 0 ? 0 : positiveInt(value, field));

/** A finite number from 0 to `max`, or a 400 naming the field. */
function boundedNumber(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    throw new HttpError(400, `${field} must be a number from 0 to ${max}`);
  }
  return value;
}

/** The renter's stream-quality report, each number within what a real stream can show. */
function qosReport(body: Json): QosReport {
  return {
    fps: boundedNumber(body.fps, "fps", 1000),
    bitrate: boundedNumber(body.bitrate, "bitrate", 1e10),
    rttMs: boundedNumber(body.rttMs, "rttMs", 60_000),
    packetLoss: boundedNumber(body.packetLoss, "packetLoss", 1),
  };
}

/**
 * The join ticket in `Authorization: Bearer …`, verified at the current time as
 * it is at join: 401 when missing, forged or expired.
 */
function requireTicket(req: IncomingMessage, access: Access) {
  const ticket = access.secret ? verifyTicket(access.secret, bearer(req)) : null;
  if (!ticket) throw new HttpError(401, "bad ticket");
  return ticket;
}

/** The HTTP answer for a renter call the platform refused. */
function renterRefusal(result: "not-found" | "wrong-ticket" | "over"): HttpError {
  if (result === "not-found") return new HttpError(404, "no such session");
  if (result === "wrong-ticket") return new HttpError(403, "the ticket is not for this session");
  return new HttpError(409, "the session is over");
}

/** An optional machine id from a body, or a 400. */
function optionalMachineId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value || value.length > MAX_MACHINE_ID_LENGTH) {
    throw new HttpError(400, "machineId must be a machine id");
  }
  return value;
}

/**
 * The renter's round trips in a booking body, each from 0 to MAX_RENTER_RTT_MS
 * ms: `server`, to this server, and `machines`, straight to each machine
 * probed, by id. Either may be left out, as may the whole.
 */
function bookingRtts(value: unknown): Rtts {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "rtts must be an object");
  const { server, machines } = value as Json;
  const rtts: Rtts = {};
  if (server !== undefined) rtts.server = boundedNumber(server, "rtts.server", MAX_RENTER_RTT_MS);
  if (machines !== undefined) {
    if (typeof machines !== "object" || machines === null || Array.isArray(machines)) {
      throw new HttpError(400, "rtts.machines must be an object");
    }
    const entries = Object.entries(machines as Json);
    if (entries.length > MAX_PROBED_MACHINES) {
      throw new HttpError(400, `rtts.machines must list at most ${MAX_PROBED_MACHINES} machines`);
    }
    rtts.machines = Object.fromEntries(
      entries.map(([id, rtt]) => [id, boundedNumber(rtt, `rtts.machines[${id}]`, MAX_RENTER_RTT_MS)]),
    );
  }
  return rtts;
}

/**
 * How the renter plays, as rank() takes it: the controls they turned on, each
 * one of CONTROLS, and their Picture setting, one of PICTURES (default best).
 * A 400 for anything else.
 */
function renterPrefs(controls: unknown[], picture: unknown): Pick<RenterAsk, "controls" | "picture"> {
  if (!controls.every((c) => CONTROLS.includes(c as Control))) {
    throw new HttpError(400, `controls must be a list of ${CONTROLS.join(", ")}`);
  }
  if (!PICTURES.includes(picture as PicturePref)) {
    throw new HttpError(400, `picture must be one of ${PICTURES.join(", ")}`);
  }
  return { controls: [...new Set(controls as Control[])], picture: picture as PicturePref };
}

/** The controls and Picture setting in a booking body, as the machines read takes them; either may be left out. */
function bookingPrefs(body: Json): Pick<RenterAsk, "controls" | "picture"> {
  const controls = body.controls ?? [];
  if (!Array.isArray(controls)) throw new HttpError(400, `controls must be a list of ${CONTROLS.join(", ")}`);
  return renterPrefs(controls, body.picture ?? "best");
}

/** A whole number from 1 to `max` in a path or query, or a 400 naming the field. */
const wholeParam = (value: string | null, field: string, max: number) =>
  positiveInt(value !== null && /^\d+$/.test(value) ? Number(value) : NaN, field, max);

/** The highest Steam appid. */
const MAX_APPID = 2 ** 31 - 1;

/** The request's query string. */
const queryOf = (req: IncomingMessage) => new URL(req.url ?? "/", "http://localhost").searchParams;

/**
 * Who is asking and how, from the query: the renter's round trip to the
 * server (`rtt`, ms, as the page measured it; required), the controls
 * they play with (`controls`, comma-separated) and their Picture setting
 * (`picture`, default best).
 */
function renterAsk(steamId: string, query: URLSearchParams): RenterAsk {
  const rtt = query.get("rtt");
  const rttMs = Number(rtt);
  if (rtt === null || rtt.trim() === "" || !(rttMs >= 0 && rttMs <= MAX_RENTER_RTT_MS)) {
    throw new HttpError(400, `rtt must be a number from 0 to ${MAX_RENTER_RTT_MS}`);
  }
  const controls = (query.get("controls") ?? "").split(",").filter(Boolean);
  return { steamId, rttMs, ...renterPrefs(controls, query.get("picture") ?? "best") };
}

const defaultGames = async () =>
  (await popularGames()).map((g) => ({ id: g.appid, name: g.name, image: g.art.capsule ?? g.art.hero }));

/**
 * Serve any request under /api/ (an unknown route is a 404 JSON answer, not
 * the web app); false for every other path. Never throws: a bad request is
 * answered. Mount it after the catalog, which owns /api/games/popular and
 * /api/games/media.
 */
export function createApi({
  platform,
  access,
  sessionSecret,
  publicOrigin,
  fallbackOrigin,
  games = defaultGames,
  profile = (steamId) => readProfile(undefined, steamId),
  events,
  discovery = new RequestBudget(),
}: ApiOptions) {
  /** The signed-in renter, once they are within their budget of discovery reads; 429 past it. */
  function requireDiscovery(req: IncomingMessage, res: ServerResponse): string | null {
    const steamId = requireRenter(req, sessionSecret);
    const waitMs = discovery.take(steamId);
    if (waitMs === 0) return steamId;
    res.writeHead(429, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "retry-after": String(Math.ceil(waitMs / 1000)),
    });
    res.end(JSON.stringify({ error: "too many requests" }));
    return null;
  }

  /** Serve one /api/ request; a bad one throws HttpError for serveApi to answer. */
  async function route(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const method = req.method ?? "GET";
    if (!path.startsWith("/api/")) return false;
    let parts: string[];
    try {
      parts = path.split("/").slice(1).map(decodeURIComponent); // "/api/a/b" -> ["api", "a", "b"]
    } catch {
      throw new HttpError(400, "bad path");
    }
    const [, resource, id, action, extra] = parts;
    if (extra !== undefined) throw new HttpError(404, "no such route");

    // --- Booking API ---------------------------------------------------------

    // The page times this to measure its round trip to the server, which the
    // reads below take as `rtt`; it answers before anything else is done.
    if (resource === "ping" && !id && method === "GET") {
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return true;
    }

    if (resource === "games" && !id && method === "GET") {
      reply(res, 200, await games().catch(() => []));
      return true;
    }

    if (resource === "availability" && !id && method === "GET") {
      const steamId = requireDiscovery(req, res);
      if (!steamId) return true;
      const query = queryOf(req);
      const appids = [...new Set((query.get("appids") ?? "").split(",").filter(Boolean))];
      if (!appids.length || appids.length > MAX_AVAILABILITY_APPIDS) {
        throw new HttpError(400, `appids must list 1 to ${MAX_AVAILABILITY_APPIDS} Steam appids`);
      }
      // Repeats are answered once, however they are spelled ("730" and "0730").
      const parsed = new Set(appids.map((a) => wholeParam(a, "appids[]", MAX_APPID)));
      const games = await platform.requirements([...parsed]);
      const ask = renterAsk(steamId, query);
      // Optional: how long the renter means to play, for `ready` and `best`. It never changes `free`.
      const minutes = query.has("minutes") ? wholeParam(query.get("minutes"), "minutes", MAX_MINUTES) : 0;
      const { at, machines } = await platform.offeredMachines();
      reply(res, 200, availabilityFor(games, ask, machines, at, minutes));
      return true;
    }

    if (resource === "games" && id && action === "machines" && method === "GET") {
      const steamId = requireDiscovery(req, res);
      if (!steamId) return true;
      const query = queryOf(req);
      const appid = wholeParam(id, "appid", MAX_APPID);
      const minutes = wholeParam(query.get("minutes"), "minutes", MAX_MINUTES);
      const ask = renterAsk(steamId, query);
      const [game] = await platform.requirements([appid]);
      const { at, machines } = await platform.offeredMachines();
      reply(res, 200, machinesFor(game!, minutes, ask, machines, at));
      return true;
    }

    if (resource === "events" && !id && method === "GET" && events) {
      const session = requireRenterSession(req, sessionSecret);
      const bookingId = queryOf(req).get("booking");
      // The stream ends when the session does, as any other call would be refused then.
      const until = session.exp * 1000;
      if (bookingId === null) {
        // No booking: the wall's stream, which only says that availability changed.
        if (events.openAvailability(res, session.steamId, until) === "too-many") {
          throw new HttpError(429, "too many open event streams");
        }
        return true;
      }
      if (!bookingId) throw new HttpError(400, "booking is required");
      // Somebody else's booking reads exactly like one that does not exist.
      const opened = await events.open(res, bookingId, session.steamId, until);
      if (opened === "not-found") throw new HttpError(404, "no such booking");
      if (opened === "too-many") throw new HttpError(429, "too many open event streams");
      return true; // opened, or nobody left to answer
    }

    if (resource === "me" && !id && method === "GET") {
      const steamId = requireRenter(req, sessionSecret);
      // A Steam outage must not read as signed out: the session stands.
      reply(res, 200, { steamId, profile: await profile(steamId).catch(() => emptyProfile(steamId)) });
      return true;
    }

    // The wall's retry after a renter makes their library public: read it from
    // Steam again rather than serving the copy remembered from before.
    if (resource === "me" && id === "refresh" && !action && method === "POST") {
      const steamId = requireRenter(req, sessionSecret);
      const fresh = await profile(steamId, { fresh: true }).catch(() => emptyProfile(steamId));
      reply(res, 200, { steamId, profile: fresh });
      return true;
    }

    if (resource === "signout" && !id && method === "POST") {
      // Stateless: clearing the browser's cookie is the whole of signing out.
      res.writeHead(204, {
        "set-cookie": clearedCookie(publicOrigin ?? fallbackOrigin),
        "cache-control": "no-store",
      });
      res.end();
      return true;
    }

    if (resource === "bookings" && !id && method === "POST") {
      const renter = requireRenter(req, sessionSecret);
      const body = await readJson(req);
      const gameId = positiveInt(body.gameId, "gameId", MAX_APPID);
      const minutes = positiveInt(body.minutes, "minutes", MAX_MINUTES);
      const machineId = optionalMachineId(body.machineId);
      const rtts = bookingRtts(body.rtts);
      const prefs = bookingPrefs(body);
      if (machineId === undefined) {
        reply(res, 202, await platform.book(gameId, minutes, renter, rtts));
        return true;
      }
      const booking = await platform.bookMachine(machineId, gameId, minutes, renter, rtts);
      if (booking) {
        reply(res, 202, booking);
        return true;
      }
      // Taken since the renter's list was read: the next best from the list as
      // it stands now, free for the whole booking, so the page can offer it.
      let nextBest: MachineCandidate | null = null;
      if (discovery.take(renter) === 0) {
        const ask: RenterAsk = { steamId: renter, rttMs: rtts.server ?? 0, ...prefs };
        const [game] = await platform.requirements([gameId]);
        const { at, machines } = await platform.offeredMachines();
        nextBest =
          machinesFor(game!, minutes, ask, machines, at).machines.find(
            (m) => m.id !== machineId && m.coversSession,
          ) ?? null;
      }
      reply(res, 409, { error: "the machine is taken", nextBest });
      return true;
    }

    if (resource === "bookings" && id && !action && method === "GET") {
      // Somebody else's booking reads exactly like one that does not exist.
      const booking = await platform.booking(id, requireRenter(req, sessionSecret));
      if (!booking) throw new HttpError(404, "no such booking");
      reply(res, 200, booking);
      return true;
    }

    if (resource === "bookings" && id && action === "seen" && method === "POST") {
      // The renter's page is still there: counts as checking on the booking.
      if (!(await platform.booking(id, requireRenter(req, sessionSecret))))
        throw new HttpError(404, "no such booking");
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return true;
    }

    if (resource === "bookings" && id && action === "claim" && method === "POST") {
      const renter = requireRenter(req, sessionSecret);
      // Checked before the reservation is spent: a claim that cannot hand out
      // a ticket must not use up the renter's machine.
      if (!access.secret) throw new HttpError(503, "tickets cannot be minted: ROOM_SECRET is not set");
      const claim = await platform.claim(id, renter);
      if (!claim.ok) {
        if (claim.reason === "not-found") throw new HttpError(404, "no such booking");
        reply(res, 409, { error: "the booking cannot be claimed", status: claim.status });
        return true;
      }
      const ticket = mintTicket(access.secret, claim.roomId, claim.minutes * 60);
      await platform.recordTicket(claim.sessionId, verifyTicket(access.secret, ticket)!.id);
      const origin = originFrom(req.headers, fallbackOrigin);
      reply(res, 200, {
        sessionId: claim.sessionId,
        roomId: claim.roomId,
        signalingUrl: origin.replace(/^http/, "ws"),
        ticket,
      });
      return true;
    }

    if (resource === "bookings" && id && action === "end" && method === "POST") {
      // The renter ends it, whatever it has come to: out of the queue, the
      // machine handed back, or the session over (as renter).
      const ended = await platform.endBooking(id, requireRenter(req, sessionSecret));
      if (!ended.ok) {
        if (ended.reason === "not-found") throw new HttpError(404, "no such booking");
        reply(res, 409, { error: "the booking is already over", status: ended.status });
        return true;
      }
      reply(res, 200, ended.booking);
      return true;
    }

    // --- Host API ------------------------------------------------------------

    if (resource === "machines" && id && action === "availability" && method === "PUT") {
      requireMachine(req, access, id);
      const body = await readJson(req, MAX_HOST_BODY_BYTES);
      if (typeof body.available !== "boolean") throw new HttpError(400, "available must be true or false");
      const price = body.price === undefined ? undefined : positiveIntOrZero(body.price, "price");
      const machine = await platform.setAvailability(id, body.available, {
        ...hostReport(body),
        price,
        availableUntil: optionalTime(body.until, "until"),
      });
      reply(res, 200, machine);
      return true;
    }

    if (resource === "machines" && id && action === "heartbeat" && method === "POST") {
      requireMachine(req, access, id);
      const body = await readJson(req, MAX_HOST_BODY_BYTES);
      reply(res, 200, await platform.heartbeat(id, hostReport(body)));
      return true;
    }

    if (resource === "sessions" && id && (action === "start" || action === "end") && method === "POST") {
      const machineId = await platform.sessionMachine(id);
      if (!machineId) throw new HttpError(404, "no such session");
      requireMachine(req, access, machineId);
      const body = await readJson(req);
      const ok =
        action === "start"
          ? await platform.startSession(machineId, id)
          : await platform.endSession(machineId, id, optionalTime(body.endedAt, "endedAt"));
      if (!ok) throw new HttpError(409, "the session is already over");
      reply(res, 200, { sessionId: id, roomId: machineId });
      return true;
    }

    // --- Renter session calls (join ticket) ------------------------------------

    if (resource === "sessions" && id && action === "qos" && method === "POST") {
      // A last report after the session ends is taken while the ticket is still
      // valid, for at most QOS_GRACE_MS (platform.ts).
      const ticket = requireTicket(req, access);
      const report = qosReport(await readJson(req, MAX_QOS_BODY_BYTES));
      const result = await platform.recordQos(id, ticket.id, report);
      if (result !== "ok") throw renterRefusal(result);
      reply(res, 200, { sessionId: id });
      return true;
    }

    if (resource === "sessions" && id && action === "leave" && method === "POST") {
      const result = await platform.leaveSession(id, requireTicket(req, access).id);
      if (result !== "ok") throw renterRefusal(result);
      reply(res, 200, { sessionId: id });
      return true;
    }

    throw new HttpError(404, "no such route");
  }

  return async function serveApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    try {
      return await route(req, res, path);
    } catch (error) {
      if (error instanceof HttpError) reply(res, error.status, { error: error.message });
      else {
        // The message may carry request data; only the kind of failure is logged.
        console.error("[swiff] api error:", error instanceof Error ? error.name : typeof error);
        reply(res, 500, { error: "internal error" });
      }
      return true;
    }
  };
}
