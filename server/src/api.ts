// The platform's HTTP API, over the state in platform.ts.
//
//   Booking API (renter, signed in)        Host API (gaming PC, machine key)
//   GET  /api/games          (signed out)  PUT  /api/machines/:id/availability
//   GET  /api/me                           POST /api/machines/:id/heartbeat
//   POST /api/signout        (signed out)  POST /api/sessions/:id/start
//   POST /api/bookings                     POST /api/sessions/:id/end
//   GET  /api/bookings/:id
//   POST /api/bookings/:id/claim
//   POST /api/sessions/:id/qos   (ticket)
//   POST /api/sessions/:id/leave (ticket)
//
// The host authenticates with `Authorization: Bearer <machine key>`, the same
// key it registers its room with (access.ts). The renter authenticates with the
// sign-in session cookie set after Steam sign-in (signin.ts), and sees and
// claims only their own bookings. Claiming mints the join ticket the way
// `npm run ticket` does, tied to the session so that ending it revokes the ticket.
// The renter's page reports stream quality, and says it is leaving, with that
// ticket as its bearer.

import type { IncomingMessage, ServerResponse } from "node:http";
import { mintTicket, verifyMachineKey, verifyTicket, type Access } from "./access.js";
import { popularGames } from "./catalog.js";
import { MAX_MINUTES, type Platform } from "./platform.js";
import { parseHostReport, ReportError, type HostReport } from "./profile.js";
import type { QosReport } from "./stability.js";
import { bearer, HttpError, readJson } from "./http.js";
import { clearedCookie, renterOf } from "./signin.js";
import { emptyProfile, originFrom, readProfile, type SteamProfile } from "./steam.js";

/** A host report can list up to MAX_GAMES installed appids (profile.ts). */
const MAX_HOST_BODY_BYTES = 32 * 1024;
/** A QoS report is four numbers. */
const MAX_QOS_BODY_BYTES = 1024;

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
  /** The signed-in renter's Steam profile. Defaults to reading it without an API key. */
  profile?: (steamId: string) => Promise<SteamProfile>;
};

/** Answer with a JSON body that no cache keeps. */
function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** The signed-in renter's Steam id; 401 when the request carries no live session. */
function requireRenter(req: IncomingMessage, sessionSecret: string | null): string {
  const renter = renterOf(req, sessionSecret);
  if (!renter) throw new HttpError(401, "sign in with Steam first");
  return renter;
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
}: ApiOptions) {
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

    if (resource === "me" && !id && method === "GET") {
      const steamId = requireRenter(req, sessionSecret);
      // A Steam outage must not read as signed out: the session stands.
      reply(res, 200, { steamId, profile: await profile(steamId).catch(() => emptyProfile(steamId)) });
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
