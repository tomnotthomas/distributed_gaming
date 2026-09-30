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
// While a renter's session runs, the room is registered by the streamer in the
// renter's Windows account with a short-lived session key instead, and the
// machine key cannot register it at all. See sessions.ts.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
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
import { createHostSessions } from "./sessions.js";
import { gamesMedia, popularGames } from "./catalog.js";
import { loginUrl, originFrom, returnUrl } from "./steam.js";

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

// Session keys are signed with ROOM_SECRET too, so without it no session can
// start and the machine key is the only way to register.
const sessions = access.secret ? createHostSessions(access.secret) : null;

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
};

type Room = { host: PeerSocket | null; client: PeerSocket | null };

const rooms = new Map<string, Room>();

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
 */
function evictHost(hostId: string, reason: DeniedMessage["reason"]): void {
  const room = rooms.get(hostId);
  const host = room?.host;
  if (!room || !host) return;
  room.host = null;
  send(room.client, { type: "peer-left" });
  if (!room.client) rooms.delete(hostId);
  deny(host, reason);
}

// --- host sessions ----------------------------------------------------------

const SESSION_ROUTE = /^\/api\/machines\/([^/]+)\/session$/;

/** End the response with uncached JSON, or just the status when no body is supplied. */
function json(res: ServerResponse, status: number, body?: SessionGrant | SessionError): void {
  if (!body) {
    res.writeHead(status).end();
    return;
  }
  // A session key is a credential: nothing between here and the PC may keep it.
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** The bearer credential, or null. Never logged. */
function bearer(req: IncomingMessage): string | null {
  const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
  return match?.[1] ?? null;
}

/**
 * Start and end a renter's session on one gaming PC. Called by the PC's
 * background service with its machine key; see protocol.ts for the routes.
 * Returns false without responding if `urlPath` does not match, otherwise true
 * after responding, including refusals. `urlPath` is the encoded URL pathname.
 * Starting closes any machine-key host; ending revokes the session's keys and
 * closes its registered host. Ending an absent session still succeeds.
 */
function serveSessions(req: IncomingMessage, res: ServerResponse, urlPath: string): boolean {
  const match = SESSION_ROUTE.exec(urlPath);
  if (!match) return false;

  let hostId: string;
  try {
    hostId = decodeURIComponent(match[1]!);
  } catch {
    json(res, 404, { error: "not-found" });
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
  if (!verifyMachineKey(access.machines, hostId, bearer(req))) {
    json(res, 401, { error: "bad-machine-key" });
    return true;
  }

  if (req.method === "DELETE") {
    const ended = sessions.end(hostId);
    // Every key of the session is dead now; the streamer registered with one is
    // hung up on too, so ending a session really does hand the room back.
    if (ended && rooms.get(hostId)?.host?.sessionId === ended) evictHost(hostId, "session-ended");
    json(res, 204);
    return true;
  }

  const grant = sessions.start(hostId);
  if (!grant) {
    json(res, 409, { error: "session-active" });
    return true;
  }
  // From here the room belongs to the session. A host registered with the
  // machine key is put out now rather than left serving until the streamer
  // arrives.
  if (rooms.get(hostId)?.host?.sessionId === null) evictHost(hostId, "session-active");
  json(res, 201, grant);
  return true;
}

// --- static files -----------------------------------------------------------

/**
 * Steam sign-in. Two redirects and no state: `/auth/steam/login` bounces to
 * Steam, `/auth/steam/return` verifies what comes back and hands the profile to
 * the page in the URL fragment. STEAM_API_KEY never leaves this process.
 */
async function serveSteamAuth(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  query: URLSearchParams,
): Promise<boolean> {
  const origin = originFrom(req.headers, `http://localhost:${PORT}`);

  if (urlPath === "/auth/steam/login") {
    res.writeHead(302, { location: loginUrl({ origin, returnTo: query.get("to") ?? "/" }) }).end();
    return true;
  }

  if (urlPath === "/auth/steam/return") {
    // Any failure here still lands the player back on the wall, flagged, rather
    // than on an error page they cannot act on.
    const location = await returnUrl({
      origin,
      searchParams: query,
      apiKey: process.env.STEAM_API_KEY,
    }).catch(() => `${origin}/#steam=denied`);
    res.writeHead(302, { location }).end();
    return true;
  }

  return false;
}

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

  if (serveSessions(req, res, urlPath)) return;
  if (await serveSteamAuth(req, res, urlPath, url.searchParams)) return;
  if (await serveCatalog(res, urlPath, url.searchParams)) return;

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

const server = createServer(serveStatic);
const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES });

wss.on("connection", (socket) => {
  const ws = socket as PeerSocket;
  ws.hostId = null;
  ws.role = null;
  ws.ticketId = null;
  ws.sessionId = null;
  ws.missedBeats = 0;

  // An oversized or malformed frame surfaces here, and ws closes the socket
  // itself. Unhandled, the same error would take the whole process down.
  ws.on("error", () => {});

  ws.on("message", (raw) => {
    let msg: SignalMessage;
    try {
      msg = JSON.parse(String(raw)) as SignalMessage;
    } catch {
      return; // garbage in, ignored — never crash the room over one bad frame
    }

    if (isRelayed(msg)) {
      // Forwarded verbatim. The server does not read the payload.
      send(peerOf(ws), msg);
      return;
    }

    switch (msg.type) {
      case "ping":
        ws.missedBeats = 0;
        send(ws, { type: "pong" });
        return;

      case "register": {
        if (ws.role) return; // one room per socket, decided once
        let sessionId: string | null = null;
        if ("sessionKey" in msg) {
          // The streamer: the key must name this room and its session be live.
          const key = sessions?.verify(msg.sessionKey);
          if (!key || key.room !== msg.hostId) return deny(ws, "bad-session-key");
          sessionId = key.session;
        } else {
          if (!verifyMachineKey(access.machines, msg.hostId, msg.key)) return deny(ws, "bad-machine-key");
          // The machine key never displaces a renter's session, live streamer
          // or not: the room is the session's until the service ends it.
          if (sessions?.isLive(msg.hostId)) return deny(ws, "session-active");
        }
        const room = roomFor(msg.hostId);
        // A reconnecting host replaces the stale socket rather than being
        // refused — otherwise a crashed host locks itself out of its own room.
        if (room.host && room.host !== ws) room.host.close(4000, "replaced by a newer host");
        ws.hostId = msg.hostId;
        ws.role = "host";
        ws.sessionId = sessionId;
        room.host = ws;
        send(ws, { type: "registered", hostId: msg.hostId, ...iceServers() });
        // A client that arrived first is still waiting; tell the host now.
        if (room.client) send(ws, { type: "peer-joined" });
        return;
      }

      case "join": {
        if (ws.role) return;
        const ticket = access.secret ? verifyTicket(access.secret, msg.ticket) : null;
        if (!ticket) return deny(ws, "bad-ticket");
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
  });

  ws.on("close", () => {
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
    if (room.host === ws) room.host = null;
    if (room.client === ws) room.client = null;
    send(peer, { type: "peer-left" });
    if (!room.host && !room.client && ws.hostId) rooms.delete(ws.hostId);
  });
});

// Server-side liveness sweep. Without it a host whose machine slept keeps its
// room and the next renter joins a socket that will never answer.
const sweep = setInterval(() => {
  for (const socket of wss.clients) {
    const ws = socket as PeerSocket;
    if (ws.missedBeats >= HEARTBEAT_MISSES) {
      ws.terminate();
      continue;
    }
    ws.missedBeats += 1;
  }
}, HEARTBEAT_MS);
sweep.unref?.();

server.listen(PORT, () => {
  console.log(`[swiff] http://localhost:${PORT}       (the wall)`);
  console.log(`[swiff] http://localhost:${PORT}/host  (gaming PC)`);
  console.log(`[swiff] http://localhost:${PORT}/rtc   (handshake demo)`);
  if (!access.secret) console.warn("[swiff] ROOM_SECRET missing or too short — no renter can join");
  if (!access.machines.size) console.warn("[swiff] MACHINE_KEYS empty — no gaming PC can register");
  // Warm the catalog so the first visitor's wall does not wait on Steam.
  void popularGames();
});

// Not awaited before listening: minting talks to a third party, and the LAN
// case needs no relay at all. Peers that register before the first credential
// lands simply get none, exactly as they would with no TURN configured.
void ice.start();
