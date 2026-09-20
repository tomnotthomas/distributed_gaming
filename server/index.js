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

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8080);
const STATIC_DIR = fileURLToPath(new URL("../web/dist/", import.meta.url));

// Cloudflare closes an idle WebSocket after 100s. Both peers ping every 25s;
// this server drops a socket that misses two rounds so a crashed host does not
// hold its room forever.
const HEARTBEAT_MS = 25_000;
const HEARTBEAT_MISSES = 2;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** @type {Map<string, { host: import("ws").WebSocket | null, client: import("ws").WebSocket | null }>} */
const rooms = new Map();

function roomFor(hostId) {
  let room = rooms.get(hostId);
  if (!room) {
    room = { host: null, client: null };
    rooms.set(hostId, room);
  }
  return room;
}

/** The other socket in the same room, or null when the peer has not arrived. */
function peerOf(ws) {
  const room = rooms.get(ws.hostId);
  if (!room) return null;
  return ws.role === "host" ? room.client : room.host;
}

function send(ws, message) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

// --- static files -----------------------------------------------------------

async function serveStatic(req, res) {
  // Both routes are the same SPA: "/" is the renter, "/host" is the gaming PC.
  const urlPath = new URL(req.url, "http://localhost").pathname;
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

wss.on("connection", (ws) => {
  ws.hostId = null;
  ws.role = null;
  ws.missedBeats = 0;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // garbage in, ignored — never crash the room over one bad frame
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
        send(ws, { type: "registered", hostId: msg.hostId });
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
        send(ws, { type: "joined", hostId: msg.hostId, hostOnline: Boolean(room.host) });
        send(room.host, { type: "peer-joined" });
        return;
      }

      case "offer":
      case "answer":
      case "ice": {
        // Relayed verbatim. The server does not read the payload.
        const peer = peerOf(ws);
        if (peer) send(peer, msg);
        return;
      }

      default:
        return;
    }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.hostId);
    if (!room) return;
    if (room.host === ws) room.host = null;
    if (room.client === ws) room.client = null;
    send(peerOf(ws), { type: "peer-left" });
    if (!room.host && !room.client) rooms.delete(ws.hostId);
  });
});

// Server-side liveness sweep. Without it a host whose machine slept keeps its
// room and the next renter joins a socket that will never answer.
const sweep = setInterval(() => {
  for (const ws of wss.clients) {
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
