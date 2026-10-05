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
//       |                          |   first frame: POST        |
//       |      launch-game         |   /api/sessions/:id/start  |
//       |<-------------------------|<---------------------------|
//       |      game-started        |        game-started        |
//       |------------------------->|--------------------------->|
//
// A room is one gaming PC. Only that machine, holding its machine key or a host
// certificate, may register it; only a renter holding a ticket for it may join,
// and only one renter at a time. See access.ts.
//
// The host's open socket is also how the platform knows the PC is there: it
// stays offered while the socket is open and goes offline the moment it
// closes, or when the ping below stops being answered. Once a renter has
// claimed it, a closed socket leaves the PC the heartbeat window instead. A
// renter is there while their page speaks: opening the event stream
// (events.ts), then its heartbeat.
//
// When a renter claims the machine, its PC service's socket is told at once
// (session-claimed), and the service starts the host session for that
// platform session. While it runs, the room is registered by the streamer in
// the renter's Windows account with a short-lived session key instead, and the
// service's credential cannot register it at all. See sessions.ts.
//
// Only a credential that may host serves a renter: the service's socket, which
// hears session-claimed and gets TURN, and starting a host session, which mints
// session keys. That is a host certificate from attestation, or the machine
// key while hosting does not require attestation. See attestation.ts.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { sessionSpanMs } from "@swiff/rank";
import { createIceSource } from "./ice.js";
import { accessFromEnv, verifyTicket, type HostingTier } from "./access.js";
import { attestationFromEnv, createAttestation, looksLikeHostCert } from "./attestation.js";
import { createStateKeys, databaseStateKeyStore, stateKeySecretFromEnv } from "./state-key.js";
import {
  DENIED_CODE,
  isRelayed,
  type DeniedMessage,
  type PeerLeftMessage,
  type SessionError,
  type SessionGrant,
  type SignalMessage,
} from "./protocol.js";
import { createHostSessions, type HostSessions } from "./sessions.js";
import { createRenterGrace, graceMsFromEnv } from "./grace.js";
import { gamesMedia, popularGames, type CatalogGame } from "./catalog.js";
import { cachedProfiles, publicOriginFromEnv, readProfile, WALL_APPIDS } from "./steam.js";
import { createSteamAuth, sessionSecretFromEnv } from "./signin.js";
import { MAX_MINUTES, Platform, type ClaimedSession } from "./platform.js";
import { createApi } from "./api.js";
import { createRenterEvents } from "./events.js";
import { openDatabase } from "./db.js";
import { everyGamePlayable, Playability, withAccounts } from "./playable.js";
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

// Machines, bookings, reservations and sessions (platform.ts below), and what
// the TPM verifier keeps per machine: Postgres at DATABASE_URL, or in memory
// without one.
const database = openDatabase(process.env.DATABASE_URL);

// Which credential may host (HOSTING_ATTESTATION) and who judges attestation
// (ATTESTATION_VERIFIER). Unset: the machine key hosts, unattested, and no
// machine can attest.
const attestationConfig = attestationFromEnv(process.env, access.machines, database);

// Rental-mode PCs' state keys (state-key.ts), sealed with STATE_KEY_SECRET in
// the platform database: released only to the boot that just attested. Every
// attestation that passes tells it which boot that was, first.
const stateKeySecret = stateKeySecretFromEnv(process.env);
const stateKeys = createStateKeys({
  store: databaseStateKeyStore(database),
  secret: stateKeySecret.secret,
  verifier: attestationConfig.verifier,
});
const attestation = createAttestation({ access, ...attestationConfig, onAttested: stateKeys.observe });

// Signs renters' sign-in session cookies (signin.ts). Without it nobody can
// sign in, so nobody can book.
const sessionSecret = sessionSecretFromEnv(process.env);

// The only origin Steam sign-in trusts, for its return route, its redirects and
// the cookie's Secure flag. Without it in production nobody can sign in.
const publicOrigin = publicOriginFromEnv(process.env, PORT);
const serveSteamAuth = createSteamAuth({ origin: publicOrigin, sessionSecret });

// A renter who drops mid-session has the grace to come back (grace.ts): the
// session ends as grace_expired only once it runs out. Declared before the
// platform, whose first settling may already end a session.
// SWIFF_RECONNECT_GRACE_MS shortens it for tests, never lengthens it.
const GRACE_MS = graceMsFromEnv(process.env.SWIFF_RECONNECT_GRACE_MS);
const grace = createRenterGrace({
  graceMs: GRACE_MS,
  onExpire: (hostId, ticketId, droppedAt) => {
    // A renter seated again on the same seat came back: their session stands,
    // however the timer and their join crossed.
    const back = () => rooms.get(hostId)?.client?.ticketId === ticketId;
    if (back()) return;
    void (async () => {
      const sessionId = await platform.ticketSession(ticketId);
      if (sessionId && !back()) await platform.leaveSession(sessionId, ticketId, droppedAt);
    })().catch((error: unknown) => {
      console.error("[swiff] grace expiry failed:", error instanceof Error ? error.name : typeof error);
    });
  },
});

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
  database,
  owners: access.owners,
  // Attested-only: a machine is on the market only while a socket that may
  // host it is open, never on its machine key's heartbeat alone.
  offeredOnlyWhilePresent: attestationConfig.attestedOnly,
  onSessionEnded: sessionEnded,
  droppedAt: (machineId, ticketId) => grace.droppedAt(machineId, ticketId),
  onSessionClaimed: pushClaim,
  onBookingChanged: (bookingId) => void renterEvents.bookingChanged(bookingId),
  onAvailabilityChanged: () => renterEvents.availabilityChanged(),
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

// Which games Swiff can run (playable.ts): renters are shown, and may book,
// only those. Checked against Steam in the background, a game at a time, from
// the verdicts the database already holds.
// SWIFF_PLAYABILITY=off, for tests that start the real server, makes every
// game playable and checks nothing, so they never wait on or call Steam.
const playability = process.env.SWIFF_PLAYABILITY === "off" ? everyGamePlayable : new Playability(database);
if (playability instanceof Playability) playability.start();
else console.warn("[swiff] SWIFF_PLAYABILITY=off — every game is shown as playable, unchecked");

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
  attestation,
  stateKeys,
  playability,
  onRenterStarted: pushLaunch,
  heldUntil: (machineId) => grace.until(machineId),
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
  /**
   * A renter's ticket was handed out for a running session when they joined:
   * dropping out of it starts the reconnect grace. A ticket minted by hand has none.
   */
  inSession: boolean;
  /**
   * When the last database read that found a renter's ticket not revoked began
   * (performance.now() ms): at join, before a relayed frame, and each reconcile.
   */
  confirmedAt: number;
  /**
   * The session a host registered under with a session key; null for the PC
   * service's own socket. For a renter, the session their page started with
   * their ticket; null until it has.
   */
  sessionId: string | null;
  /** How far the PC service's socket may be trusted to host; null for a streamer or a renter. */
  tier: HostingTier | null;
  /** When the host certificate it registered with expires (Unix s); null for any other credential. */
  certExp: number | null;
  /** Puts the socket out when its host certificate expires. */
  certTimer: ReturnType<typeof setTimeout> | null;
  missedBeats: number;
  /** This socket's frames and its close, handled one at a time in the order they came. */
  turn: Promise<void>;
  /** This socket's frames received and not yet handled, the one being handled included. */
  queued: number;
  /** Frames from this socket dropped for MAX_QUEUED_FRAMES since its queue last drained, logged when it does. */
  dropped: number;
};

type Room = { host: PeerSocket | null; client: PeerSocket | null };

const rooms = new Map<string, Room>();

/**
 * Tickets known to be revoked, each until when it could still be in use (Unix
 * ms). Every way this server ends a session reaches the session-end notice,
 * which records the session's ticket as the change commits, before any other
 * frame is handled; a database check that finds a ticket revoked behind the
 * server's back (a join, a host registering, a relayed frame, the reconcile)
 * records it too. A revocation never reverses.
 */
const revokedTickets = new Map<string, number>();

/**
 * A booking's ticket runs for its minutes from the claim, and a rental-mode
 * PC's Steam sign-in before them (api.ts), so none outlives its revocation by more.
 */
const REVOCATION_KEPT_MS = sessionSpanMs({ rentalMode: true }, MAX_MINUTES);

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

// --- reconnect grace --------------------------------------------------------

/**
 * What the host hears when renter `ws` leaves its seat. A renter seated on a
 * running session's ticket (found at join) and not known to be revoked is
 * dropping out of that session: its grace starts now, and the host is told how
 * long it lasts. Decided without the database, so the host hears it before
 * anything that renter's next join says; a session ended behind the server's
 * back meanwhile simply expires with nothing to end.
 */
function renterLeft(ws: PeerSocket): PeerLeftMessage {
  if (!ws.hostId || !ws.ticketId || !ws.inSession || seatRevoked(ws)) return { type: "peer-left" };
  grace.start(ws.hostId, ws.ticketId);
  return { type: "peer-left", grace: GRACE_MS / 1000 };
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
  // However it ended, a renter who dropped has nothing left to come back to.
  grace.cancel(hostId);
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
    const began = performance.now();
    if (!(await platform.ticketRevoked(client.ticketId))) {
      confirm(client, began);
      return true;
    }
    putOut(client);
  } catch (error) {
    console.error("[swiff] ticket check failed:", error instanceof Error ? error.name : typeof error);
    client.close(1011, "internal error");
  }
  return false;
}

/** Record that a database read begun at `began` (performance.now() ms) found the renter `client`'s ticket not revoked. */
function confirm(client: PeerSocket, began: number): void {
  client.confirmedAt = Math.max(client.confirmedAt, began);
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
 * Tell the claimed PC now rather than at its next heartbeat. Only the PC
 * service's socket hears it, registered with a credential that may host, never
 * a streamer in a renter's account. A PC that is not connected hears it when it
 * registers, or learns from its heartbeat.
 */
function pushClaim(hostId: string, { sessionId, gameId, minutes }: ClaimedSession): void {
  const host = rooms.get(hostId)?.host;
  if (host && mayHost(host)) send(host, { type: "session-claimed", sessionId, appid: gameId, minutes });
}

/** True for the PC service's socket registered with a credential that may host and has not expired. */
function mayHost(host: PeerSocket): boolean {
  const certValid = host.certExp == null || host.certExp * 1000 > Date.now();
  return host.sessionId === null && host.tier !== null && certValid;
}

/**
 * The renter's first frame arrived and their page started the session with
 * `ticketId`: tell the host serving it to launch the game. The streamer
 * registered for that session hears it, or the PC service's socket registered
 * with a credential that may host and streams itself; never a streamer for
 * another session. The renter seated with that ticket is marked as playing
 * that session, so only a `game-started` for it reaches them. A host not in
 * the room misses it, and the renter's page stays on Launching, offering
 * another machine past 90 s: the stream is never shown before `game-started`.
 */
function pushLaunch(hostId: string, sessionId: string, appid: number, ticketId: string): void {
  const room = rooms.get(hostId);
  if (room?.client?.ticketId === ticketId) room.client.sessionId = sessionId;
  const host = room?.host;
  if (host && (host.sessionId === sessionId || mayHost(host))) {
    send(host, { type: "launch-game", sessionId, appid });
  }
}

/**
 * True when `msg` from `ws` may reach `renter`: a `game-started` only from the
 * host, for the session the renter's page started, by a host that may serve it.
 */
function forRenterSession(ws: PeerSocket, renter: PeerSocket, msg: SignalMessage): boolean {
  if (msg.type !== "game-started") return true;
  if (ws.role !== "host" || typeof msg.sessionId !== "string") return false;
  return renter.sessionId === msg.sessionId && (ws.sessionId === null || ws.sessionId === msg.sessionId);
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
// server's. Any origin may, because the only credential is the machine key or
// host certificate in the Authorization header: no cookie or other ambient credential rides along,
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
 * background service with its machine key or host certificate; see protocol.ts
 * for the routes.
 * Resolves false without responding if `urlPath` does not match, otherwise true
 * after responding, including refusals. `urlPath` is the encoded URL pathname.
 * Starting requires a credential that may host and the machine's claimed
 * platform session id, and closes the PC service's socket; ending revokes the session's keys and closes its registered
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
  const token = bearer(req);
  const credential = attestation.credential(hostId, token);
  if (!credential) {
    json(res, 401, { error: looksLikeHostCert(token) ? "bad-host-cert" : "bad-machine-key" });
    return;
  }

  // Ending is control as well as hosting: the owner's confirmed end-early.
  if (req.method === "DELETE") {
    await endHostSession(hostId);
    json(res, 204);
    return;
  }

  // Starting mints the session keys a streamer serves the renter with: hosting.
  if (credential.hosting === null) {
    json(res, 403, { error: "attestation-required" });
    return;
  }
  // A host certificate starts one session: the machine attests again for the next.
  if (credential.kind === "host-cert" && credential.spent) {
    json(res, 401, { error: "bad-host-cert" });
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
  // Spent before the start, so two starts racing on one certificate get one session.
  if (!attestation.spend(credential)) {
    json(res, 401, { error: "bad-host-cert" });
    return;
  }
  const grant = await sessions.start(hostId, sessionId);
  if (!grant) {
    json(res, 409, { error: "session-active" });
    return;
  }
  // From here the room belongs to the session. The PC service's socket is put
  // out now rather than left serving until the streamer arrives.
  if (rooms.get(hostId)?.host?.sessionId === null) evictHost(hostId, "session-active");
  json(res, 201, grant);
}

// --- static files -----------------------------------------------------------

/**
 * The game catalog: Steam's most played games for the signed-out wall, with
 * which of the wall's own nine (`wall`, by appid with its launcher account) the page may stand in when
 * Steam is down, and names plus trailers for any appids (a signed-in library),
 * only ever games Swiff can run (playable.ts), each with the launcher account
 * it asks for at start. Keyless and cached in catalog.ts; a Steam outage
 * answers an empty list.
 */
async function serveCatalog(res: ServerResponse, urlPath: string, query: URLSearchParams): Promise<boolean> {
  const playable = (appid: number) => playability.playable(appid);
  let games: Promise<CatalogGame[]>;
  let extra = {};
  if (urlPath === "/api/games/popular") {
    games = popularGames(undefined, playable);
    extra = {
      wall: withAccounts(
        WALL_APPIDS.filter(playable).map((appid) => ({ appid })),
        playability,
      ),
    };
  } else if (urlPath === "/api/games/media") {
    games = gamesMedia((query.get("appids") ?? "").split(",").map(Number), playable);
  } else return false;

  const listed = await games.catch(() => null);
  if (!listed) {
    // A failed read is not an empty catalogue: the page keeps what it has.
    res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "the catalogue cannot be read right now" }));
    return true;
  }
  const body = JSON.stringify({ games: withAccounts(listed, playability), ...extra });
  // Never reused by a browser: it follows the verdicts, which may change at any
  // check. The server's own cache spares Steam.
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
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
      // Exactly one credential, a string, as protocol.ts says; the frame is
      // only asserted to be a RegisterMessage. Anything else is refused for
      // the credential it names, and never registered.
      const given = [msg.key, msg.hostCert, msg.sessionKey].filter((c) => c !== undefined);
      const badRental =
        msg.rental !== undefined && (msg.sessionKey !== undefined || typeof msg.rental !== "boolean");
      if (given.length !== 1 || typeof given[0] !== "string" || badRental) {
        if (msg.hostCert !== undefined) return deny(ws, "bad-host-cert");
        return deny(ws, msg.sessionKey !== undefined ? "bad-session-key" : "bad-machine-key");
      }
      let sessionId: string | null = null;
      let tier: HostingTier | null = null;
      let certExp: number | null = null;
      if (msg.sessionKey !== undefined) {
        // The streamer: the key must name this room and its session be live.
        const key = sessions ? await sessions.verify(msg.sessionKey) : null;
        if (!key || key.room !== msg.hostId) return deny(ws, "bad-session-key");
        sessionId = key.session;
      } else {
        // The PC service, with the machine key or a host certificate. Its socket
        // hears claims and gets TURN, so it must be a credential that may host.
        const hostCert = msg.hostCert !== undefined;
        const credential = attestation.credential(msg.hostId, hostCert ? msg.hostCert : msg.key);
        if (credential?.kind !== (hostCert ? "host-cert" : "machine-key")) {
          return deny(ws, hostCert ? "bad-host-cert" : "bad-machine-key");
        }
        // A certificate that has started a session registers nothing more.
        if (credential.kind === "host-cert" && credential.spent) return deny(ws, "bad-host-cert");
        if (credential.hosting === null) return deny(ws, "attestation-required");
        tier = credential.hosting;
        if (credential.kind === "host-cert") certExp = credential.exp;
        // The service never displaces a renter's session, live streamer or
        // not: the room is the session's until the service ends it.
        if (await sessions?.isLive(msg.hostId)) return deny(ws, "session-active");
      }
      const room = roomFor(msg.hostId);
      // A reconnecting host replaces the stale socket rather than being
      // refused — otherwise a crashed host locks itself out of its own room.
      if (room.host && room.host !== ws) room.host.close(4000, "replaced by a newer host");
      ws.hostId = msg.hostId;
      ws.role = "host";
      ws.sessionId = sessionId;
      ws.tier = tier;
      ws.certExp = certExp;
      room.host = ws;
      // An expired certificate hosts nothing: the socket is put out, so it
      // never hears a claim, and the machine attests again to come back.
      if (certExp !== null) {
        const expired = () => {
          if (rooms.get(msg.hostId)?.host === ws) evictHost(msg.hostId, "bad-host-cert");
        };
        ws.certTimer = setTimeout(() => inTurn(ws, expired), certExp * 1000 - Date.now());
        ws.certTimer.unref?.();
      }
      // The PC is there for as long as this socket stays open.
      await platform.hostConnected(
        msg.hostId,
        tier === null ? undefined : msg.rental === true || tier !== "unattested",
      );
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
      // hears it again: the service only registers with no session live.
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
      const began = performance.now();
      const [revoked, running] = await Promise.all([
        platform.ticketRevoked(ticket.id),
        platform.ticketSession(ticket.id),
      ]);
      if (revoked) revoke(ticket.id);
      // Revoked in the database, or by a notice while the database was asked.
      if (revokedTickets.has(ticket.id)) {
        // A renter still seated on it is put out too.
        const seated = rooms.get(ticket.room)?.client;
        if (seated && seatRevoked(seated)) putOut(seated);
        return deny(ws, "bad-ticket");
      }
      // Run out while the database was asked: nothing changes for it.
      if (ticket.exp * 1000 <= Date.now()) return deny(ws, "bad-ticket");
      const room = roomFor(ticket.room);
      if (room.client && room.client !== ws) {
        // The same ticket again is the same renter refreshing: hand them the
        // seat, and the socket it had stops for good rather than joining again
        // to take it back. A different ticket is somebody else, and the seat is taken.
        if (room.client.ticketId !== ticket.id) return deny(ws, "room-taken");
        deny(room.client, "replaced");
      }
      ws.hostId = ticket.room;
      ws.role = "client";
      ws.ticketId = ticket.id;
      ws.inSession = running !== null;
      confirm(ws, began);
      room.client = ws;
      // A renter back within the reconnect grace keeps their session.
      grace.cancel(ticket.room, ticket.id);
      send(ws, { type: "joined", hostId: ticket.room, hostOnline: Boolean(room.host), ...iceServers() });
      send(room.host, { type: "peer-joined" });
      return;
    }

    default:
      return;
  }
}

/**
 * The most frames one socket may have waiting to be handled. A handshake sends
 * a few dozen at most; only frames held for the database pile up past that.
 */
const MAX_QUEUED_FRAMES = 64;

const server = createServer(serveStatic);
const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES });

/** Handle `work` for `ws` once everything it sent before has been: frames and close, in order. */
function inTurn(ws: PeerSocket, work: () => Promise<void> | void): void {
  ws.turn = ws.turn.then(work).catch((error: unknown) => {
    console.error("[swiff] signaling failed:", error instanceof Error ? error.name : typeof error);
  });
}

/** How long a relayed frame waits before its ticket is read again, when the database could not say. */
const RELAY_RETRY_MS = 1_000;

/** A read of whether one ticket is revoked: when it began (performance.now() ms; Infinity until it has), and its answer. */
type TicketRead = { began: number; revoked: Promise<boolean> };

const noop = () => {};

/** Per ticket, the latest read asked for by a relayed frame, until it settles. */
const ticketReads = new Map<string, TicketRead>();

/**
 * A read of whether `ticketId` is revoked that began after `arrived`
 * (performance.now() ms). Shared: a read already begun after `arrived`, or
 * queued and not yet begun, answers for it; otherwise a new one is queued
 * behind the one in flight. So a burst of frames costs at most one read in
 * flight and one queued per ticket, from either side of the room.
 */
function ticketReadAfter(ticketId: string, arrived: number): TicketRead {
  const latest = ticketReads.get(ticketId);
  if (latest && latest.began > arrived) return latest;
  const read: TicketRead = { began: Infinity, revoked: Promise.resolve(false) };
  const before = latest ? latest.revoked.then(noop, noop) : Promise.resolve();
  read.revoked = before.then(() => {
    read.began = performance.now();
    return platform.ticketRevoked(ticketId);
  });
  const forget = () => {
    if (ticketReads.get(ticketId) === read) ticketReads.delete(ticketId);
  };
  read.revoked.then(forget, forget);
  ticketReads.set(ticketId, read);
  return read;
}

/**
 * Forward `msg`, which arrived from `ws` at `arrived` (performance.now() ms),
 * verbatim to its peer. The server does not read the payload, but offers,
 * answers and ICE candidates carry addresses, so none goes to or from a renter
 * until a database read begun after the frame arrived has found the renter's
 * ticket not revoked: a ticket revoked behind the server's back is caught by
 * the next frame. One read covers every frame that arrived before it began,
 * from either socket (ticketReadAfter). A revoked renter is put out and the frame dropped. While the database cannot
 * say, the frame is held, with the frames behind it, and the read retried,
 * until it can, or either side leaves the room. Never rejects.
 */
async function relay(ws: PeerSocket, msg: SignalMessage, arrived: number): Promise<void> {
  // Steam sign-in goes from the PC to its renter, but for the renter's retry, which goes only to the PC.
  if (msg.type === "steam-login" && (ws.role === "host") === (msg.state === "retry")) return;
  const peer = peerOf(ws);
  if (!peer) return;
  const renter = ws.role === "client" ? ws : peer;
  const ticketId = renter.ticketId;
  if (!ticketId) return;
  while (!seatRevoked(renter) && renter.confirmedAt <= arrived) {
    if (ws.readyState !== ws.OPEN || peer.readyState !== peer.OPEN || peerOf(ws) !== peer) return;
    const read = ticketReadAfter(ticketId, arrived);
    try {
      if (await read.revoked) putOut(renter);
      else confirm(renter, read.began);
    } catch (error) {
      console.error("[swiff] ticket check failed:", error instanceof Error ? error.name : typeof error);
      await new Promise((resolve) => setTimeout(resolve, RELAY_RETRY_MS));
    }
  }
  if (seatRevoked(renter) || peerOf(ws) !== peer || !forRenterSession(ws, renter, msg)) return;
  send(peer, msg);
}

/** One frame from `ws`, which arrived at `arrived` (performance.now() ms): relayed to its peer, or answered. */
async function onMessage(ws: PeerSocket, raw: RawData, arrived: number): Promise<void> {
  let msg: SignalMessage;
  try {
    msg = JSON.parse(String(raw)) as SignalMessage;
  } catch {
    return; // garbage in, ignored — never crash the room over one bad frame
  }

  if (isRelayed(msg)) return relay(ws, msg, arrived);

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
  send(peer, wasHost ? { type: "peer-left" } : renterLeft(ws));
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
  ws.inSession = false;
  ws.confirmedAt = 0;
  ws.sessionId = null;
  ws.tier = null;
  ws.certExp = null;
  ws.certTimer = null;
  ws.missedBeats = 0;
  ws.turn = Promise.resolve();
  ws.queued = 0;
  ws.dropped = 0;

  // An oversized or malformed frame surfaces here, and ws closes the socket
  // itself. Unhandled, the same error would take the whole process down.
  ws.on("error", () => {});

  // A frame that waits on the database holds back the ones after it, and the
  // close: a register is done before the offer behind it is relayed, and a
  // socket that closes mid-register is seated before it gives the seat up. A
  // socket that speaks is there the moment its frame arrives, so one held for
  // the database never costs it its heartbeat.
  // A socket that keeps sending while its frames are held is not buffered
  // without end: past MAX_QUEUED_FRAMES, what it sends is dropped, never
  // relayed unchecked, and the seat is kept.
  ws.on("message", (raw) => {
    const arrived = performance.now();
    ws.missedBeats = 0;
    if (ws.queued >= MAX_QUEUED_FRAMES) {
      ws.dropped += 1;
      return;
    }
    ws.queued += 1;
    inTurn(ws, async () => {
      try {
        await onMessage(ws, raw, arrived);
      } finally {
        ws.queued -= 1;
        if (!ws.queued && ws.dropped) {
          console.error(
            `[swiff] dropped ${ws.dropped} frames a socket sent while ${MAX_QUEUED_FRAMES} waited`,
          );
          ws.dropped = 0;
        }
      }
    });
  });
  ws.on("close", () => {
    if (ws.certTimer) clearTimeout(ws.certTimer);
    inTurn(ws, () => onClose(ws));
  });
});

/**
 * Check every seated renter's ticket with the database in one read: a revoked
 * one is recorded and put out, even one that sends nothing, and every other
 * seat counts as confirmed now. When the database cannot say, every renter
 * keeps its seat through the blip (its relayed frames wait for the database,
 * and the next round tries again) but for no longer than MAX_UNCONFIRMED_MS
 * since its ticket was last confirmed: past that, the seat is closed without
 * `denied`, so the renter may come back once the database answers. Also
 * forgets revocations no ticket could still be in use for.
 */
async function reconcileSeats(): Promise<void> {
  const time = Date.now();
  for (const [ticketId, until] of revokedTickets) if (until <= time) revokedTickets.delete(ticketId);
  const now = performance.now();
  const seated = [...rooms.values()].flatMap((room) => (room.client?.ticketId ? [room.client] : []));
  if (!seated.length) return;
  try {
    for (const ticketId of await platform.ticketsRevoked(seated.map((client) => client.ticketId!))) {
      revoke(ticketId);
    }
  } catch (error) {
    console.error("[swiff] ticket check failed:", error instanceof Error ? error.name : typeof error);
    const stale = seated.filter((client) => now - client.confirmedAt >= MAX_UNCONFIRMED_MS);
    if (stale.length) {
      console.error(
        `[swiff] tickets unconfirmed for ${MAX_UNCONFIRMED_MS / 1000} s: closing ${stale.length} seat(s)`,
      );
      for (const client of stale) client.close(1011, "ticket unconfirmed");
    }
    return;
  }
  for (const client of seated) {
    if (seatRevoked(client)) putOut(client);
    else confirm(client, now);
  }
}

// The safety net under the session-end notice, for a ticket revoked where no
// notice is sent (straight in the database): every few seconds, so a revoked
// renter keeps its seat for that long at most while the database answers. One
// check at a time.
// SWIFF_TICKET_RECONCILE_MS shortens it for tests.
const TICKET_RECONCILE_MS = Number(process.env.SWIFF_TICKET_RECONCILE_MS) || 5_000;
/**
 * The longest a seated renter's ticket goes unconfirmed while the reconcile
 * cannot read the database, before the seat is closed: a blip keeps every
 * seat, an outage does not keep a revoked one open for good.
 * SWIFF_TICKET_UNCONFIRMED_MS shortens it for tests.
 */
const MAX_UNCONFIRMED_MS = Number(process.env.SWIFF_TICKET_UNCONFIRMED_MS) || 5 * 60_000;
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
  for (const warning of attestationConfig.warnings) console.warn(`[swiff] ${warning}`);
  // Only where a machine can attest is a missing state key secret news.
  if (attestationConfig.verifier) {
    for (const warning of stateKeySecret.warnings) console.warn(`[swiff] ${warning}`);
  }
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
