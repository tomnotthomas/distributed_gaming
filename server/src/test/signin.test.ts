// The renter's sign-in session: the signed token, the cookie that carries it
// and how a request is read back to a Steam id. api.test.ts covers the routes
// that require it.

import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, describe, it } from "node:test";
import {
  mintRenterSession,
  mintSessionKey,
  mintTicket,
  parseMachineOwners,
  verifyRenterSession,
} from "../access.js";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  clearedCookie,
  createSteamAuth,
  renterOf,
  sessionCookie,
  sessionSecretFromEnv,
} from "../signin.js";

const SECRET = "a-session-secret-that-is-at-least-32-chars";
const STEAM_ID = "76561198000000001";
const NOW = 1_700_000_000_000;

/** A request carrying only this Cookie header. */
const request = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } }) as IncomingMessage;

/** The `name=value` part of a Set-Cookie value. */
const pair = (setCookie: string) => setCookie.split(";")[0]!;

describe("renter session tokens", () => {
  it("round-trips the Steam id and expiry", () => {
    const session = verifyRenterSession(SECRET, mintRenterSession(SECRET, STEAM_ID, 600, NOW), NOW);
    assert.deepEqual(session, { steamId: STEAM_ID, exp: NOW / 1000 + 600 });
  });

  it("expires at its expiry time", () => {
    const token = mintRenterSession(SECRET, STEAM_ID, 60, NOW);
    assert.ok(verifyRenterSession(SECRET, token, NOW + 59_000));
    assert.equal(verifyRenterSession(SECRET, token, NOW + 60_000), null);
  });

  it("refuses another secret, a tampered payload and garbage", () => {
    assert.equal(verifyRenterSession(SECRET, mintRenterSession(`${SECRET}-other`, STEAM_ID, 600)), null);
    const [, signature] = mintRenterSession(SECRET, STEAM_ID, 600).split(".");
    const [payload] = mintRenterSession(SECRET, "76561198000000002", 600).split(".");
    assert.equal(verifyRenterSession(SECRET, `${payload}.${signature}`), null);
    for (const junk of [undefined, 42, "", "a.b", "a.b.c"])
      assert.equal(verifyRenterSession(SECRET, junk), null);
  });

  it("is never a join ticket or a session key signed with the same secret, nor they it", () => {
    assert.equal(verifyRenterSession(SECRET, mintTicket(SECRET, STEAM_ID, 600)), null);
    assert.equal(
      verifyRenterSession(SECRET, mintSessionKey(SECRET, { room: STEAM_ID, session: "s", grant: "g" }, 600)),
      null,
    );
  });

  it("refuses a session that names something other than a Steam id", () => {
    assert.equal(verifyRenterSession(SECRET, mintRenterSession(SECRET, "pc-1", 600)), null);
  });
});

describe("sessionSecretFromEnv", () => {
  const ROOM_SECRET = "a-room-secret-that-is-at-least-32-chars!";

  it("takes a long enough SESSION_SECRET", () => {
    assert.equal(sessionSecretFromEnv({ SESSION_SECRET: ` ${SECRET} `, ROOM_SECRET }), SECRET);
  });

  it("refuses one that is missing, short or the same as ROOM_SECRET", () => {
    assert.equal(sessionSecretFromEnv({ ROOM_SECRET }), null);
    assert.equal(sessionSecretFromEnv({ SESSION_SECRET: "short", ROOM_SECRET }), null);
    assert.equal(sessionSecretFromEnv({ SESSION_SECRET: ROOM_SECRET, ROOM_SECRET }), null);
  });
});

describe("the session cookie", () => {
  it("is HttpOnly, SameSite=Lax, site-wide and lasts as long as the session", () => {
    const cookie = sessionCookie(SECRET, STEAM_ID, "https://swiff.example", NOW);
    assert.ok(cookie.startsWith(`${SESSION_COOKIE}=`));
    for (const attribute of [
      "HttpOnly",
      "SameSite=Lax",
      "Path=/",
      `Max-Age=${SESSION_TTL_SECONDS}`,
      "Secure",
    ]) {
      assert.ok(cookie.split("; ").includes(attribute), attribute);
    }
  });

  it("is Secure only where the site is served over https", () => {
    assert.ok(!sessionCookie(SECRET, STEAM_ID, "http://localhost:8080").includes("Secure"));
    assert.ok(clearedCookie("https://swiff.example").includes("; Secure"));
  });

  it("is read back to the renter it signed in", () => {
    const cookie = pair(sessionCookie(SECRET, STEAM_ID, "https://swiff.example", NOW));
    assert.equal(renterOf(request(cookie), SECRET, NOW), STEAM_ID);
    assert.equal(renterOf(request(`theme=dark; ${cookie}; other=1`), SECRET, NOW), STEAM_ID);
  });

  it("signs nobody in once expired, cleared, forged or without a secret", () => {
    const cookie = pair(sessionCookie(SECRET, STEAM_ID, "https://swiff.example", NOW));
    assert.equal(renterOf(request(cookie), SECRET, NOW + SESSION_TTL_SECONDS * 1000), null);
    assert.equal(renterOf(request(pair(clearedCookie("https://swiff.example"))), SECRET, NOW), null);
    assert.equal(renterOf(request(`${SESSION_COOKIE}=forged.value`), SECRET, NOW), null);
    assert.equal(renterOf(request(cookie), null, NOW), null);
    assert.equal(renterOf(request(), SECRET, NOW), null);
  });

  it("clears with an empty value that expires at once", () => {
    const cleared = clearedCookie("http://localhost:8080");
    assert.equal(pair(cleared), `${SESSION_COOKIE}=`);
    assert.ok(cleared.includes("Max-Age=0"));
  });
});

describe("parseMachineOwners", () => {
  const HASH = "a".repeat(64);

  it("reads the owner's Steam id from each MACHINE_KEYS entry that names one", () => {
    const owners = parseMachineOwners(`pc-1:${HASH}:${STEAM_ID}, pc-2:${HASH}, pc-3:${HASH}:not-a-steam-id`);
    assert.deepEqual([...owners], [["pc-1", STEAM_ID]]);
  });

  it("skips an owner on an entry whose key is malformed", () => {
    assert.equal(parseMachineOwners(`pc-1:nothex:${STEAM_ID}`).size, 0);
  });
});

describe("Steam sign-in", () => {
  const ORIGIN = "https://swiff.example";
  const realFetch = globalThis.fetch;
  let steamAsked = 0;
  let server: Server;
  let port: number;
  let auth: ReturnType<typeof createSteamAuth>;

  before(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!(await auth(res, url.pathname, url.searchParams))) res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
    // Steam vouches for every assertion: only our own checks can refuse one.
    globalThis.fetch = (async () => {
      steamAsked += 1;
      return { ok: true, text: async () => "is_valid:true\n" };
    }) as unknown as typeof fetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
    server.close();
  });

  afterEach(() => {
    steamAsked = 0;
  });

  /** GET `path` with `headers`, answering the status and headers without following redirects. */
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<IncomingMessage>((resolve, reject) => {
      httpRequest({ host: "127.0.0.1", port, path, headers }, (res) => resolve(res.resume()))
        .on("error", reject)
        .end();
    });

  /** The return route as Steam would call it, for an assertion made for `site`. */
  const returnPath = (site: string, to = "/games") =>
    `/auth/steam/return?${new URLSearchParams({
      to,
      "openid.op_endpoint": "https://steamcommunity.com/openid/login",
      "openid.return_to": `${site}/auth/steam/return?to=%2Fgames`,
      "openid.claimed_id": `https://steamcommunity.com/openid/id/${STEAM_ID}`,
      "openid.sig": "abc",
    })}`;

  const spoofed = {
    host: "other.example",
    "x-forwarded-host": "other.example",
    "x-forwarded-proto": "https",
  };

  it("refuses another site's assertion however the request names its host", async () => {
    auth = createSteamAuth({ origin: ORIGIN, sessionSecret: SECRET });
    const res = await get(returnPath("https://other.example"), spoofed);
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, `${ORIGIN}/games#steam=denied`);
    assert.equal(res.headers["set-cookie"], undefined);
    assert.equal(steamAsked, 0);
  });

  it("signs in on the configured origin only, with its cookie attributes", async () => {
    auth = createSteamAuth({ origin: ORIGIN, sessionSecret: SECRET });
    const res = await get(returnPath(ORIGIN), { host: "localhost", "x-forwarded-proto": "http" });
    assert.equal(res.headers.location, `${ORIGIN}/games#steam=ok`);
    const [cookie] = res.headers["set-cookie"] ?? [];
    assert.ok(cookie?.includes("; Secure"));
    assert.equal(renterOf(request(pair(cookie!)), SECRET), STEAM_ID);
  });

  it("never redirects off the configured origin after sign-in", async () => {
    auth = createSteamAuth({ origin: ORIGIN, sessionSecret: SECRET });
    const res = await get(returnPath(ORIGIN, "//evil.example/steal"));
    assert.equal(res.headers.location, `${ORIGIN}/#steam=ok`);
  });

  it("refuses every sign-in when no public origin is configured", async () => {
    auth = createSteamAuth({ origin: null, sessionSecret: SECRET });
    for (const path of ["/auth/steam/login", returnPath("https://other.example")]) {
      const res = await get(path, spoofed);
      assert.equal(res.headers.location, "/#steam=denied");
      assert.equal(res.headers["set-cookie"], undefined);
    }
    assert.equal(steamAsked, 0);
  });

  it("sends the login to Steam with the configured origin as realm", async () => {
    auth = createSteamAuth({ origin: ORIGIN, sessionSecret: SECRET });
    const res = await get("/auth/steam/login?to=%2Fgames", spoofed);
    const steam = new URL(res.headers.location!);
    assert.equal(steam.searchParams.get("openid.realm"), ORIGIN);
    assert.equal(steam.searchParams.get("openid.return_to"), `${ORIGIN}/auth/steam/return?to=%2Fgames`);
  });
});
