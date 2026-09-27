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
// Phase 1 has one hardcoded room and no auth: anyone who knows the id can
// join. That is fine while both machines are ours and wrong the moment a
// second machine exists. See docs/phase-1/plan.md, "Open questions".

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { turnServersFromEnv } from "./ice.js";
import { isRelayed, type SignalMessage } from "./protocol.js";

const PORT = Number(process.env.PORT ?? 8080);

// Sent to both peers on register/join. Omitted entirely when unset, so a
// server with no TURN behaves exactly as before.
const TURN_SERVERS = turnServersFromEnv(process.env);
const iceServers = TURN_SERVERS.length ? { iceServers: TURN_SERVERS } : {};

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

/** The other socket in the same room, or null when the peer has not arrived. */
function peerOf(ws: PeerSocket): PeerSocket | null {
  const room = ws.hostId ? rooms.get(ws.hostId) : undefined;
  if (!room) return null;
  return ws.role === "host" ? room.client : room.host;
}

function send(ws: PeerSocket | null, message: SignalMessage): void {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

// --- static files -----------------------------------------------------------

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Both routes are the same SPA: "/" is the renter, "/host" is the gaming PC.
  const urlPath = new URL(req.url ?? "/", "http://localhost").pathname;
  const candidate = urlPath === "/" || urlPath === "/host" ? "index.html" : urlPath.slice(1);

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
const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  const ws = socket as PeerSocket;
  ws.hostId = null;
  ws.role = null;
  ws.missedBeats = 0;

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
        if (!msg.hostId) return;
        const room = roomFor(msg.hostId);
        // A reconnecting host replaces the stale socket rather than being
        // refused — otherwise a crashed host locks itself out of its own room.
        if (room.host && room.host !== ws) room.host.close(4000, "replaced by a newer host");
        ws.hostId = msg.hostId;
        ws.role = "host";
        room.host = ws;
        send(ws, { type: "registered", hostId: msg.hostId, ...iceServers });
        // A client that arrived first is still waiting; tell the host now.
        if (room.client) send(ws, { type: "peer-joined" });
        return;
      }

      case "join": {
        if (!msg.hostId) return;
        const room = roomFor(msg.hostId);
        if (room.client && room.client !== ws) room.client.close(4001, "replaced by a newer client");
        ws.hostId = msg.hostId;
        ws.role = "client";
        room.client = ws;
        send(ws, { type: "joined", hostId: msg.hostId, hostOnline: Boolean(room.host), ...iceServers });
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
  console.log(`[swiff] http://localhost:${PORT}  (renter)`);
  console.log(`[swiff] http://localhost:${PORT}/host  (gaming PC)`);
});
