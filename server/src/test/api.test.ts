// The Booking and Host APIs over HTTP. Most tests run the handler in-process
// against a clock they move by hand; the last spawns the real server and
// proves the ticket a claim hands out opens the room over the WebSocket.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  mintRenterSession,
  mintTicket,
  parseMachineKeys,
  parseMachineOwners,
  verifyTicket,
  type Access,
} from "../access.js";
import { createApi } from "../api.js";
import { Platform, QUEUE_TIMEOUT_MS } from "../platform.js";
import { emptyProfile } from "../steam.js";
import type { SignalMessage } from "../protocol.js";
import { MAX_GAMES } from "../profile.js";
import { REPORT } from "./report.js";
import { SESSION_COOKIE } from "../signin.js";

const SECRET = "test-room-secret-that-is-long-enough-to-pass";
const MACHINE_KEY = "test-machine-key";
const HASH = createHash("sha256").update(MACHINE_KEY).digest("hex");
const SESSION = "test-session-secret-that-is-long-enough-too";
const RENTER = "76561198000000001";
const OTHER = "76561198000000002";
const OWNER = "76561198000000003";
// pc-3 belongs to OWNER: it must never be matched to OWNER's own bookings.
const MACHINE_KEYS = `pc-1:${HASH},pc-2:${HASH},pc-3:${HASH}:${OWNER}`;

/** The Cookie header of `steamId` signed in, with a session that lasts `ttlSeconds`. */
const signedIn = (steamId: string, ttlSeconds = 3600, secret = SESSION) =>
  `${SESSION_COOKIE}=${mintRenterSession(secret, steamId, ttlSeconds)}`;

type Reply = { status: number; body: any; headers: Headers };

/**
 * A JSON caller for `origin`, sending `cookie` (a renter's sign-in) with every
 * request when given one, and the machine key as a bearer token when given one.
 */
function client(origin: string, cookie?: string) {
  return async (method: string, path: string, body?: unknown, key?: string): Promise<Reply> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (key) headers.authorization = `Bearer ${key}`;
    if (cookie) headers.cookie = cookie;
    const response = await fetch(`${origin}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };
}

describe("booking and host API", () => {
  let now: number;
  let platform: Platform;
  let access: Access;
  let server: Server;
  let call: ReturnType<typeof client>;
  let renter: ReturnType<typeof client>;
  let as: (cookie: string) => ReturnType<typeof client>;

  before(async () => {
    access = {
      secret: SECRET,
      machines: parseMachineKeys(MACHINE_KEYS),
      owners: parseMachineOwners(MACHINE_KEYS),
    };
    const games = async () => [{ id: 730, name: "Counter-Strike 2", image: null }];
    const profile = async (steamId: string) => ({ ...emptyProfile(steamId), persona: "kai_nx" });
    server = createServer(async (req, res) => {
      // Built per request so each test's fresh platform is the one served.
      const api = createApi({
        platform,
        access,
        sessionSecret: SESSION,
        fallbackOrigin: "http://localhost",
        games,
        profile,
      });
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (!(await api(req, res, path))) res.writeHead(418).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    call = client(origin);
    as = (cookie) => client(origin, cookie);
    renter = as(signedIn(RENTER));
  });

  after(() => server.close());

  beforeEach(() => {
    now = Date.UTC(2026, 8, 30, 12);
    platform = new Platform({ now: () => now, owners: access.owners });
    access.secret = SECRET;
  });

  const offer = (id = "pc-1", body: object = { available: true, ...REPORT }) =>
    call("PUT", `/api/machines/${id}/availability`, body, MACHINE_KEY);

  it("lists the games that can be booked", async () => {
    const { status, body } = await call("GET", "/api/games");
    assert.equal(status, 200);
    assert.deepEqual(body, [{ id: 730, name: "Counter-Strike 2", image: null }]);
  });

  it("books, matches and claims, handing out a ticket for the matched room", async () => {
    const booked = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    assert.equal(booked.status, 202);
    assert.equal(booked.body.status, "queued");
    const id = booked.body.bookingId;

    assert.equal((await offer("pc-1", { available: true, ...REPORT, price: 120 })).status, 200);
    const matched = await renter("GET", `/api/bookings/${id}`);
    assert.equal(matched.body.status, "matched");
    assert.equal(matched.body.machine.id, "pc-1");
    assert.equal(matched.body.machine.gpu, REPORT.hardware.gpu);

    const claim = await renter("POST", `/api/bookings/${id}/claim`);
    assert.equal(claim.status, 200);
    assert.equal(claim.body.roomId, "pc-1");
    assert.match(claim.body.signalingUrl, /^ws:\/\/localhost:\d+$/);
    assert.equal(typeof claim.body.sessionId, "string");
    const ticket = verifyTicket(SECRET, claim.body.ticket);
    assert.equal(ticket?.room, "pc-1");
    assert.ok(ticket && Math.abs(ticket.exp * 1000 - (Date.now() + 30 * 60_000)) < 5_000);

    assert.equal((await renter("GET", `/api/bookings/${id}`)).body.status, "claimed");
    const beat = await call("POST", "/api/machines/pc-1/heartbeat", undefined, MACHINE_KEY);
    assert.deepEqual(beat.body.session, { id: claim.body.sessionId });

    const start = await call("POST", `/api/sessions/${claim.body.sessionId}/start`, undefined, MACHINE_KEY);
    assert.equal(start.status, 200);
    assert.equal((await renter("GET", `/api/bookings/${id}`)).body.status, "playing");
    const end = await call("POST", `/api/sessions/${claim.body.sessionId}/end`, {}, MACHINE_KEY);
    assert.equal(end.status, 200);
    assert.equal((await renter("GET", `/api/bookings/${id}`)).body.status, "ended");
    const again = await call("POST", `/api/sessions/${claim.body.sessionId}/end`, {}, MACHINE_KEY);
    assert.equal(again.status, 409);
  });

  it("answers 409 to a claim after the reservation has lapsed and the renter is gone", async () => {
    await offer();
    const { body } = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    now += QUEUE_TIMEOUT_MS;
    await call("POST", "/api/machines/pc-1/heartbeat", undefined, MACHINE_KEY);

    const claim = await renter("POST", `/api/bookings/${body.bookingId}/claim`);
    assert.equal(claim.status, 409);
    assert.equal(claim.body.status, "expired");
    assert.equal(claim.body.ticket, undefined);
  });

  it("answers 409 to a second claim and 404 to an unknown booking", async () => {
    await offer();
    const { body } = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    assert.equal((await renter("POST", `/api/bookings/${body.bookingId}/claim`)).status, 200);
    assert.equal((await renter("POST", `/api/bookings/${body.bookingId}/claim`)).status, 409);
    assert.equal((await renter("POST", "/api/bookings/nope/claim")).status, 404);
    assert.equal((await renter("GET", "/api/bookings/nope")).status, 404);
  });

  it("does not spend the reservation when no ticket can be minted", async () => {
    await offer();
    const { body } = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    access.secret = null;
    assert.equal((await renter("POST", `/api/bookings/${body.bookingId}/claim`)).status, 503);
    assert.equal((await renter("GET", `/api/bookings/${body.bookingId}`)).body.status, "matched");
  });

  it("refuses the Host API without the machine's own key", async () => {
    assert.equal((await call("PUT", "/api/machines/pc-1/availability", { available: true })).status, 401);
    assert.equal(
      (await call("PUT", "/api/machines/pc-1/availability", { available: true }, "wrong")).status,
      401,
    );
    assert.equal((await call("POST", "/api/machines/pc-9/heartbeat", undefined, MACHINE_KEY)).status, 401);

    await offer();
    const { body } = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    const claim = await renter("POST", `/api/bookings/${body.bookingId}/claim`);
    const start = `/api/sessions/${claim.body.sessionId}/start`;
    assert.equal((await call("POST", start)).status, 401);
    assert.equal((await call("POST", start, undefined, "wrong")).status, 401);
    assert.equal((await call("POST", "/api/sessions/nope/start", undefined, MACHINE_KEY)).status, 404);
  });

  it("refuses to book, check on or claim without a live sign-in", async () => {
    await offer();
    const { body } = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    const [, signature] = mintRenterSession(SESSION, RENTER, 3600).split(".");
    const [payload] = mintRenterSession(SESSION, OTHER, 3600).split(".");
    const forged = `${SESSION_COOKIE}=${payload}.${signature}`;
    const refused = [
      signedIn(RENTER, -1), // expired
      signedIn(RENTER, 3600, `${SESSION}-other`), // signed with another secret
      forged, // another renter's id under this renter's signature
      `${SESSION_COOKIE}=${mintRenterSession(SECRET, RENTER, 3600)}`, // signed with ROOM_SECRET
    ];
    for (const caller of [call, ...refused.map(as)]) {
      assert.equal((await caller("POST", "/api/bookings", { gameId: 730, minutes: 30 })).status, 401);
      assert.equal((await caller("GET", `/api/bookings/${body.bookingId}`)).status, 401);
      assert.equal((await caller("POST", `/api/bookings/${body.bookingId}/claim`)).status, 401);
      assert.equal((await caller("GET", "/api/me")).status, 401);
    }
    assert.equal((await renter("GET", `/api/bookings/${body.bookingId}`)).body.status, "matched");
  });

  it("shows and hands a booking only to the renter who made it", async () => {
    await offer();
    const { body } = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    const other = as(signedIn(OTHER));
    assert.equal((await other("GET", `/api/bookings/${body.bookingId}`)).status, 404);
    assert.equal((await other("POST", `/api/bookings/${body.bookingId}/claim`)).status, 404);
    assert.equal((await renter("POST", `/api/bookings/${body.bookingId}/claim`)).status, 200);
  });

  it("never matches a renter to a machine they own", async () => {
    await offer("pc-3", { available: true, ...REPORT, price: 50 });
    const owner = as(signedIn(OWNER));
    const own = await owner("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    assert.equal(own.body.status, "queued");

    // Anybody else gets it, cheapest first, while the owner keeps waiting.
    const theirs = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    assert.equal(theirs.body.status, "matched");
    assert.equal(theirs.body.machine.id, "pc-3");

    await offer("pc-1", { available: true, ...REPORT, price: 120 });
    const matched = await owner("GET", `/api/bookings/${own.body.bookingId}`);
    assert.equal(matched.body.status, "matched");
    assert.equal(matched.body.machine.id, "pc-1");
  });

  it("tells the page who is signed in, and signs them out", async () => {
    const me = await renter("GET", "/api/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.steamId, RENTER);
    assert.equal(me.body.profile.persona, "kai_nx");
    assert.equal(me.headers.get("cache-control"), "no-store");

    const out = await renter("POST", "/api/signout");
    assert.equal(out.status, 204);
    const cookie = out.headers.get("set-cookie") ?? "";
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=;`));
    assert.match(cookie, /Max-Age=0/);
    assert.match(cookie, /HttpOnly/);
    // Signing out needs no session: a signed-out page may always ask.
    assert.equal((await call("POST", "/api/signout")).status, 204);
  });

  it("rejects malformed requests without falling over", async () => {
    for (const body of [{}, { gameId: 730 }, { gameId: -1, minutes: 30 }, { gameId: 730, minutes: 1.5 }]) {
      assert.equal((await renter("POST", "/api/bookings", body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await renter("POST", "/api/bookings", "{not json")).status, 400);
    assert.equal((await renter("POST", "/api/bookings", "x".repeat(20_000))).status, 413);
    assert.equal((await offer("pc-1", { available: "yes" })).status, 400);
    assert.equal((await offer("pc-1", { available: true, until: "whenever" })).status, 400);
    assert.equal((await call("GET", "/api/%E0%A4%A")).status, 400);
    assert.equal((await call("GET", "/api/nothing-here")).status, 404);
    assert.equal((await call("GET", "/api/games")).status, 200);
  });

  it("stores the host report sent with availability and heartbeat", async () => {
    assert.equal((await offer()).status, 200);
    assert.equal(platform.machineProfile("pc-1")!.hardware?.gpu, REPORT.hardware.gpu);

    const beat = await call("POST", "/api/machines/pc-1/heartbeat", { games: [440] }, MACHINE_KEY);
    assert.equal(beat.status, 200);
    assert.deepEqual(platform.machineProfile("pc-1")!.games, [440]);
  });

  it("refuses a bad host report with a 400 naming the field, and stores none of it", async () => {
    const bad = await offer("pc-1", { available: true, ...REPORT, net: { rttMs: "fast" } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /^net\.rttMs /);
    const beat = await call("POST", "/api/machines/pc-1/heartbeat", { controls: ["wheel"] }, MACHINE_KEY);
    assert.equal(beat.status, 400);
    assert.equal(platform.machineProfile("pc-1"), null);
  });

  it("takes a full library within the host body limit, and refuses a larger body", async () => {
    const games = Array.from({ length: MAX_GAMES }, (_, i) => 2_000_000 + i);
    assert.equal((await offer("pc-1", { available: true, ...REPORT, games })).status, 200);
    assert.equal(platform.machineProfile("pc-1")!.games.length, MAX_GAMES);
    const huge = { available: true, name: "x".repeat(40_000) };
    assert.equal((await offer("pc-1", huge)).status, 413);
  });

  it("ignores any reason the host sends: an early end is host_end, whatever it claims", async () => {
    await offer();
    for (const reason of ["renter", "time_up"]) {
      const { body } = await call("POST", "/api/bookings", { gameId: 730, minutes: 30 });
      const claim = await call("POST", `/api/bookings/${body.bookingId}/claim`);
      const end = await call("POST", `/api/sessions/${claim.body.sessionId}/end`, { reason }, MACHINE_KEY);
      assert.equal(end.status, 200, reason);
      assert.equal(platform.sessionEndReason(claim.body.sessionId), "host_end", reason);
    }
  });

  it("ends a session as renter when the renter leaves with the session's own ticket", async () => {
    await offer();
    await offer("pc-2");
    const first = await call("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    const second = await call("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    const mine = await call("POST", `/api/bookings/${first.body.bookingId}/claim`);
    const theirs = await call("POST", `/api/bookings/${second.body.bookingId}/claim`);
    const leave = `/api/sessions/${mine.body.sessionId}/leave`;

    assert.equal((await call("POST", leave)).status, 401);
    assert.equal((await call("POST", leave, undefined, MACHINE_KEY)).status, 401);
    assert.equal((await call("POST", leave, undefined, theirs.body.ticket)).status, 403);
    assert.equal((await call("POST", "/api/sessions/nope/leave", undefined, mine.body.ticket)).status, 404);
    assert.equal(platform.sessionEndReason(mine.body.sessionId), null);

    const left = await call("POST", leave, undefined, mine.body.ticket);
    assert.equal(left.status, 200);
    assert.deepEqual(left.body, { sessionId: mine.body.sessionId });
    assert.equal(platform.sessionEndReason(mine.body.sessionId), "renter");
    assert.equal((await call("POST", leave, undefined, mine.body.ticket)).status, 409);
  });

  describe("renter QoS", () => {
    const QOS = { fps: 59.8, bitrate: 18_500_000, rttMs: 14.2, packetLoss: 0.004 };

    /** A claimed session and the join ticket handed out for it. */
    const claimed = async () => {
      await offer();
      const { body } = await call("POST", "/api/bookings", { gameId: 730, minutes: 30 });
      const claim = await call("POST", `/api/bookings/${body.bookingId}/claim`);
      return { path: `/api/sessions/${claim.body.sessionId}/qos`, ...claim.body };
    };

    it("stores the renter's report under the session, with the session's own ticket", async () => {
      const { path, sessionId, ticket } = await claimed();
      const reply = await call("POST", path, QOS, ticket);
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.body, { sessionId });
      assert.deepEqual(platform.sessionQos(sessionId), { reports: 1, ...QOS });
    });

    it("refuses a missing, forged or other session's ticket, and the machine key", async () => {
      const first = await claimed();
      const { body } = await call("POST", "/api/bookings", { gameId: 730, minutes: 30 });
      await offer("pc-2");
      const other = await call("POST", `/api/bookings/${body.bookingId}/claim`);
      assert.equal(other.status, 200);

      assert.equal((await call("POST", first.path, QOS)).status, 401);
      assert.equal((await call("POST", first.path, QOS, "forged")).status, 401);
      assert.equal((await call("POST", first.path, QOS, MACHINE_KEY)).status, 401);
      assert.equal((await call("POST", first.path, QOS, other.body.ticket)).status, 403);
      assert.equal((await call("POST", "/api/sessions/nope/qos", QOS, first.ticket)).status, 404);
      const expired = mintTicket(SECRET, "pc-1", 60, Date.now() - 61_000);
      assert.equal((await call("POST", first.path, QOS, expired)).status, 401);
      assert.equal(platform.sessionQos(first.sessionId), null);
    });

    it("refuses a report once the session is long over", async () => {
      const { path, sessionId, ticket } = await claimed();
      await call("POST", `/api/sessions/${sessionId}/end`, {}, MACHINE_KEY);
      now += 5 * 60_000;
      assert.equal((await call("POST", path, QOS, ticket)).status, 409);
    });

    it("rejects a malformed or oversized report with a 400 or 413", async () => {
      const { path, sessionId, ticket } = await claimed();
      for (const bad of [
        {},
        { ...QOS, fps: "60" },
        { ...QOS, packetLoss: 1.5 },
        { ...QOS, rttMs: -1 },
        { ...QOS, bitrate: null },
      ]) {
        assert.equal((await call("POST", path, bad, ticket)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await call("POST", path, { ...QOS, pad: "x".repeat(2_000) }, ticket)).status, 413);
      assert.equal(platform.sessionQos(sessionId), null);
    });
  });
});

describe("the real server", () => {
  const SERVER = fileURLToPath(new URL("../index.js", import.meta.url));
  const PORT = 8500 + Math.floor(Math.random() * 400);
  const call = client(`http://localhost:${PORT}`);
  const renter = client(`http://localhost:${PORT}`, signedIn(RENTER));
  let server: ChildProcess | undefined;

  before(async () => {
    server = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT: String(PORT),
        ROOM_SECRET: SECRET,
        SESSION_SECRET: SESSION,
        MACHINE_KEYS,
        DATABASE_PATH: "",
      },
      stdio: "ignore",
    });
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://localhost:${PORT}/api/bookings/none`);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("server did not start");
  });

  after(() => server?.kill());

  it("hands out a ticket that opens the matched room", async () => {
    await call("PUT", "/api/machines/pc-2/availability", { available: true, ...REPORT }, MACHINE_KEY);
    const { body } = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    const claim = await renter("POST", `/api/bookings/${body.bookingId}/claim`);
    assert.equal(claim.status, 200);
    assert.equal(claim.body.signalingUrl, `ws://localhost:${PORT}`);

    const ws = new WebSocket(claim.body.signalingUrl);
    const reply = await new Promise<SignalMessage>((resolve, reject) => {
      ws.once("open", () => ws.send(JSON.stringify({ type: "join", ticket: claim.body.ticket })));
      ws.once("message", (raw) => resolve(JSON.parse(String(raw)) as SignalMessage));
      ws.once("error", reject);
    });
    ws.close();
    assert.equal(reply.type, "joined");
    assert.equal(reply.type === "joined" && reply.hostId, "pc-2");
  });

  it("puts the renter out and refuses the ticket once the session has ended", async () => {
    await call("PUT", "/api/machines/pc-1/availability", { available: true, ...REPORT }, MACHINE_KEY);
    const { body } = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    const claim = await renter("POST", `/api/bookings/${body.bookingId}/claim`);
    assert.equal(claim.status, 200);

    const join = () => {
      const ws = new WebSocket(claim.body.signalingUrl);
      const received: SignalMessage[] = [];
      ws.on("message", (raw) => received.push(JSON.parse(String(raw)) as SignalMessage));
      ws.once("open", () => ws.send(JSON.stringify({ type: "join", ticket: claim.body.ticket })));
      const closed = new Promise<number>((resolve) => ws.once("close", resolve));
      return { received, closed };
    };
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 100));
    };

    const seated = join();
    await until(() => seated.received.length > 0);
    assert.equal(seated.received[0]?.type, "joined");

    const end = await call("POST", `/api/sessions/${claim.body.sessionId}/end`, {}, MACHINE_KEY);
    assert.equal(end.status, 200);
    assert.equal(await seated.closed, 4003);
    assert.deepEqual(seated.received.at(-1), { type: "denied", reason: "bad-ticket" });

    const again = join();
    assert.equal(await again.closed, 4003);
    assert.deepEqual(again.received, [{ type: "denied", reason: "bad-ticket" }]);
  });

  it("ends the PC's host session when the platform ends the renter's session", async () => {
    await call("PUT", "/api/machines/pc-1/availability", { available: true, ...REPORT }, MACHINE_KEY);
    const { body } = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    const claim = await renter("POST", `/api/bookings/${body.bookingId}/claim`);
    assert.equal(claim.body.roomId, "pc-1");

    const started = await call(
      "POST",
      "/api/machines/pc-1/session",
      { sessionId: claim.body.sessionId },
      MACHINE_KEY,
    );
    assert.equal(started.status, 201);
    const streamer = () => {
      const ws = new WebSocket(`ws://localhost:${PORT}`);
      const received: SignalMessage[] = [];
      ws.on("message", (raw) => received.push(JSON.parse(String(raw)) as SignalMessage));
      ws.once("open", () =>
        ws.send(JSON.stringify({ type: "register", hostId: "pc-1", sessionKey: started.body.sessionKey })),
      );
      const closed = new Promise<number>((resolve) => ws.once("close", resolve));
      return { received, closed };
    };
    const renterA = streamer();
    for (let i = 0; i < 50 && !renterA.received.length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(renterA.received[0]?.type, "registered");

    // The platform ends it on its own: the owner takes the machine back.
    assert.equal(
      (await call("PUT", "/api/machines/pc-1/availability", { available: false }, MACHINE_KEY)).status,
      200,
    );
    assert.equal(await renterA.closed, 4003);
    assert.deepEqual(renterA.received.at(-1), { type: "denied", reason: "session-ended" });

    const again = streamer();
    assert.equal(await again.closed, 4003);
    assert.deepEqual(again.received, [{ type: "denied", reason: "bad-session-key" }]);

    // Nor can the ended session be started again: there is nothing to serve.
    const restarted = await call(
      "POST",
      "/api/machines/pc-1/session",
      { sessionId: claim.body.sessionId },
      MACHINE_KEY,
    );
    assert.equal(restarted.status, 409);
    assert.deepEqual(restarted.body, { error: "not-claimed" });
  });
});
