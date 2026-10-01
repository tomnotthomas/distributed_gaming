// The platform's HTTP API, over the state in platform.ts.
//
//   Booking API (renter)                   Host API (gaming PC, machine key)
//   GET  /api/games                        PUT  /api/machines/:id/availability
//   POST /api/bookings                     POST /api/machines/:id/heartbeat
//   GET  /api/bookings/:id                 POST /api/sessions/:id/start
//   POST /api/bookings/:id/claim           POST /api/sessions/:id/end
//
// The host authenticates with `Authorization: Bearer <machine key>`, the same
// key it registers its room with (access.ts). A renter holds nothing but the
// booking id, which is unguessable. Claiming mints the join ticket the way
// `npm run ticket` does, tied to the session so that ending it revokes the ticket.

import type { IncomingMessage, ServerResponse } from "node:http";
import { mintTicket, verifyMachineKey, verifyTicket, type Access } from "./access.js";
import { popularGames } from "./catalog.js";
import { MAX_MINUTES, type Platform } from "./platform.js";
import { parseHostReport, ReportError, type HostReport } from "./profile.js";
import { originFrom } from "./steam.js";

/** Every renter body here is a handful of fields. */
const MAX_BODY_BYTES = 16 * 1024;
/** A host report can list up to MAX_GAMES installed appids (profile.ts). */
const MAX_HOST_BODY_BYTES = 32 * 1024;

type Json = Record<string, unknown>;

export type ApiOptions = {
  platform: Platform;
  access: Access;
  /** Used when the request carries no host header. */
  fallbackOrigin: string;
  /** The games that can be booked. Defaults to Steam's most played (catalog.ts). */
  games?: () => Promise<{ id: number; name: string; image: string | null }[]>;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Answer with a JSON body that no cache keeps. */
function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** The body as a JSON object; empty is {}. 413 when over `limit` bytes, 400 when not an object. */
async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new HttpError(400, "body is not an object");
  return body as Json;
}

/** The machine key from `Authorization: Bearer …`, if there is one. */
function bearer(req: IncomingMessage): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  return match?.[1] ?? null;
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

const defaultGames = async () =>
  (await popularGames()).map((g) => ({ id: g.appid, name: g.name, image: g.art.capsule ?? g.art.hero }));

/**
 * Serve any request under /api/ (an unknown route is a 404 JSON answer, not
 * the web app); false for every other path. Never throws: a bad request is
 * answered. Mount it after the catalog, which owns /api/games/popular and
 * /api/games/media.
 */
export function createApi({ platform, access, fallbackOrigin, games = defaultGames }: ApiOptions) {
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

    if (resource === "bookings" && !id && method === "POST") {
      const body = await readJson(req);
      const booking = platform.book(
        positiveInt(body.gameId, "gameId"),
        positiveInt(body.minutes, "minutes", MAX_MINUTES),
      );
      reply(res, 202, booking);
      return true;
    }

    if (resource === "bookings" && id && !action && method === "GET") {
      const booking = platform.booking(id);
      if (!booking) throw new HttpError(404, "no such booking");
      reply(res, 200, booking);
      return true;
    }

    if (resource === "bookings" && id && action === "claim" && method === "POST") {
      // Checked before the reservation is spent: a claim that cannot hand out
      // a ticket must not use up the renter's machine.
      if (!access.secret) throw new HttpError(503, "tickets cannot be minted: ROOM_SECRET is not set");
      const claim = platform.claim(id);
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
