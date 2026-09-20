/* Serverless adapter. Same stateless logic as server.mjs, so behaviour does
 * not change between a laptop and a deploy. vercel.json routes /auth/steam*
 * here; everything else is served as a static file.
 */
import { loginUrl, returnUrl, originFrom } from "../steam-auth.mjs";

const API_KEY = process.env.STEAM_API_KEY || "";

export default async function handler(req, res) {
  const origin = originFrom(req.headers, "http://localhost:8777");
  const url = new URL(req.url, origin);

  try {
    if (url.pathname === "/auth/steam") {
      res.writeHead(302, {
        location: loginUrl({
          origin,
          returnTo: url.searchParams.get("return"),
          did: url.searchParams.get("did"),
        }),
        "cache-control": "no-store",
      });
      return res.end();
    }
    if (url.pathname === "/auth/steam/return") {
      res.writeHead(302, {
        location: await returnUrl({ origin, searchParams: url.searchParams, apiKey: API_KEY }),
        "cache-control": "no-store",
      });
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ apiKey: Boolean(API_KEY), origin }));
  } catch (err) {
    console.error("[swiff]", err);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "server error" }));
  }
}
