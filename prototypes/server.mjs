/* Local runner for the prototypes: static files plus the Steam endpoints.
 *
 * The auth logic lives in steam-auth.mjs and holds no state, so this file and
 * the serverless adapter in api/steam.mjs behave identically.
 *
 *   STEAM_API_KEY=xxx node server.mjs
 *
 * Without STEAM_API_KEY the OpenID round trip still works and yields a verified
 * SteamID, but the persona, avatar and library come back empty.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { loginUrl, returnUrl, originFrom } from "./steam-auth.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 8777);
const API_KEY = process.env.STEAM_API_KEY || "";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function send(res, status, type, body) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

async function serveStatic(res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(ROOT, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(ROOT)) return send(res, 403, "text/plain", "forbidden");
  try {
    send(res, 200, TYPES[extname(file)] || "application/octet-stream", await readFile(file));
  } catch {
    send(res, 404, "text/plain", "not found");
  }
}

function redirect(res, location) {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

const server = createServer(async (req, res) => {
  const origin = originFrom(req.headers, `http://localhost:${PORT}`);
  const url = new URL(req.url || "/", origin);
  try {
    if (url.pathname === "/auth/steam") {
      return redirect(res, loginUrl({ origin, returnTo: url.searchParams.get("return") }));
    }
    if (url.pathname === "/auth/steam/return") {
      return redirect(res, await returnUrl({ origin, searchParams: url.searchParams, apiKey: API_KEY }));
    }
    if (url.pathname === "/auth/steam/status") {
      return send(res, 200, TYPES[".json"], JSON.stringify({ apiKey: Boolean(API_KEY), origin }));
    }
    // Shareable URLs, matching the rewrites in vercel.json.
    const ALIAS = { "/": "/Swiff v7.dc.html", "/play": "/Swiff v7.dc.html", "/host": "/Swiff Host.dc.html" };
    await serveStatic(res, ALIAS[url.pathname] || url.pathname);
  } catch (err) {
    console.error("[swiff]", err);
    send(res, 500, TYPES[".json"], JSON.stringify({ error: "server error" }));
  }
});

server.listen(PORT, () => {
  console.log(`[swiff] prototypes on http://localhost:${PORT}`);
  console.log(`[swiff] steam web api key: ${API_KEY ? "set" : "MISSING (sign-in works, library will be empty)"}`);
});
