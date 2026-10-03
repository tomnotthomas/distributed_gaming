// The platform's HTTP API, over the state in platform.ts.
//
//   Booking API (renter, signed in)        Host API (gaming PC, machine key)
//   GET  /api/games          (signed out)  PUT  /api/machines/:id/availability
//   GET  /api/availability?appids=         POST /api/machines/:id/heartbeat
//   GET  /api/games/:appid/machines?minutes=  POST /api/machines/:id/upload-test
//   GET  /api/me
//   POST /api/me/refresh
//   POST /api/signout        (signed out)  POST /api/sessions/:id/start
//   POST /api/bookings                     POST /api/sessions/:id/end
//   GET  /api/bookings/:id
//   POST /api/bookings/:id/claim
//   POST /api/bookings/:id/seen
//   POST /api/sessions/:id/qos   (ticket)
//   POST /api/sessions/:id/leave (ticket)
//   GET  /api/events?booking=:id  (event stream, events.ts)
//
// The two reads of what can be played where (candidates.ts) are signed in
// only: working them out for every visitor would cost too much. For the same
// reason each renter has a budget of them (budget.ts), past which they get 429.
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
import { availabilityFor, machinesFor, type RenterAsk } from "./candidates.js";
import { popularGames } from "./catalog.js";
import type { RenterEvents } from "./events.js";
import { MAX_MINUTES, type Platform } from "./platform.js";
import { parseHostReport, ReportError, type HostReport } from "./profile.js";
import type { QosReport } from "./stability.js";
import { bearer, discardBody, HttpError, readJson } from "./http.js";
import { clearedCookie, renterSessionOf } from "./signin.js";
import { emptyProfile, originFrom, readProfile, type ProfileReader } from "./steam.js";

/** A host report can list up to MAX_GAMES installed appids (profile.ts). */
const MAX_HOST_BODY_BYTES = 32 * 1024;
/** The most an upload test may send: the host app sends 4 MB (desktop/src/report.ts). */
const MAX_UPLOAD_TEST_BYTES = 8 * 1024 * 1024;
/** A QoS report is four numbers. */
const MAX_QOS_BODY_BYTES = 1024;
/** The most games one availability call may ask about: a wall's worth. */
const MAX_AVAILABILITY_APPIDS = 100;
/** The slowest round trip to the server a renter may report, in ms. */
const MAX_RENTER_RTT_MS = 10_000;
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

/** An ISO date or unix ms, as unix ms. */
const optionalTime = (value: unknown, field: string): number | undefined => {
  if (value === undefined || value === null) return undefined;
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new HttpError(400, `${field} must be a date`);
  return ms;
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
  if (!controls.every((c) => CONTROLS.includes(c as Control))) {
    throw new HttpError(400, `controls must be a list of ${CONTROLS.join(", ")}`);
  }
  const picture = query.get("picture") ?? "best";
  if (!PICTURES.includes(picture as PicturePref)) {
    throw new HttpError(400, `picture must be one of ${PICTURES.join(", ")}`);
  }
  return { steamId, rttMs, controls: [...new Set(controls as Control[])], picture: picture as PicturePref };
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
      const games = [...parsed].map((appid) => platform.requirements(appid));
      const ask = renterAsk(steamId, query);
      const { at, machines } = platform.offeredMachines();
      reply(res, 200, availabilityFor(games, ask, machines, at));
      return true;
    }

    if (resource === "games" && id && action === "machines" && method === "GET") {
      const steamId = requireDiscovery(req, res);
      if (!steamId) return true;
      const query = queryOf(req);
      const game = platform.requirements(wholeParam(id, "appid", MAX_APPID));
      const minutes = wholeParam(query.get("minutes"), "minutes", MAX_MINUTES);
      const ask = renterAsk(steamId, query);
      const { at, machines } = platform.offeredMachines();
      reply(res, 200, machinesFor(game, minutes, ask, machines, at));
      return true;
    }

    if (resource === "events" && !id && method === "GET" && events) {
      const session = requireRenterSession(req, sessionSecret);
      const bookingId = queryOf(req).get("booking");
      if (!bookingId) throw new HttpError(400, "booking is required");
      // Somebody else's booking reads exactly like one that does not exist.
      // The stream ends when the session does, as any other call would be refused then.
      const opened = events.open(res, bookingId, session.steamId, session.exp * 1000);
      if (opened === "not-found") throw new HttpError(404, "no such booking");
      if (opened === "too-many") throw new HttpError(429, "too many open event streams");
      return true;
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
      const booking = platform.book(
        positiveInt(body.gameId, "gameId"),
        positiveInt(body.minutes, "minutes", MAX_MINUTES),
        renter,
      );
      reply(res, 202, booking);
      return true;
    }

    if (resource === "bookings" && id && !action && method === "GET") {
      // Somebody else's booking reads exactly like one that does not exist.
      const booking = platform.booking(id, requireRenter(req, sessionSecret));
      if (!booking) throw new HttpError(404, "no such booking");
      reply(res, 200, booking);
      return true;
    }

    if (resource === "bookings" && id && action === "seen" && method === "POST") {
      // The renter's page is still there: counts as checking on the booking.
      if (!platform.booking(id, requireRenter(req, sessionSecret)))
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
      const claim = platform.claim(id, renter);
      if (!claim.ok) {
        if (claim.reason === "not-found") throw new HttpError(404, "no such booking");
        reply(res, 409, { error: "the booking cannot be claimed", status: claim.status });
        return true;
      }
      const ticket = mintTicket(access.secret, claim.roomId, claim.minutes * 60);
      platform.recordTicket(claim.sessionId, verifyTicket(access.secret, ticket)!.id);
      const origin = originFrom(req.headers, fallbackOrigin);
      reply(res, 200, {
        sessionId: claim.sessionId,
        roomId: claim.roomId,
        signalingUrl: origin.replace(/^http/, "ws"),
        ticket,
      });
      return true;
    }

    // --- Host API ------------------------------------------------------------

    if (resource === "machines" && id && action === "availability" && method === "PUT") {
      requireMachine(req, access, id);
      const body = await readJson(req, MAX_HOST_BODY_BYTES);
      if (typeof body.available !== "boolean") throw new HttpError(400, "available must be true or false");
      const price = body.price === undefined ? undefined : positiveIntOrZero(body.price, "price");
      const machine = platform.setAvailability(id, body.available, {
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
      reply(res, 200, platform.heartbeat(id, hostReport(body)));
      return true;
    }

    if (resource === "machines" && id && action === "upload-test" && method === "POST") {
      // The PC times this to report its upload speed (net.upMbps). Nothing is kept.
      requireMachine(req, access, id);
      await discardBody(req, MAX_UPLOAD_TEST_BYTES);
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return true;
    }

    if (resource === "sessions" && id && (action === "start" || action === "end") && method === "POST") {
      const machineId = platform.sessionMachine(id);
      if (!machineId) throw new HttpError(404, "no such session");
      requireMachine(req, access, machineId);
      const body = await readJson(req);
      const ok =
        action === "start"
          ? platform.startSession(machineId, id)
          : platform.endSession(machineId, id, optionalTime(body.endedAt, "endedAt"));
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
      const result = platform.recordQos(id, ticket.id, report);
      if (result !== "ok") throw renterRefusal(result);
      reply(res, 200, { sessionId: id });
      return true;
    }

    if (resource === "sessions" && id && action === "leave" && method === "POST") {
      const result = platform.leaveSession(id, requireTicket(req, access).id);
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
