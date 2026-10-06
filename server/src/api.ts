// The platform's HTTP API, over the state in platform.ts.
//
//   Booking API (renter, signed in)        Host API (gaming PC)
//   GET  /api/games          (signed out)  PUT  /api/machines/:id/availability  control
//   GET  /api/availability?appids=         POST /api/machines/:id/heartbeat     either
//   GET  /api/games/:appid/machines?minutes=  GET  /api/machines/:id/demand     control
//   GET  /api/me                           POST /api/machines/:id/attest-challenge
//   POST /api/me/refresh                   POST /api/machines/:id/attest-activation
//   POST /api/signout        (signed out)  POST /api/machines/:id/attest  (attestation)
//   POST /api/bookings                     PUT  /api/machines/:id/ek            control
//   GET  /api/me/invite                    (crews: invite links)
//   POST /api/me/invite/renew
//   GET  /api/invites/:token (signed out)
//   POST /api/invites/:token/join
//                                          POST /api/machines/:id/state-key  attested boot
//                                          PUT  /api/machines/:id/state-key  attested boot
//   GET  /api/bookings/:id                 POST /api/sessions/:id/start        hosting
//                                          POST /api/sessions/:id/end          either
//                                          POST /api/machines/:id/upload-test   control
//   POST /api/bookings/:id/claim
//   POST /api/bookings/:id/rejoin
//   POST /api/bookings/:id/seen
//   POST /api/bookings/:id/end
//   POST /api/bookings/:id/continue
//   POST /api/sessions/:id/start (ticket)
//   POST /api/sessions/:id/qos   (ticket)
//   POST /api/sessions/:id/leave (ticket)
//   GET  /api/events?booking=:id[&to=end]  (event stream, events.ts)
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
// The host authenticates with `Authorization: Bearer <credential>`, the same
// one it registers its room with: its machine key (control) or a host
// certificate from attestation (hosting). A hosting call with the machine key
// is refused 403 while hosting requires attestation (attestation.ts); the
// attestation calls need no credential but the evidence itself. The owner's
// host app reads what renters ask for from the demand route, from its own
// origin: it answers any origin, as the session routes do (index.ts), since the
// machine key in the Authorization header is its only credential. The renter authenticates with the
// sign-in session cookie set after Steam sign-in (signin.ts), and sees and
// claims only their own bookings. Claiming mints the join ticket the way
// `npm run ticket` does, tied to the session so that ending it revokes the ticket.
// The page never stores that ticket; a renter coming back to their running
// session gets it again from `rejoin`, with the same id, so joining with it
// takes their seat back and ending the session still revokes every copy.
// A renter books and claims only games in their own Steam library or free to
// play (licence.ts); anything else answers 403 with a `code` the page explains.
// Every list of games a renter is sent, their library included, holds only
// games Swiff can run (playable.ts), and booking any other answers 403
// not-playable.
// The renter's page starts the session on its first frame, reports stream
// quality, and says it is leaving, with that ticket as its bearer. Starting it
// is what tells the PC to launch the game. A renter who dropped has the
// reconnect grace the PC holds the session for (grace.ts) to rejoin; reading a
// running booking says until when that grace holds it. A session whose machine
// was lost instead (it went offline, or its owner took it back) says so in its
// booking's endReason, and continue carries it on elsewhere: a new booking for
// the time left, matched to the best other machine at once or queued, which the
// page claims as it claims any, for a game the renter may still play.
//
// Every signed-in player has a personal invite link to their own crew
// (platform.ts, crews), signed with the session secret (access.ts) so the id
// the database holds opens nothing. Anyone may read whose crew a link is to,
// so the friend who opens it sees who asked; joining takes signing in. The
// link is never logged, and a forged one is refused before the database is.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Control, PicturePref } from "@swiff/rank";
import {
  inviteToken,
  mintTicket,
  verifyInviteToken,
  verifyMachineKey,
  verifyTicket,
  type Access,
  type RenterSession,
} from "./access.js";
import { createAttestation, looksLikeHostCert, type Attestation, type Credential } from "./attestation.js";
import { RequestBudget } from "./budget.js";
import { availabilityFor, machinesFor, type MachineCandidate, type RenterAsk } from "./candidates.js";
import { popularGames } from "./catalog.js";
import { everyGamePlayable, type PlayableGames } from "./playable.js";
import type { RenterEvents } from "./events.js";
import { storeFreeToPlay, unlicensed, type FreeToPlay } from "./licence.js";
import { MAX_MINUTES, type Platform, type Rtts } from "./platform.js";
import { parseHostReport, ReportError, type HostReport } from "./profile.js";
import type { QosReport } from "./stability.js";
import { bearer, discardBody, HttpError, readJson } from "./http.js";
import { createStateKeys, memoryStateKeyStore, type StateKeys } from "./state-key.js";
import { clearedCookie, renterSessionOf } from "./signin.js";
import {
  emptyProfile,
  LIBRARY_CAP,
  originFrom,
  pageProfile,
  readProfile,
  type LibraryEntry,
  type ProfileReader,
  type SteamProfile,
} from "./steam.js";

/** A host report can list up to MAX_GAMES installed appids (profile.ts). */
const MAX_HOST_BODY_BYTES = 32 * 1024;
/** A TPM quote, its event log and the EK certificate chain: tens of KB. */
const MAX_ATTEST_BODY_BYTES = 256 * 1024;
/** The most an upload test may send: the host app sends 4 MB (desktop/src/report.ts). */
const MAX_UPLOAD_TEST_BYTES = 8 * 1024 * 1024;
/** A QoS report is four numbers. */
const MAX_QOS_BODY_BYTES = 1024;
/** Demand counts the bookings made in this window, and the queue now. */
export const DEMAND_WINDOW_MS = 60 * 60_000;
/** The most games the demand route names. */
export const DEMAND_LIMIT = 24;
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
  /** The games that can be booked, before playability. Defaults to Steam's most played (catalog.ts). */
  games?: () => Promise<{ id: number; name: string; image: string | null }[]>;
  /** The renter event streams. Without them GET /api/events is not served. */
  events?: RenterEvents;
  /** The signed-in renter's Steam profile. Defaults to reading it without an API key. */
  profile?: ProfileReader;
  /** Each renter's budget of availability and machine-list reads. Defaults to one for this API alone. */
  discovery?: RequestBudget;
  /** Whether a game is free to play, so anyone may book it. Defaults to Steam's store data (licence.ts). */
  isFree?: FreeToPlay;
  /** Who may host, and how a machine attests. Defaults to the machine key hosting, with no verifier. */
  attestation?: Attestation;
  /** Rental-mode PCs' state keys (state-key.ts). Defaults to none: every call answers 503 not-configured. */
  stateKeys?: StateKeys;
  /** Which games Swiff can run (playable.ts). Defaults to every game, checking none. */
  playability?: PlayableGames;
  /** The renter's page started session `sessionId` on `machineId` with ticket `ticketId`: the PC launches `gameId`. */
  onRenterStarted?: (machineId: string, sessionId: string, gameId: number, ticketId: string) => void;
  /**
   * Until when (Unix ms) `machineId` holds its session for a renter who
   * dropped out of it (grace.ts); null while nobody has.
   */
  heldUntil?: (machineId: string) => number | null;
};

/** What a 403 for a game the renter may not play says, by its `code`. */
const UNLICENSED_MESSAGE = {
  "not-owned": "the game is not in your Steam library and is not free to play",
  "library-unreadable": "your Steam library cannot be read, so only free-to-play games can be played",
} as const;

/** What a game Swiff cannot run (playable.ts) answers, with code not-playable. */
const NOT_PLAYABLE = { error: "Swiff cannot run this game", code: "not-playable" } as const;

/** Answer with a JSON body that no cache keeps. */
function reply(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { ...headers, "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * The host app calls the Host API from its own origin (a file:// page, or the
 * dev server's); the machine key is its only credential, so any origin may ask.
 */
const HOST_CORS = { "access-control-allow-origin": "*" };
/** The Host API's machine routes: /api/machines/:id/<action>. */
const HOST_ACTIONS = new Set(["availability", "heartbeat", "upload-test", "demand", "ek"]);
const HOST_PREFLIGHT = {
  ...HOST_CORS,
  "access-control-allow-methods": "GET, PUT, POST",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "600",
};

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

/** 401 unless the request carries this machine's own key: the control credential. */
function requireMachine(req: IncomingMessage, access: Access, machineId: string): void {
  if (!verifyMachineKey(access.machines, machineId, bearer(req))) throw new HttpError(401, "bad machine key");
}

/** The machine's own key or a host certificate for it; 401 for anything else. */
function requireMachineOrHost(req: IncomingMessage, attestation: Attestation, machineId: string): Credential {
  const token = bearer(req);
  const credential = attestation.credential(machineId, token);
  if (!credential)
    throw new HttpError(401, looksLikeHostCert(token) ? "bad host certificate" : "bad machine key");
  return credential;
}

/** A credential that may host this machine; 403 for the machine key while hosting requires attestation. */
function requireHosting(req: IncomingMessage, attestation: Attestation, machineId: string): void {
  if (requireMachineOrHost(req, attestation, machineId).hosting === null) {
    throw new HttpError(403, "attestation-required");
  }
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

/** 0, or a positive whole number, or a 400 naming the field. */
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
  const ticket = ticketOf(req, access);
  if (!ticket) throw new HttpError(401, "bad ticket");
  return ticket;
}

/** The join ticket the request carries as its bearer, or null when it carries none that verifies. */
function ticketOf(req: IncomingMessage, access: Access) {
  return access.secret ? verifyTicket(access.secret, bearer(req)) : null;
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

/** Steam's most played games that `keep` lets through, as the games that can be booked. */
const popularBookable = async (keep: (appid: number) => boolean) =>
  (await popularGames(undefined, keep)).map((g) => ({
    id: g.appid,
    name: g.name,
    image: g.art.capsule ?? g.art.hero,
  }));

/**
 * The renter's profile as the page is sent it: only the games Swiff can run, of
 * theirs, the first LIBRARY_CAP of their most-played, and how many of the games
 * it could still show (`checking`) have no verdict yet.
 */
function shownProfile(read: SteamProfile, playability: Pick<PlayableGames, "playable" | "checked">) {
  const page = pageProfile(read);
  let checking = page.owned.filter(([appid]) => !playability.checked(appid)).length;
  const games: LibraryEntry[] = [];
  for (const entry of page.games) {
    if (games.length === LIBRARY_CAP) break;
    if (playability.playable(entry[0])) games.push(entry);
    else if (!playability.checked(entry[0])) checking++;
  }
  return { ...page, owned: page.owned.filter(([appid]) => playability.playable(appid)), games, checking };
}

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
  games,
  profile = (steamId) => readProfile(undefined, steamId),
  events,
  discovery = new RequestBudget(),
  isFree = storeFreeToPlay(),
  attestation = createAttestation({ access }),
  stateKeys = createStateKeys({ store: memoryStateKeyStore(), secret: null }),
  playability = everyGamePlayable,
  onRenterStarted,
  heldUntil = () => null,
}: ApiOptions) {
  const playable = (appid: number) => playability.playable(appid);
  const bookable = games ?? (() => popularBookable(playable));

  /** The page's copy of the renter's profile; the games it can show are checked ahead of background rechecks. */
  function profileReply(steamId: string, read: SteamProfile) {
    playability.want([...read.owned.map(([appid]) => appid), ...read.games.map(([appid]) => appid)], {
      first: true,
    });
    return { steamId, profile: shownProfile(read, playability) };
  }

  /**
   * Answer 403 and true when the renter may not play `gameId`: not in their
   * library and not free to play. A profile Steam fails to give reads as a
   * library that cannot be read, except at `claim`: there a renter who may own
   * the game holds a matched machine, so a 503 asks the page to try again
   * rather than have it hand the machine back over a Steam outage.
   */
  async function refuseUnlicensed(
    res: ServerResponse,
    steamId: string,
    gameId: number,
    { claim = false } = {},
  ): Promise<boolean> {
    let unread = false;
    const read = await profile(steamId).catch(() => {
      unread = true;
      return emptyProfile(steamId);
    });
    const code = await unlicensed(read, gameId, isFree);
    if (!code) return false;
    if (unread && claim) throw new HttpError(503, "Steam is not answering; try again");
    reply(res, 403, { error: UNLICENSED_MESSAGE[code], code });
    return true;
  }

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

    // The Host API answers the host app's origin, errors included, so the app
    // can read why a call was refused.
    const hostRoute =
      (resource === "machines" && id && HOST_ACTIONS.has(action ?? "")) ||
      (resource === "sessions" && id && (action === "start" || action === "end"));
    if (hostRoute) {
      for (const [name, value] of Object.entries(HOST_CORS)) res.setHeader(name, value);
      if (method === "OPTIONS") {
        res.writeHead(204, HOST_PREFLIGHT);
        res.end();
        return true;
      }
    }

    // --- Booking API ---------------------------------------------------------

    // The page times this to measure its round trip to the server, which the
    // reads below take as `rtt`; it answers before anything else is done.
    if (resource === "ping" && !id && method === "GET") {
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return true;
    }

    if (resource === "games" && !id && method === "GET") {
      const listed = await bookable().catch(() => []);
      reply(
        res,
        200,
        listed.filter((game) => playable(game.id)),
      );
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
      // A game Swiff cannot run is answered for nowhere: it has no machines to offer.
      const games = await platform.requirements([...parsed].filter(playable));
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
      if (!playable(appid)) {
        reply(res, 404, NOT_PLAYABLE);
        return true;
      }
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
      // A running session's page follows its booking on to its end (to=end), to hear its machine was lost.
      const toEnd = queryOf(req).get("to") === "end";
      const opened = await events.open(res, bookingId, session.steamId, until, toEnd);
      if (opened === "not-found") throw new HttpError(404, "no such booking");
      if (opened === "too-many") throw new HttpError(429, "too many open event streams");
      return true; // opened, or nobody left to answer
    }

    if (resource === "me" && !id && method === "GET") {
      const steamId = requireRenter(req, sessionSecret);
      // A Steam outage must not read as signed out: the session stands.
      const read = await profile(steamId).catch(() => emptyProfile(steamId));
      reply(res, 200, profileReply(steamId, read));
      return true;
    }

    // The wall's retry after a renter makes their library public: read it from
    // Steam again rather than serving the copy remembered from before.
    if (resource === "me" && id === "refresh" && !action && method === "POST") {
      const steamId = requireRenter(req, sessionSecret);
      const fresh = await profile(steamId, { fresh: true }).catch(() => emptyProfile(steamId));
      reply(res, 200, profileReply(steamId, fresh));
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

    // --- Crews ---------------------------------------------------------------

    // The signed-in player's personal invite link; `renew` replaces it, and the old one stops working.
    if (resource === "me" && id === "invite" && method === (action === "renew" ? "POST" : "GET")) {
      if (action !== undefined && action !== "renew") throw new HttpError(404, "no such route");
      const steamId = requireRenter(req, sessionSecret);
      // The crew is named after its owner's Steam persona: kept from this read, when Steam answers.
      const read = await profile(steamId).catch(() => null);
      const invite = await platform.crewInvite(steamId, read?.persona || null, { renew: action === "renew" });
      reply(res, 200, { token: inviteToken(sessionSecret!, invite.inviteId), crew: invite.crew });
      return true;
    }

    if (resource === "invites" && id && !action && method === "GET") {
      const inviteId = sessionSecret ? verifyInviteToken(sessionSecret, id) : null;
      const crew = inviteId
        ? await platform.invite(inviteId, renterSessionOf(req, sessionSecret)?.steamId)
        : null;
      if (!crew) throw new HttpError(404, "this invite link is not valid any more");
      reply(res, 200, { crew });
      return true;
    }

    if (resource === "invites" && id && action === "join" && method === "POST") {
      const steamId = requireRenter(req, sessionSecret);
      const inviteId = verifyInviteToken(sessionSecret!, id);
      const joined = inviteId ? await platform.joinCrew(inviteId, steamId) : null;
      if (!joined || (!joined.ok && joined.reason === "not-found")) {
        throw new HttpError(404, "this invite link is not valid any more");
      }
      if (!joined.ok) {
        reply(res, 409, { error: "this is your own invite link", code: joined.reason });
        return true;
      }
      reply(res, 200, { crew: joined.crew, joined: joined.joined });
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
      if (!playable(gameId)) {
        reply(res, 403, NOT_PLAYABLE);
        return true;
      }
      if (await refuseUnlicensed(res, renter, gameId)) return true;
      if (machineId === undefined) {
        reply(res, 202, await platform.book(gameId, minutes, renter, rtts, prefs));
        return true;
      }
      const booking = await platform.bookMachine(machineId, gameId, minutes, renter, rtts, prefs);
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
      const running = booking.status === "claimed" || booking.status === "playing";
      const held = running && booking.machine ? heldUntil(booking.machine.id) : null;
      reply(res, 200, held === null ? booking : { ...booking, heldUntil: held });
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
      // Checked again at claim, as the library or whether Swiff can run the
      // game may have changed since the booking; a refusal leaves the
      // reservation unspent, as above.
      const booked = await platform.booking(id, renter);
      if (!booked) throw new HttpError(404, "no such booking");
      if (!playable(booked.gameId)) {
        reply(res, 403, NOT_PLAYABLE);
        return true;
      }
      if (await refuseUnlicensed(res, renter, booked.gameId, { claim: true })) return true;
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

    if (resource === "bookings" && id && action === "rejoin" && method === "POST") {
      // The renter coming back to their running session: its ticket again,
      // the seat recorded at claim, valid only until the session's deadline.
      const renter = requireRenter(req, sessionSecret);
      if (!access.secret) throw new HttpError(503, "tickets cannot be minted: ROOM_SECRET is not set");
      const session = await platform.runningSession(id, renter);
      if (!session.ok) {
        if (session.reason === "not-found") throw new HttpError(404, "no such booking");
        reply(res, 409, { error: "the booking has no session running", status: session.status });
        return true;
      }
      const ttl = Math.max(1, Math.floor(session.remainingMs / 1000));
      reply(res, 200, {
        sessionId: session.sessionId,
        roomId: session.roomId,
        signalingUrl: originFrom(req.headers, fallbackOrigin).replace(/^http/, "ws"),
        ticket: mintTicket(access.secret, session.roomId, ttl, Date.now(), session.ticketId),
      });
      return true;
    }

    if (resource === "bookings" && id && action === "continue" && method === "POST") {
      // The session's machine was lost: carry on elsewhere, on the best machine
      // free for the same game and the time left, or in the queue for one.
      // The game must still be the renter's to play, checked as at claim.
      const renter = requireRenter(req, sessionSecret);
      const lost = await platform.booking(id, renter);
      if (!lost) throw new HttpError(404, "no such booking");
      if (await refuseUnlicensed(res, renter, lost.gameId, { claim: true })) return true;
      const continued = await platform.continueBooking(id, renter);
      if (!continued.ok) {
        if (continued.reason === "not-found") throw new HttpError(404, "no such booking");
        reply(res, 409, { error: "the booking has no lost session to carry on", status: continued.status });
        return true;
      }
      reply(res, 202, continued.booking);
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
      if (body.reset !== undefined && typeof body.reset !== "boolean") {
        throw new HttpError(400, "reset must be true or false");
      }
      // A rental-mode restart between renters (platform.ts, the reset hold).
      if (body.reset && body.available) throw new HttpError(400, "reset takes the machine off offer");
      const price = body.price === undefined ? undefined : positiveIntOrZero(body.price, "price");
      if (body.crewOnly !== undefined && typeof body.crewOnly !== "boolean") {
        throw new HttpError(400, "crewOnly must be true or false");
      }
      const machine = await platform.setAvailability(
        id,
        body.available,
        {
          ...hostReport(body),
          price,
          availableUntil: optionalTime(body.until, "until"),
          crewOnly: body.crewOnly,
        },
        { reset: body.reset === true },
      );
      reply(res, 200, machine);
      return true;
    }

    if (resource === "machines" && id && action === "heartbeat" && method === "POST") {
      requireMachineOrHost(req, attestation, id);
      const body = await readJson(req, MAX_HOST_BODY_BYTES);
      reply(res, 200, await platform.heartbeat(id, hostReport(body)));
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

    if (resource === "machines" && id && action === "demand" && method === "GET") {
      // What renters ask for, for the owner deciding what to install: counts
      // per game, never who asked, and only games Swiff can run. A game the
      // catalogue cannot name has a null name.
      requireMachine(req, access, id);
      const [demand, catalogue] = await Promise.all([
        platform.demand(DEMAND_WINDOW_MS, DEMAND_LIMIT),
        bookable().catch(() => []),
      ]);
      const names = new Map(catalogue.map((g) => [g.id, g.name]));
      reply(res, 200, {
        windowMinutes: DEMAND_WINDOW_MS / 60_000,
        games: demand
          .filter((d) => playable(d.appid))
          .map((d) => ({ ...d, name: names.get(d.appid) ?? null })),
      });
      return true;
    }

    if (resource === "machines" && id && action === "attest-challenge" && method === "POST") {
      const challenge = attestation.challenge(id);
      reply(res, challenge.ok ? 200 : challenge.status, challenge.ok ? challenge.grant : challenge.body);
      return true;
    }

    if (resource === "machines" && id && action === "attest-activation" && method === "POST") {
      let body: Json;
      try {
        body = await readJson(req, MAX_HOST_BODY_BYTES);
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        reply(res, error.status === 413 ? 413 : 400, { error: "bad-request" });
        return true;
      }
      const made = await attestation.activate(id, body.nonce, body.akPublic);
      reply(res, made.ok ? 200 : made.status, made.ok ? made.grant : made.body);
      return true;
    }

    if (resource === "machines" && id && action === "ek" && method === "PUT") {
      // The owner's Windows registers the TPM's EK certificate, with the machine key.
      requireMachine(req, access, id);
      let body: Json;
      try {
        body = await readJson(req, MAX_ATTEST_BODY_BYTES);
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        reply(res, error.status === 413 ? 413 : 400, { error: "bad-request" });
        return true;
      }
      const enrolled = await attestation.enroll(id, body);
      if (enrolled.ok) {
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
      } else {
        reply(res, enrolled.status, enrolled.body);
      }
      return true;
    }

    if (resource === "machines" && id && action === "attest" && method === "POST") {
      let body: Json;
      try {
        body = await readJson(req, MAX_ATTEST_BODY_BYTES);
      } catch (error) {
        // Not JSON, not an object, or too large: the documented refusal, not prose.
        if (!(error instanceof HttpError)) throw error;
        reply(res, error.status === 413 ? 413 : 400, { error: "bad-request" });
        return true;
      }
      const attested = await attestation.attest(id, body.nonce, body.evidence);
      reply(res, attested.ok ? 200 : attested.status, attested.ok ? attested.grant : attested.body);
      return true;
    }

    if (resource === "machines" && id && action === "state-key" && (method === "POST" || method === "PUT")) {
      // swiff-hostd, right after attesting: the server's share of its state
      // partition key. Nothing is read from the body.
      try {
        await discardBody(req, MAX_HOST_BODY_BYTES);
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        reply(res, 413, { error: "bad-request" });
        return true;
      }
      const credential = attestation.credential(id, bearer(req));
      const answer =
        method === "POST" ? await stateKeys.release(id, credential) : await stateKeys.replace(id, credential);
      if (answer.ok) reply(res, answer.status, answer.grant);
      else
        reply(
          res,
          answer.status,
          answer.body,
          answer.retryAfterSeconds === undefined ? {} : { "retry-after": String(answer.retryAfterSeconds) },
        );
      return true;
    }

    // The renter's first frame: started with the join ticket rather than the
    // machine key, and the PC launches the game.
    const ticket =
      resource === "sessions" && action === "start" && method === "POST" && ticketOf(req, access);
    if (ticket && id) {
      const started = await platform.renterStarted(id, ticket.id);
      if (typeof started === "string") throw renterRefusal(started);
      onRenterStarted?.(started.machineId, id, started.gameId, ticket.id);
      reply(res, 200, { sessionId: id, roomId: started.machineId });
      return true;
    }

    if (resource === "sessions" && id && (action === "start" || action === "end") && method === "POST") {
      const machineId = await platform.sessionMachine(id);
      if (!machineId) throw new HttpError(404, "no such session");
      // The renter arriving is the host's to report; ending is the owner's too.
      if (action === "start") requireHosting(req, attestation, machineId);
      else requireMachineOrHost(req, attestation, machineId);
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
