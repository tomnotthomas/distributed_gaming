// Swiff signaling server — phase 1.
//
// Serves the built web app and relays WebRTC handshake messages between two
// peers. It never inspects offer/answer/ICE payloads: it knows only which two
// sockets share a room. Once the peer connection is up, video does NOT flow
// through here — this process sits idle.
//
//   Gaming PC                 this server                 Renter browser
//   ---------                 -----------                 --------------
//       |  register(hostId)        |                            |
//       |------------------------->|                            |
//       |                          |        join(hostId)        |
//       |                          |<---------------------------|
//       |      peer-joined         |                            |
//       |<-------------------------|                            |
//       |        offer             |           offer            |
//       |------------------------->|--------------------------->|
//       |        answer            |           answer           |
//       |<-------------------------|<---------------------------|
//       |         ice  <-------- relayed both ways -------->  ice
//       |                          |                            |
//       |======== WebRTC, peer to peer, not through here =======|
//
// A room is one gaming PC. Only that machine, holding its machine key, may
// register it; only a renter holding a ticket for it may join, and only one
// renter at a time. See access.ts.
//
// The host's open socket is also how the platform knows the PC is there: it
// stays offered while the socket is open and goes offline the moment it
// closes, or when the ping below stops being answered. Once a renter has
// claimed it, a closed socket leaves the PC the heartbeat window instead. A
// renter is there while their page speaks: opening the event stream
// (events.ts), then its heartbeat.
//
// When a renter claims the machine, its machine-key socket is told at once
// (session-claimed), and the PC service starts the host session for that
// platform session. While it runs, the room is registered by the streamer in
// the renter's Windows account with a short-lived session key instead, and the
// machine key cannot register it at all. See sessions.ts.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { createIceSource } from "./ice.js";
import { accessFromEnv, verifyMachineKey, verifyTicket } from "./access.js";
import {
  DENIED_CODE,
  isRelayed,
  type DeniedMessage,
  type SessionError,
  type SessionGrant,
  type SignalMessage,
} from "./protocol.js";
import { createHostSessions, type HostSessions } from "./sessions.js";
import { gamesMedia, popularGames } from "./catalog.js";
import { cachedProfiles, publicOriginFromEnv, readProfile } from "./steam.js";
import { createSteamAuth, sessionSecretFromEnv } from "./signin.js";
import { MAX_MINUTES, Platform, type ClaimedSession } from "./platform.js";
import { createApi } from "./api.js";
import { createRenterEvents } from "./events.js";
import { openDatabase } from "./db.js";
import { bearer, HttpError, readJson } from "./http.js";

const PORT = Number(process.env.PORT ?? 8080);

// Sent to both peers on register/join. Omitted entirely when unset, so a
// server with no TURN behaves exactly as before. Read per message rather than
// captured once: credentials are re-minted while the process runs.
const ice = createIceSource(process.env);
const iceServers = () => {
  const servers = ice.servers();
  return servers.length ? { iceServers: servers } : {};
};

const access = accessFromEnv(process.env);

// Signs renters' sign-in session cookies (signin.ts). Without it nobody can
// sign in, so nobody can book.
const sessionSecret = sessionSecretFromEnv(process.env);

// The only origin Steam sign-in trusts, for its return route, its redirects and
// the cookie's Secure flag. Without it in production nobody can sign in.
const publicOrigin = publicOriginFromEnv(process.env, PORT);
const serveSteamAuth = createSteamAuth({ origin: publicOrigin, sessionSecret });

// Machines, bookings, reservations and sessions (platform.ts), in the Postgres
// database at DATABASE_URL, or in memory without one. Opened, its tables made
// or brought up to date, before the server listens; a database it cannot reach
// stops the process, for the host to start again. A claim is pushed to the
// claimed PC, and every booking change to the renter's event stream. Whenever a
// renter's session ends there, however it ends, the PC's host session ends with
// it and the renter is put out: the next renter never meets a streamer launched
// for the last one. Each machine's owner comes from MACHINE_KEYS, so no renter
// is ever matched to their own PC. The platform arms its own timer for whatever
// changes only with time.
const platform = await Platform.open({
  database: openDatabase(process.env.DATABASE_URL),
  owners: access.owners,
  onSessionEnded: sessionEnded,
  onSessionClaimed: pushClaim,
  onBookingChanged: (bookingId) => void renterEvents.bookingChanged(bookingId),
}).catch((error: unknown) => {
  // The message names what failed (the host, the user, a missing table), never the password.
  console.error(
    "[swiff] the database could not be opened:",
    error instanceof Error ? error.message : typeof error,
  );
  process.exit(1);
});
// Open renter streams are capped server-wide and per signed-in renter (events.ts).
const renterEvents = createRenterEvents(platform, {
  maxStreams: Number(process.env.MAX_EVENT_STREAMS) || undefined,
  maxStreamsPerRenter: Number(process.env.MAX_EVENT_STREAMS_PER_RENTER) || undefined,
});

// Session keys are signed with ROOM_SECRET too, so without it no session can
// start and the machine key is the only way to register. Live sessions are kept
// in the platform database, so they and their keys survive a restart.
const sessions = access.secret ? createHostSessions(access.secret, platform.keySessions) : null;
const serveApi = createApi({
  platform,
  access,
  sessionSecret,
  publicOrigin,
  fallbackOrigin: `http://localhost:${PORT}`,
  profile: cachedProfiles((steamId) => readProfile(process.env.STEAM_API_KEY, steamId)),
  events: renterEvents,
});

// Handshake frames are a few KB. The ws default is 100 MB, which lets any
// unauthenticated socket make this process buffer that much per message.
const MAX_FRAME_BYTES = 64 * 1024;

// Resolved from the COMPILED location: server/dist/index.js -> web/dist/
const STATIC_DIR = fileURLToPath(new URL("../../web/dist/", import.meta.url));

// Cloudflare closes an idle WebSocket after 100s. Both peers ping every 25s;
// this server drops a socket that misses two rounds so a crashed host does not
// hold its room forever.
const HEARTBEAT_MS = 25_000;
const HEARTBEAT_MISSES = 2;

/** Rooms whose host pinged since the last sweep round: their PCs are there. */
const pinged = new Set<string>();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

type Role = "host" | "client";

/** A socket plus the room bookkeeping this server hangs off it. */
type PeerSocket = WebSocket & {
  hostId: string | null;
  role: Role | null;
  /** The ticket a renter joined with. A refresh with the same one retakes the seat. */
  ticketId: string | null;
  /** The session a host registered under with a session key; null for a machine key. */
  sessionId: string | null;
  missedBeats: number;
  /** This socket's frames and its close, handled one at a time in the order they came. */
  turn: Promise<void>;
};

type Room = { host: PeerSocket | null; client: PeerSocket | null };

const rooms = new Map<string, Room>();

/**
 * Tickets known to be revoked, each until when it could still be in use (Unix
 * ms). Every way this server ends a session reaches the session-end notice,
 * which records the session's ticket as the change commits, before any other
 * frame is handled; a database check that finds a ticket revoked behind the
 * server's back (a join, a host registering, the reconcile) records it too. A
 * revocation never reverses. Relayed frames are checked against this alone,
 * never the database.
 */
const revokedTickets = new Map<string, number>();

/** A booking's ticket runs for its minutes from the claim, so none outlives its revocation by more. */
const REVOCATION_KEPT_MS = MAX_MINUTES * 60_000;

/** Record that `ticketId` is revoked. */
function revoke(ticketId: string): void {
  revokedTickets.set(ticketId, Date.now() + REVOCATION_KEPT_MS);
}

function roomFor(hostId: string): Room {
  let room = rooms.get(hostId);
  if (!room) {
    room = { host: null, client: null };
    rooms.set(hostId, room);
  }
  return room;
}

/**
 * The other socket in the same room, or null when the peer has not arrived or
 * `ws` no longer holds its seat (evicted or replaced, and still closing).
 */
function peerOf(ws: PeerSocket): PeerSocket | null {
  const room = ws.hostId ? rooms.get(ws.hostId) : undefined;
  if (!room) return null;
  if (ws.role === "host") return room.host === ws ? room.client : null;
  return room.client === ws ? room.host : null;
}

function send(ws: PeerSocket | null, message: SignalMessage): void {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

/** Refuse, say why, and hang up. The socket never enters a room. */
function deny(ws: PeerSocket, reason: DeniedMessage["reason"]): void {
  send(ws, { type: "denied", reason });
  ws.close(DENIED_CODE, reason);
}

/**
 * Take the host out of its room now, tell the renter, then hang up on it. The
 * room must not wait for the close handshake: a new host registering before it
 * finishes would otherwise take the seat without the renter hearing peer-left.
 * The room is being handed over, not dropped: the machine has the liveness
 * window to come back on its new credential before it counts as offline.
 */
function evictHost(hostId: string, reason: DeniedMessage["reason"]): void {
  const room = rooms.get(hostId);
  const host = room?.host;
  if (!room || !host) return;
  room.host = null;
  send(room.client, { type: "peer-left" });
  if (!room.client) rooms.delete(hostId);
  deny(host, reason);
  hostGone(hostId, false);
}

/**
 * Tell the platform the host socket holding `hostId` is gone: `dropped` when it
 * closed or stopped answering (a PC on offer is offline at once), not when the
 * server handed the room over. A database failure is logged, never thrown.
 */
function hostGone(hostId: string, dropped: boolean): void {
  platform.hostDisconnected(hostId, dropped).catch((error: unknown) => {
    console.error("[swiff] host presence failed:", error instanceof Error ? error.name : typeof error);
  });
}

// --- host sessions ----------------------------------------------------------

/**
 * End the live host session in `hostId`, if any: every key of it dies, and the
 * streamer registered with one is hung up on, so the room really is handed back.
 */
async function endHostSession(hostId: string): Promise<void> {
  const ended = await sessions?.end(hostId);
  if (ended) evictStreamer(hostId, ended);
}

/**
 * A platform session on `hostId` ended, however it ended. Its streamer is hung
 * up on, and a renter still seated on the session's revoked ticket is put out.
 */
function sessionEnded(hostId: string, sessionId: string, ticketId: string | null): void {
  if (ticketId !== null) revoke(ticketId);
  evictStreamer(hostId, sessionId);
  const client = rooms.get(hostId)?.client;
  if (client && seatRevoked(client)) putOut(client);
}

/** Put the renter `client` out with `bad-ticket`: its ticket is revoked, and nothing more is relayed for it. */
function putOut(client: PeerSocket): void {
  if (client.ticketId) revoke(client.ticketId);
  deny(client, "bad-ticket");
}

/** True when nothing may be relayed to or from `renter`: its ticket is known to be revoked. */
function seatRevoked(renter: PeerSocket): boolean {
  return renter.ticketId !== null && revokedTickets.has(renter.ticketId);
}

/**
 * True when the renter `client` may stay seated: its ticket's session has not
 * ended, by the database. A revoked one is put out. When the database cannot
 * say, the renter is hung up on without `denied`, so it may retry. The
 * session-end notice puts a revoked renter out at once; this is the check that
 * does not depend on that notice arriving. Never rejects.
 */
async function seatStillValid(client: PeerSocket): Promise<boolean> {
  if (!client.ticketId) return true;
  if (seatRevoked(client)) {
    putOut(client);
    return false;
  }
  try {
    if (!(await platform.ticketRevoked(client.ticketId))) return true;
    putOut(client);
  } catch (error) {
    console.error("[swiff] ticket check failed:", error instanceof Error ? error.name : typeof error);
    client.close(1011, "internal error");
  }
  return false;
}

/**
 * Hang up on the streamer serving session `sessionId` in `hostId`, if it is
 * the room's host. The platform ends a session's host session in the same
 * transaction that ends the session, before this runs.
 */
function evictStreamer(hostId: string, sessionId: string): void {
  if (rooms.get(hostId)?.host?.sessionId === sessionId) evictHost(hostId, "session-ended");
}

/**
 * Tell the claimed PC now rather than at its next heartbeat. Only a host
 * registered with the machine key hears it: that is the PC service, never a
 * streamer in a renter's account. A PC that is not connected hears it when it
 * registers, or learns from its heartbeat.
 */
function pushClaim(hostId: string, { sessionId, gameId, minutes }: ClaimedSession): void {
  const host = rooms.get(hostId)?.host;
  if (host?.sessionId === null) send(host, { type: "session-claimed", sessionId, appid: gameId, minutes });
}

const SESSION_ROUTE = /^\/api\/machines\/([^/]+)\/session$/;

/** End the response with uncached JSON, or just the status when no body is supplied. */
function json(res: ServerResponse, status: number, body?: SessionGrant | SessionError): void {
  if (!body) {
    res.writeHead(status, SESSION_CORS).end();
    return;
  }
  // A session key is a credential: nothing between here and the PC may keep it.
  res.writeHead(status, { ...SESSION_CORS, "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

// The desktop host app calls the session API from its own origin, not this
// server's. Any origin may, because the only credential is the machine key in
// the Authorization header: no cookie or other ambient credential rides along,
// so a page cannot act with a key it does not already hold.
const SESSION_CORS = { "access-control-allow-origin": "*" };
const SESSION_PREFLIGHT = {
  ...SESSION_CORS,
  "access-control-allow-methods": "POST, DELETE",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "600",
};

/**
 * Start and end a renter's session on one gaming PC. Called by the PC's
 * background service with its machine key; see protocol.ts for the routes.
 * Resolves false without responding if `urlPath` does not match, otherwise true
 * after responding, including refusals. `urlPath` is the encoded URL pathname.
 * Starting requires the machine's claimed platform session id and closes any
 * machine-key host; ending revokes the session's keys and closes its registered
 * host. Ending an absent session still succeeds.
 */
async function serveSessions(req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<boolean> {
  const match = SESSION_ROUTE.exec(urlPath);
  if (!match) return false;

  let hostId: string;
  try {
    hostId = decodeURIComponent(match[1]!);
  } catch {
    json(res, 404, { error: "not-found" });
    return true;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, SESSION_PREFLIGHT).end();
    return true;
  }
  const allowed = ["POST", "DELETE"];
  if (!allowed.includes(req.method ?? "")) {
    res.writeHead(405, { allow: allowed.join(", ") }).end();
    return true;
  }

  if (!sessions) {
    json(res, 503, { error: "not-configured" });
    return true;
  }
  try {
    await answerSession(req, res, hostId, sessions);
  } catch (error) {
    // An unreachable or broken database must not take signaling down with it.
    // Only the kind of failure is logged: the request carries the machine key.
    console.error("[swiff] session request failed:", error instanceof Error ? error.name : typeof error);
    if (!res.headersSent) json(res, 500, { error: "internal-error" });
  }
  return true;
}

/** Authenticate, then start or end the host session in `hostId`. Throws on a database failure. */
async function answerSession(
  req: IncomingMessage,
  res: ServerResponse,
  hostId: string,
  sessions: HostSessions,
): Promise<void> {
  if (!verifyMachineKey(access.machines, hostId, bearer(req))) {
    json(res, 401, { error: "bad-machine-key" });
    return;
  }

  if (req.method === "DELETE") {
    await endHostSession(hostId);
    json(res, 204);
    return;
  }

  let sessionId: unknown;
  try {
    ({ sessionId } = await readJson(req));
  } catch (error) {
    // Not JSON, too large, or the client gave up mid-body: never a crash.
    json(res, error instanceof HttpError ? error.status : 400, { error: "bad-request" });
    return;
  }
  if (typeof sessionId !== "string" || !sessionId) {
    json(res, 400, { error: "bad-request" });
    return;
  }
  // Only the session a renter has claimed on this machine, and only while it
  // runs: a host session can never outlive or stand in for its platform session.
  // The platform's store refuses it too should the session end before it is added.
  if ((await platform.claimedSession(hostId))?.sessionId !== sessionId) {
    json(res, 409, { error: "not-claimed" });
    return;
  }
  const grant = await sessions.start(hostId, sessionId);
  if (!grant) {
    json(res, 409, { error: "session-active" });
    return;
  }
  // From here the room belongs to the session. A host registered with the
  // machine key is put out now rather than left serving until the streamer
  // arrives.
  if (rooms.get(hostId)?.host?.sessionId === null) evictHost(hostId, "session-active");
  json(res, 201, grant);
}

// --- static files -----------------------------------------------------------

/**
 * The game catalog: Steam's most played games for the signed-out wall, and
 * names plus trailers for any appids (a signed-in library). Keyless and cached
 * in catalog.ts; a Steam outage answers an empty list and the client falls back
 * to its own nine.
 */
async function serveCatalog(res: ServerResponse, urlPath: string, query: URLSearchParams): Promise<boolean> {
  let games: Promise<unknown[]>;
  if (urlPath === "/api/games/popular") games = popularGames();
  else if (urlPath === "/api/games/media") {
    games = gamesMedia((query.get("appids") ?? "").split(",").map(Number));
  } else return false;

  const body = JSON.stringify({ games: await games.catch(() => []) });
  // Browsers may reuse it for a few minutes; the server's own cache does the rest.
  res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" });
  res.end(body);
  return true;
}

/**
 * Dispatch session, Steam sign-in and catalog requests, then serve the built web app.
 * Extensionless paths use index.html; file read failures return 500 for that page
 * and 404 for assets. URL parsing and delegated handler errors propagate as rejections.
 */
async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const urlPath = url.pathname;

  if (await serveSessions(req, res, urlPath)) return;
  if (await serveSteamAuth(req, res, urlPath, url.searchParams)) return;
  if (await serveCatalog(res, urlPath, url.searchParams)) return;
  if (await serveApi(req, res, urlPath)) return;

  // Every screen is the same SPA. A path with no extension is a route, so it
  // gets index.html; a path with one is an asset, so a miss is a real 404.
  const candidate = extname(urlPath) === "" ? "index.html" : urlPath.slice(1);

  // normalize() collapses ".." before we join, so a crafted path cannot escape
  // STATIC_DIR.
  const filePath = join(STATIC_DIR, normalize(candidate));
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    if (candidate === "index.html") {
      res.writeHead(500).end("web app not built — run `npm run build`");
    } else {
      res.writeHead(404).end("not found");
    }
  }
}

// --- signaling --------------------------------------------------------------

/**
 * Answer a message from `ws` that is not relayed. Rejects when the database
 * fails. Room state is read again after every wait for the database: other
 * sockets may have moved meanwhile.
 */
async function answer(ws: PeerSocket, msg: SignalMessage): Promise<void> {
  switch (msg.type) {
    case "ping":
      ws.missedBeats = 0;
      if (ws.role === "host" && ws.hostId) pinged.add(ws.hostId);
      send(ws, { type: "pong" });
      return;

    case "register": {
      if (ws.role) return; // one room per socket, decided once
      let sessionId: string | null = null;
      if ("sessionKey" in msg) {
        // The streamer: the key must name this room and its session be live.
        const key = sessions ? await sessions.verify(msg.sessionKey) : null;
        if (!key || key.room !== msg.hostId) return deny(ws, "bad-session-key");
        sessionId = key.session;
      } else {
        if (!verifyMachineKey(access.machines, msg.hostId, msg.key)) return deny(ws, "bad-machine-key");
        // The machine key never displaces a renter's session, live streamer
        // or not: the room is the session's until the service ends it.
        if (await sessions?.isLive(msg.hostId)) return deny(ws, "session-active");
      }
      const room = roomFor(msg.hostId);
      // A reconnecting host replaces the stale socket rather than being
      // refused — otherwise a crashed host locks itself out of its own room.
      if (room.host && room.host !== ws) room.host.close(4000, "replaced by a newer host");
      ws.hostId = msg.hostId;
      ws.role = "host";
      ws.sessionId = sessionId;
      room.host = ws;
      // The PC is there for as long as this socket stays open.
      await platform.hostConnected(msg.hostId);
      // A newer host took the seat meanwhile: this one is being hung up on.
      if (room.host !== ws) return;
      send(ws, { type: "registered", hostId: msg.hostId, ...iceServers() });
      // A client that arrived first is still waiting; tell the host now,
      // unless its ticket died meanwhile, or it left while that was checked.
      const client = room.client;
      if (client && (await seatStillValid(client)) && room.client === client) {
        send(ws, { type: "peer-joined" });
      }
      // A PC that missed its claim, or lost it before starting the session,
      // hears it again: the machine key only registers with no session live.
      if (sessionId === null) {
        const claimed = await platform.claimedSession(msg.hostId);
        if (claimed && room.host === ws) pushClaim(msg.hostId, claimed);
      }
      return;
    }

    case "join": {
      if (ws.role) return;
      const ticket = access.secret ? verifyTicket(access.secret, msg.ticket) : null;
      if (!ticket || revokedTickets.has(ticket.id)) return deny(ws, "bad-ticket");
      const revoked = await platform.ticketRevoked(ticket.id);
      if (revoked) revoke(ticket.id);
      // Revoked in the database, or by a notice while the database was asked.
      if (revokedTickets.has(ticket.id)) {
        // A renter still seated on it is put out too.
        const seated = rooms.get(ticket.room)?.client;
        if (seated && seatRevoked(seated)) putOut(seated);
        return deny(ws, "bad-ticket");
      }
      const room = roomFor(ticket.room);
      if (room.client && room.client !== ws) {
        // The same ticket again is the same renter refreshing: hand them the
        // seat. A different ticket is somebody else, and the seat is taken.
        if (room.client.ticketId !== ticket.id) return deny(ws, "room-taken");
        room.client.close(4001, "replaced by a newer client");
      }
      ws.hostId = ticket.room;
      ws.role = "client";
      ws.ticketId = ticket.id;
      room.client = ws;
      send(ws, { type: "joined", hostId: ticket.room, hostOnline: Boolean(room.host), ...iceServers() });
      send(room.host, { type: "peer-joined" });
      return;
    }

    default:
      return;
  }
}

const server = createServer(serveStatic);
const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES });

/** Handle `work` for `ws` once everything it sent before has been: frames and close, in order. */
function inTurn(ws: PeerSocket, work: () => Promise<void> | void): void {
  ws.turn = ws.turn.then(work).catch((error: unknown) => {
    console.error("[swiff] signaling failed:", error instanceof Error ? error.name : typeof error);
  });
}

/** One frame from `ws`: relayed to its peer, or answered. */
async function onMessage(ws: PeerSocket, raw: RawData): Promise<void> {
  let msg: SignalMessage;
  try {
    msg = JSON.parse(String(raw)) as SignalMessage;
  } catch {
    return; // garbage in, ignored — never crash the room over one bad frame
  }

  if (isRelayed(msg)) {
    // Forwarded verbatim. The server does not read the payload. Never to or
    // from a renter whose ticket is known to be revoked since it joined.
    const peer = peerOf(ws);
    const renter = ws.role === "client" ? ws : peer;
    if (renter && seatRevoked(renter)) return;
    send(peer, msg);
    return;
  }

  try {
    await answer(ws, msg);
  } catch (error) {
    // Register and join read the database. Failing, it must not take the
    // process down; hanging up without `denied` lets the peer retry.
    console.error("[swiff] signaling message failed:", error instanceof Error ? error.name : typeof error);
    ws.close(1011, "internal error");
  }
}

/** `ws` closed: give up its seat, and tell its peer and the platform. */
function onClose(ws: PeerSocket): void {
  const room = ws.hostId ? rooms.get(ws.hostId) : undefined;
  if (!room) return;

  // A socket that was already replaced is not in this room any more: a newer
  // host or renter took its seat, and the close arriving now is the tail end
  // of that handover. It must change nothing — above all it must not report
  // "peer-left", because the peer it would reach is the surviving one, which
  // is at that moment negotiating with the replacement. Telling it somebody
  // left makes it tear down the connection it just built, and a renter who
  // simply refreshed the page never gets a picture again.
  if (room.host !== ws && room.client !== ws) return;

  const peer = peerOf(ws);
  const wasHost = room.host === ws;
  if (wasHost) room.host = null;
  if (room.client === ws) room.client = null;
  send(peer, { type: "peer-left" });
  if (!room.host && !room.client && ws.hostId) rooms.delete(ws.hostId);
  // The PC service's own socket going is the PC going: offline now while it
  // is on offer. A streamer's going, or any socket once a renter has claimed
  // the PC, leaves the liveness window: a session does not die with one socket.
  if (wasHost && ws.hostId) hostGone(ws.hostId, ws.sessionId === null);
}

wss.on("connection", (socket) => {
  const ws = socket as PeerSocket;
  ws.hostId = null;
  ws.role = null;
  ws.ticketId = null;
  ws.sessionId = null;
  ws.missedBeats = 0;
  ws.turn = Promise.resolve();

  // An oversized or malformed frame surfaces here, and ws closes the socket
  // itself. Unhandled, the same error would take the whole process down.
  ws.on("error", () => {});

  // A frame that waits on the database holds back the ones after it, and the
  // close: a register is done before the offer behind it is relayed, and a
  // socket that closes mid-register is seated before it gives the seat up.
  ws.on("message", (raw) => inTurn(ws, () => onMessage(ws, raw)));
  ws.on("close", () => inTurn(ws, () => onClose(ws)));
});

/**
 * Check every seated renter's ticket with the database in one read: a revoked
 * one is recorded and put out, even one that sends nothing. When the database
 * cannot say, the round is skipped and every renter keeps its seat: relayed
 * frames are still checked against the revocations already known, and the
 * next round tries again. Also forgets revocations no ticket could still be in
 * use for.
 */
async function reconcileSeats(): Promise<void> {
  const now = Date.now();
  for (const [ticketId, until] of revokedTickets) if (until <= now) revokedTickets.delete(ticketId);
  const seated = [...rooms.values()].flatMap((room) => (room.client?.ticketId ? [room.client] : []));
  if (!seated.length) return;
  try {
    for (const ticketId of await platform.ticketsRevoked(seated.map((client) => client.ticketId!))) {
      revoke(ticketId);
    }
  } catch (error) {
    console.error("[swiff] ticket check failed:", error instanceof Error ? error.name : typeof error);
    return;
  }
  for (const client of seated) if (seatRevoked(client)) putOut(client);
}

// The safety net under the session-end notice, for a ticket revoked where no
// notice is sent (straight in the database): every few seconds, so a revoked
// renter keeps its seat for that long at most. One check at a time.
// SWIFF_TICKET_RECONCILE_MS shortens it for tests.
const TICKET_RECONCILE_MS = Number(process.env.SWIFF_TICKET_RECONCILE_MS) || 5_000;
let reconciling: Promise<void> | null = null;
setInterval(() => {
  reconciling ??= reconcileSeats().finally(() => (reconciling = null));
}, TICKET_RECONCILE_MS).unref();

// Server-side liveness sweep. Without it a host whose machine slept keeps its
// room and the next renter joins a socket that will never answer, and the
// platform keeps offering a PC that is not there: terminating the socket is
// what takes it offline.
// Each round also stores, in one write, that the PCs which pinged since the
// last round are still there, so a crash leaves their last contact at most a
// round stale rather than as of whatever last touched the database.
const sweep = setInterval(() => {
  for (const socket of wss.clients) {
    const ws = socket as PeerSocket;
    if (ws.missedBeats >= HEARTBEAT_MISSES) {
      ws.terminate();
      continue;
    }
    ws.missedBeats += 1;
  }
  const alive = [...pinged];
  pinged.clear();
  platform.hostsAlive(alive).catch((error: unknown) => {
    console.error("[swiff] host presence failed:", error instanceof Error ? error.name : typeof error);
  });
}, HEARTBEAT_MS);
sweep.unref?.();

server.listen(PORT, () => {
  console.log(`[swiff] http://localhost:${PORT}       (the wall)`);
  console.log(`[swiff] http://localhost:${PORT}/host  (gaming PC)`);
  console.log(`[swiff] http://localhost:${PORT}/rtc   (handshake demo)`);
  if (!process.env.DATABASE_URL)
    console.warn("[swiff] DATABASE_URL not set — the platform's data is kept in memory and lost on restart");
  if (!access.secret) console.warn("[swiff] ROOM_SECRET missing or too short — no renter can join");
  if (!access.machines.size) console.warn("[swiff] MACHINE_KEYS empty — no gaming PC can register");
  if (!sessionSecret)
    console.warn("[swiff] SESSION_SECRET missing, too short or equal to ROOM_SECRET — no renter can sign in");
  if (!publicOrigin)
    console.warn("[swiff] PUBLIC_ORIGIN missing or not an http(s) URL — no renter can sign in with Steam");
  const ownerless = [...access.machines.keys()].filter((id) => !access.owners.has(id)).length;
  if (ownerless) console.warn(`[swiff] ${ownerless} machine(s) in MACHINE_KEYS name no owner Steam id`);
  // Warm the catalog so the first visitor's wall does not wait on Steam.
  void popularGames();
});

// Not awaited before listening: minting talks to a third party, and the LAN
// case needs no relay at all. Peers that register before the first credential
// lands simply get none, exactly as they would with no TURN configured.
void ice.start();
