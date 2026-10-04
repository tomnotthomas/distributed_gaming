// The Booking and Host APIs over HTTP. Most tests run the handler in-process
// against a clock they move by hand; the last spawns the real server and
// proves the ticket a claim hands out opens the room over the WebSocket.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
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
import { DISCOVERY_BURST, DISCOVERY_REFILL_MS, RequestBudget } from "../budget.js";
import { Platform, QUEUE_TIMEOUT_MS } from "../platform.js";
import { emptyProfile } from "../steam.js";
import type { SignalMessage } from "../protocol.js";
import { MAX_GAMES } from "../profile.js";
import { REPORT } from "./report.js";
import { SESSION_COOKIE } from "../signin.js";
import { serverDatabase, testDatabase, type ServerDatabase } from "./db.js";

const SECRET = "test-room-secret-that-is-long-enough-to-pass";
const MACHINE_KEY = "test-machine-key";
const HASH = createHash("sha256").update(MACHINE_KEY).digest("hex");
const SESSION = "test-session-secret-that-is-long-enough-too";
const RENTER = "76561198000000001";
const OTHER = "76561198000000002";
const OWNER = "76561198000000003";
// pc-3 belongs to OWNER: it must never be matched to OWNER's own bookings.
const MACHINE_KEYS = `pc-1:${HASH},pc-2:${HASH},pc-3:${HASH}:${OWNER},pc-4:${HASH},pc-5:${HASH}`;

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
  let discovery: RequestBudget;
  // Each renter's Steam library, where Steam shows it; a renter with none listed
  // has their library hidden. Renters in `unreachable` cannot be read at all.
  let libraries: Map<string, number[]>;
  let unreachable: Set<string>;

  before(async () => {
    access = {
      secret: SECRET,
      machines: parseMachineKeys(MACHINE_KEYS),
      owners: parseMachineOwners(MACHINE_KEYS),
    };
    const games = async () => [{ id: 730, name: "Counter-Strike 2", image: null }];
    // A fresh read is the one a renter asks for after making their library public.
    const profile = async (steamId: string, { fresh = false } = {}) => {
      if (unreachable.has(steamId)) throw new Error("steam is down");
      const library = libraries.get(steamId);
      return {
        ...emptyProfile(steamId),
        persona: "kai_nx",
        lib: fresh || library !== undefined,
        library: Uint32Array.from(library ?? []).sort(),
      };
    };
    // Counter-Strike 2 and Dota 2 are free to play; every other game is paid.
    const isFree = async (appid: number) => appid === 730 || appid === 570;
    server = createServer(async (req, res) => {
      // Built per request so each test's fresh platform is the one served.
      const api = createApi({
        platform,
        access,
        sessionSecret: SESSION,
        publicOrigin: "http://localhost",
        fallbackOrigin: "http://localhost",
        games,
        profile,
        discovery,
        isFree,
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

  beforeEach(async () => {
    now = Date.UTC(2026, 8, 30, 12);
    platform = await Platform.open({ database: await testDatabase(), now: () => now, owners: access.owners });
    discovery = new RequestBudget({ now: () => now });
    access.secret = SECRET;
    libraries = new Map();
    unreachable = new Set();
  });

  afterEach(() => platform.close());

  const offer = (id = "pc-1", body: object = { available: true, ...REPORT }) =>
    call("PUT", `/api/machines/${id}/availability`, body, MACHINE_KEY);

  it("answers a ping at once, signed out, for the page to time its round trip", async () => {
    const { status, body, headers } = await call("GET", "/api/ping");
    assert.equal(status, 204);
    assert.equal(body, null);
    assert.equal(headers.get("cache-control"), "no-store");
  });

  it("lists the games that can be booked", async () => {
    const { status, body } = await call("GET", "/api/games");
    assert.equal(status, 200);
    assert.deepEqual(body, [{ id: 730, name: "Counter-Strike 2", image: null }]);
  });

  it("tells the owner's PC what renters ask for, as counts per game, never who asked", async () => {
    await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    await as(signedIn(OTHER))("POST", "/api/bookings", { gameId: 730, minutes: 60 });
    await as(signedIn(OWNER))("POST", "/api/bookings", { gameId: 570, minutes: 30 });

    const { status, body, headers } = await call("GET", "/api/machines/pc-1/demand", undefined, MACHINE_KEY);
    assert.equal(status, 200);
    assert.equal(headers.get("access-control-allow-origin"), "*");
    assert.equal(headers.get("cache-control"), "no-store");
    assert.deepEqual(body, {
      windowMinutes: 60,
      games: [
        { appid: 730, looking: 2, waiting: 2, name: "Counter-Strike 2" },
        { appid: 570, looking: 1, waiting: 1, name: null },
      ],
    });
    assert.doesNotMatch(JSON.stringify(body), /7656119/);
  });

  it("counts a booking that left the queue for an hour, then forgets it", async () => {
    const { body: booked } = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    assert.equal((await renter("POST", `/api/bookings/${booked.bookingId}/end`)).status, 200);
    const demand = async () =>
      (await call("GET", "/api/machines/pc-1/demand", undefined, MACHINE_KEY)).body.games;

    assert.deepEqual(await demand(), [{ appid: 730, looking: 1, waiting: 0, name: "Counter-Strike 2" }]);
    now += 60 * 60_000;
    assert.deepEqual(await demand(), []);
  });

  it("shows demand only to a machine's own key, and lets the host app ask from its own origin", async () => {
    assert.equal((await call("GET", "/api/machines/pc-1/demand")).status, 401);
    assert.equal((await call("GET", "/api/machines/pc-1/demand", undefined, "wrong-key")).status, 401);
    assert.equal((await call("GET", "/api/machines/nope/demand", undefined, MACHINE_KEY)).status, 401);
    assert.equal((await renter("GET", "/api/machines/pc-1/demand")).status, 401);

    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    const preflight = await fetch(`${origin}/api/machines/pc-1/demand`, {
      method: "OPTIONS",
      headers: { origin: "null", "access-control-request-method": "GET" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);
    assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
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
      assert.equal((await caller("POST", "/api/me/refresh")).status, 401);
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

    // Anybody else gets it, while the owner keeps waiting.
    const theirs = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    assert.equal(theirs.body.status, "matched");
    assert.equal(theirs.body.machine.id, "pc-3");

    await offer("pc-1", { available: true, ...REPORT, price: 120 });
    const matched = await owner("GET", `/api/bookings/${own.body.bookingId}`);
    assert.equal(matched.body.status, "matched");
    assert.equal(matched.body.machine.id, "pc-1");
  });

  it("books a machine picked from the list at once, for the renter to claim", async () => {
    await offer("pc-1", { available: true, ...REPORT, price: 50 });
    await offer("pc-2", { available: true, ...REPORT, price: 300 });
    const booked = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30, machineId: "pc-2" });
    assert.equal(booked.status, 202);
    assert.equal(booked.body.status, "matched");
    assert.equal(booked.body.machine.id, "pc-2");
    assert.equal(booked.body.claimBy, now + 60_000);
    const claim = await renter("POST", `/api/bookings/${booked.body.bookingId}/claim`);
    assert.equal(claim.status, 200);
    assert.equal(claim.body.roomId, "pc-2");
  });

  it("answers 409 with the next best when the picked machine was taken", async () => {
    await offer("pc-1", { available: true, ...REPORT, price: 50 });
    await offer("pc-2", { available: true, ...REPORT, price: 300 });
    const other = as(signedIn(OTHER));
    assert.equal(
      (await other("POST", "/api/bookings", { gameId: 730, minutes: 30, machineId: "pc-1" })).status,
      202,
    );

    const taken = await renter("POST", "/api/bookings", {
      gameId: 730,
      minutes: 30,
      machineId: "pc-1",
      rtts: { server: 8 },
    });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error, "the machine is taken");
    assert.equal(taken.body.nextBest.id, "pc-2");
    assert.deepEqual(taken.body.nextBest.latency, { rttMs: 20, jitterMs: 2.5, source: "estimate" });

    // An unknown machine reads the same as a taken one.
    const unknown = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30, machineId: "pc-9" });
    assert.equal(unknown.status, 409);
    assert.equal(unknown.body.nextBest.id, "pc-2");

    // The next best comes out of the renter's budget of discovery reads.
    for (let i = 0; i < DISCOVERY_BURST; i++) discovery.take(RENTER);
    const spent = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30, machineId: "pc-1" });
    assert.equal(spent.status, 409);
    assert.equal(spent.body.nextBest, null);
  });

  it("offers as next best only a machine with every control the renter plays with", async () => {
    await offer("pc-1", { available: true, ...REPORT, price: 50 });
    await offer("pc-2", { available: true, ...REPORT, controls: ["kb", "mouse"], price: 60 });
    await offer("pc-3", { available: true, ...REPORT, price: 300 });
    const other = as(signedIn(OTHER));
    await other("POST", "/api/bookings", { gameId: 730, minutes: 30, machineId: "pc-1" });

    const ask = { gameId: 730, minutes: 30, machineId: "pc-1" };
    const withPad = await renter("POST", "/api/bookings", {
      ...ask,
      controls: ["kb", "pad"],
      picture: "best",
    });
    assert.equal(withPad.status, 409);
    assert.equal(withPad.body.nextBest.id, "pc-3");
    // Without controls the cheaper machine without a pad comes first, as before.
    const without = await renter("POST", "/api/bookings", ask);
    assert.equal(without.body.nextBest.id, "pc-2");
  });

  it("never matches a queued renter asking for a pad to a machine without one", async () => {
    await offer("pc-1", { available: true, ...REPORT, controls: ["kb", "mouse"] });
    const queued = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30, controls: ["pad"] });
    assert.equal(queued.body.status, "queued");

    await offer("pc-2");
    const matched = await renter("GET", `/api/bookings/${queued.body.bookingId}`);
    assert.equal(matched.body.status, "matched");
    assert.equal(matched.body.machine.id, "pc-2");
  });

  it("matches a queued booking by the renter's round trips", async () => {
    await offer("pc-1", { available: true, ...REPORT, net: { ...REPORT.net, rttMs: 40 } });
    const far = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30, rtts: { server: 60 } });
    assert.equal(far.body.status, "queued");
    const near = await renter("POST", "/api/bookings", {
      gameId: 730,
      minutes: 30,
      rtts: { server: 60, machines: { "pc-1": 30 } },
    });
    assert.equal(near.body.status, "matched");
  });

  it("lets the renter end their own booking, and nobody else", async () => {
    await offer();
    const { body } = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    const claim = await renter("POST", `/api/bookings/${body.bookingId}/claim`);
    const end = `/api/bookings/${body.bookingId}/end`;
    assert.equal((await call("POST", end)).status, 401);
    assert.equal((await as(signedIn(OTHER))("POST", end)).status, 404);
    assert.equal((await renter("POST", "/api/bookings/nope/end")).status, 404);

    const ended = await renter("POST", end);
    assert.equal(ended.status, 200);
    assert.equal(ended.body.status, "ended");
    assert.equal(ended.body.sessionId, claim.body.sessionId);
    assert.equal(await platform.sessionEndReason(claim.body.sessionId), "renter");
    assert.equal(
      (await call("POST", "/api/machines/pc-1/heartbeat", undefined, MACHINE_KEY)).body.status,
      "available",
    );

    const again = await renter("POST", end);
    assert.equal(again.status, 409);
    assert.equal(again.body.status, "ended");
  });

  describe("bring your own games", () => {
    /** A paid game: Elden Ring, installed on pc-1 alongside the free ones. */
    const PAID = 1245620;
    const offerPaid = () => offer("pc-1", { available: true, ...REPORT, games: [...REPORT.games, PAID] });

    it("books and claims a paid game in the renter's Steam library", async () => {
      libraries.set(RENTER, [440, PAID]);
      await offerPaid();
      const booked = await renter("POST", "/api/bookings", { gameId: PAID, minutes: 30 });
      assert.equal(booked.status, 202);
      assert.equal(booked.body.status, "matched");
      const claim = await renter("POST", `/api/bookings/${booked.body.bookingId}/claim`);
      assert.equal(claim.status, 200);
      assert.equal(claim.body.roomId, "pc-1");
    });

    it("books a free-to-play game the renter does not own, library read or not", async () => {
      libraries.set(RENTER, [PAID]);
      await offer();
      const owned = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30, machineId: "pc-1" });
      assert.equal(owned.status, 202);
      assert.equal((await renter("POST", `/api/bookings/${owned.body.bookingId}/claim`)).status, 200);

      // OTHER's library is hidden: free to play is still theirs to play.
      await offer("pc-2");
      const hidden = await as(signedIn(OTHER))("POST", "/api/bookings", { gameId: 730, minutes: 30 });
      assert.equal(hidden.status, 202);
    });

    it("refuses a paid game that is not in the renter's library, queued or picked, and books nothing", async () => {
      libraries.set(RENTER, [440]);
      await offerPaid();
      for (const ask of [
        { gameId: PAID, minutes: 30 },
        { gameId: PAID, minutes: 30, machineId: "pc-1" },
      ]) {
        const refused = await renter("POST", "/api/bookings", ask);
        assert.equal(refused.status, 403);
        assert.equal(refused.body.code, "not-owned");
        assert.match(refused.body.error, /not in your Steam library/);
        assert.equal(refused.body.bookingId, undefined);
      }
      // pc-1 is still free for somebody who owns the game.
      libraries.set(OTHER, [PAID]);
      const other = await as(signedIn(OTHER))("POST", "/api/bookings", {
        gameId: PAID,
        minutes: 30,
        machineId: "pc-1",
      });
      assert.equal(other.status, 202);
    });

    it("refuses a paid game when the renter's library cannot be read, hidden or Steam down", async () => {
      await offerPaid();
      const hidden = await renter("POST", "/api/bookings", { gameId: PAID, minutes: 30 });
      assert.equal(hidden.status, 403);
      assert.equal(hidden.body.code, "library-unreadable");

      unreachable.add(OTHER);
      const down = await as(signedIn(OTHER))("POST", "/api/bookings", { gameId: PAID, minutes: 30 });
      assert.equal(down.status, 403);
      assert.equal(down.body.code, "library-unreadable");
      assert.equal(
        (await as(signedIn(OTHER))("POST", "/api/bookings", { gameId: 730, minutes: 30 })).status,
        202,
      );
    });

    it("refuses the claim of a game gone from the renter's library, leaving the reservation unspent", async () => {
      libraries.set(RENTER, [PAID]);
      await offerPaid();
      const { body } = await renter("POST", "/api/bookings", {
        gameId: PAID,
        minutes: 30,
        machineId: "pc-1",
      });

      libraries.set(RENTER, []);
      const refused = await renter("POST", `/api/bookings/${body.bookingId}/claim`);
      assert.equal(refused.status, 403);
      assert.equal(refused.body.code, "not-owned");
      assert.equal(refused.body.ticket, undefined);
      assert.equal((await renter("GET", `/api/bookings/${body.bookingId}`)).body.status, "matched");

      libraries.delete(RENTER);
      const unread = await renter("POST", `/api/bookings/${body.bookingId}/claim`);
      assert.equal(unread.status, 403);
      assert.equal(unread.body.code, "library-unreadable");

      libraries.set(RENTER, [PAID]);
      assert.equal((await renter("POST", `/api/bookings/${body.bookingId}/claim`)).status, 200);
    });

    it("answers a retryable 503 to a claim while Steam cannot be read, keeping the reservation", async () => {
      libraries.set(RENTER, [PAID]);
      await offerPaid();
      const { body } = await renter("POST", "/api/bookings", {
        gameId: PAID,
        minutes: 30,
        machineId: "pc-1",
      });

      unreachable.add(RENTER);
      const down = await renter("POST", `/api/bookings/${body.bookingId}/claim`);
      assert.equal(down.status, 503);
      assert.equal(down.body.code, undefined);
      assert.equal(down.body.ticket, undefined);
      assert.equal((await renter("GET", `/api/bookings/${body.bookingId}`)).body.status, "matched");

      unreachable.delete(RENTER);
      assert.equal((await renter("POST", `/api/bookings/${body.bookingId}/claim`)).status, 200);
    });

    it("lets a claim of a free-to-play game through while Steam cannot be read", async () => {
      await offer();
      const { body } = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30, machineId: "pc-1" });
      unreachable.add(RENTER);
      assert.equal((await renter("POST", `/api/bookings/${body.bookingId}/claim`)).status, 200);
    });

    it("answers 404, not a refusal, to a claim of somebody else's booking", async () => {
      libraries.set(OTHER, [PAID]);
      await offerPaid();
      const { body } = await as(signedIn(OTHER))("POST", "/api/bookings", { gameId: PAID, minutes: 30 });
      assert.equal((await renter("POST", `/api/bookings/${body.bookingId}/claim`)).status, 404);
    });

    it("never sends the page the full library", async () => {
      libraries.set(RENTER, [PAID]);
      const me = await renter("GET", "/api/me");
      assert.equal(me.body.profile.lib, true);
      assert.equal(me.body.profile.library, undefined);
      assert.equal((await renter("POST", "/api/me/refresh")).body.profile.library, undefined);
    });
  });

  it("tells the page who is signed in, and signs them out", async () => {
    const me = await renter("GET", "/api/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.steamId, RENTER);
    assert.equal(me.body.profile.persona, "kai_nx");
    assert.equal(me.headers.get("cache-control"), "no-store");
    assert.equal(me.body.profile.lib, false);

    const refreshed = await renter("POST", "/api/me/refresh");
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.steamId, RENTER);
    assert.equal(refreshed.body.profile.lib, true);

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
    for (const body of [
      {},
      { gameId: 730 },
      { gameId: -1, minutes: 30 },
      { gameId: 730, minutes: 1.5 },
      { gameId: 730, minutes: 30, machineId: 5 },
      { gameId: 730, minutes: 30, machineId: "" },
      { gameId: 730, minutes: 30, rtts: 8 },
      { gameId: 730, minutes: 30, rtts: { server: -1 } },
      { gameId: 730, minutes: 30, rtts: { machines: [8] } },
      { gameId: 730, minutes: 30, rtts: { machines: { "pc-1": "fast" } } },
      { gameId: 730, minutes: 30, controls: "pad" },
      { gameId: 730, minutes: 30, controls: ["joystick"] },
      { gameId: 730, minutes: 30, picture: "8k" },
    ]) {
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
    assert.equal((await platform.machineProfile("pc-1"))!.hardware?.gpu, REPORT.hardware.gpu);

    const beat = await call("POST", "/api/machines/pc-1/heartbeat", { games: [440] }, MACHINE_KEY);
    assert.equal(beat.status, 200);
    assert.deepEqual((await platform.machineProfile("pc-1"))!.games, [440]);
  });

  it("refuses a bad host report with a 400 naming the field, and stores none of it", async () => {
    const bad = await offer("pc-1", { available: true, ...REPORT, net: { rttMs: "fast" } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /^net\.rttMs /);
    const beat = await call("POST", "/api/machines/pc-1/heartbeat", { controls: ["wheel"] }, MACHINE_KEY);
    assert.equal(beat.status, 400);
    assert.equal(await platform.machineProfile("pc-1"), null);
  });

  it("takes a full library within the host body limit, and refuses a larger body", async () => {
    const games = Array.from({ length: MAX_GAMES }, (_, i) => 2_000_000 + i);
    assert.equal((await offer("pc-1", { available: true, ...REPORT, games })).status, 200);
    assert.equal((await platform.machineProfile("pc-1"))!.games.length, MAX_GAMES);
    const huge = { available: true, name: "x".repeat(40_000) };
    assert.equal((await offer("pc-1", huge)).status, 413);
  });

  it("ignores any reason the host sends: an early end is host_end, whatever it claims", async () => {
    await offer();
    for (const reason of ["renter", "time_up"]) {
      const { body } = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
      const claim = await renter("POST", `/api/bookings/${body.bookingId}/claim`);
      const end = await call("POST", `/api/sessions/${claim.body.sessionId}/end`, { reason }, MACHINE_KEY);
      assert.equal(end.status, 200, reason);
      assert.equal(await platform.sessionEndReason(claim.body.sessionId), "host_end", reason);
    }
  });

  it("ends a session as renter when the renter leaves with the session's own ticket", async () => {
    await offer();
    await offer("pc-2");
    const first = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    const second = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    const mine = await renter("POST", `/api/bookings/${first.body.bookingId}/claim`);
    const theirs = await renter("POST", `/api/bookings/${second.body.bookingId}/claim`);
    const leave = `/api/sessions/${mine.body.sessionId}/leave`;

    assert.equal((await call("POST", leave)).status, 401);
    assert.equal((await call("POST", leave, undefined, MACHINE_KEY)).status, 401);
    assert.equal((await call("POST", leave, undefined, theirs.body.ticket)).status, 403);
    assert.equal((await call("POST", "/api/sessions/nope/leave", undefined, mine.body.ticket)).status, 404);
    assert.equal(await platform.sessionEndReason(mine.body.sessionId), null);

    const left = await call("POST", leave, undefined, mine.body.ticket);
    assert.equal(left.status, 200);
    assert.deepEqual(left.body, { sessionId: mine.body.sessionId });
    assert.equal(await platform.sessionEndReason(mine.body.sessionId), "renter");
    assert.equal((await call("POST", leave, undefined, mine.body.ticket)).status, 409);
  });

  describe("renter QoS", () => {
    const QOS = { fps: 59.8, bitrate: 18_500_000, rttMs: 14.2, packetLoss: 0.004 };

    /** A claimed session and the join ticket handed out for it. */
    const claimed = async () => {
      await offer();
      const { body } = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
      const claim = await renter("POST", `/api/bookings/${body.bookingId}/claim`);
      return { path: `/api/sessions/${claim.body.sessionId}/qos`, ...claim.body };
    };

    it("stores the renter's report under the session, with the session's own ticket", async () => {
      const { path, sessionId, ticket } = await claimed();
      const reply = await call("POST", path, QOS, ticket);
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.body, { sessionId });
      assert.deepEqual(await platform.sessionQos(sessionId), { reports: 1, ...QOS });
    });

    it("refuses a missing, forged or other session's ticket, and the machine key", async () => {
      const first = await claimed();
      const { body } = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
      await offer("pc-2");
      const other = await renter("POST", `/api/bookings/${body.bookingId}/claim`);
      assert.equal(other.status, 200);

      assert.equal((await call("POST", first.path, QOS)).status, 401);
      assert.equal((await call("POST", first.path, QOS, "forged")).status, 401);
      assert.equal((await call("POST", first.path, QOS, MACHINE_KEY)).status, 401);
      assert.equal((await call("POST", first.path, QOS, other.body.ticket)).status, 403);
      assert.equal((await call("POST", "/api/sessions/nope/qos", QOS, first.ticket)).status, 404);
      const expired = mintTicket(SECRET, "pc-1", 60, Date.now() - 61_000);
      assert.equal((await call("POST", first.path, QOS, expired)).status, 401);
      assert.equal(await platform.sessionQos(first.sessionId), null);
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
      assert.equal(await platform.sessionQos(sessionId), null);
    });
  });
  describe("what can be played where", () => {
    const KEYS = [
      "availableUntil",
      "controls",
      "cores",
      "coversSession",
      "cpu",
      "encoders",
      "gpu",
      "headroom",
      "id",
      "latency",
      "minutesLeft",
      "name",
      "picture",
      "price",
      "ramMb",
      "refreshHz",
      "response",
      "stability",
      "vramMb",
    ];

    it("is signed in only", async () => {
      await offer();
      assert.equal((await call("GET", "/api/availability?appids=730&rtt=8")).status, 401);
      assert.equal((await call("GET", "/api/games/730/machines?minutes=60&rtt=8")).status, 401);
    });

    it("ranks the machines for a game with the latency estimated through the server", async () => {
      await offer("pc-1", { available: true, ...REPORT, price: 300 });
      await offer("pc-2", {
        available: true,
        ...REPORT,
        name: "Ember",
        net: { rttMs: 25, jitterMs: 1, upMbps: 48 },
        price: 100,
        until: now + 30 * 60_000,
      });
      const { status, body } = await renter("GET", "/api/games/730/machines?minutes=60&rtt=8");
      assert.equal(status, 200);
      assert.equal(body.appid, 730);
      assert.equal(body.minutes, 60);
      assert.equal(body.requirements.source, "curated");
      assert.deepEqual(
        body.machines.map((m: any) => [m.id, m.latency.rttMs, m.coversSession]),
        [
          ["pc-1", 20, true],
          ["pc-2", 33, false],
        ],
      );
      // pc-2 is cheaper, but only pc-1 is free for the whole hour.
      assert.deepEqual(body.reason, { rule: "O1", label: "Free all session" });
      const [first, second] = body.machines;
      assert.deepEqual(Object.keys(first).sort(), KEYS);
      assert.deepEqual(first.latency, { rttMs: 20, jitterMs: 2.5, source: "estimate" });
      assert.equal(first.name, "Nova-01");
      assert.equal(first.gpu, REPORT.hardware.gpu);
      assert.equal(first.availableUntil, null);
      assert.equal(first.minutesLeft, null);
      assert.equal(first.stability, "new");
      assert.equal(second.minutesLeft, 30);
      // Nothing says who owns a machine or where it is.
      assert.doesNotMatch(JSON.stringify(body), /owner|address|"ip"/i);
      assert.deepEqual(body.busy, []);
    });

    it("never lists the renter's own machine, nor one too far away or without the game", async () => {
      await offer("pc-1", { available: true, ...REPORT, games: [570] });
      await offer("pc-2", { available: true, ...REPORT, net: { rttMs: 75, jitterMs: 1, upMbps: 48 } });
      await offer("pc-3");
      const { name: _name, net: _net, ...silent } = REPORT;
      await offer("pc-4", { available: true, ...silent });

      const ids = async (who: ReturnType<typeof client>, query = "&rtt=0") =>
        (await who("GET", `/api/games/730/machines?minutes=60${query}`)).body.machines.map((m: any) => m.id);
      assert.deepEqual(await ids(renter), ["pc-3", "pc-2"]);
      assert.deepEqual(await ids(renter, "&rtt=10"), ["pc-3"]);
      assert.deepEqual(await ids(as(signedIn(OWNER))), ["pc-2"]);
    });

    it("leaves out a machine that lacks a control the renter plays with", async () => {
      await offer("pc-1", { available: true, ...REPORT, controls: ["kb", "mouse"] });
      await offer("pc-2");
      const { body } = await renter("GET", "/api/games/730/machines?minutes=60&rtt=0&controls=kb,pad");
      assert.deepEqual(
        body.machines.map((m: any) => m.id),
        ["pc-2"],
      );
    });

    it("counts free and busy machines for each game asked about, in order", async () => {
      await offer("pc-1");
      await offer("pc-2", { available: true, ...REPORT, games: [570] });
      const booked = await as(signedIn(OTHER))("POST", "/api/bookings", { gameId: 570, minutes: 30 });
      const { claimBy } = (await as(signedIn(OTHER))("GET", `/api/bookings/${booked.body.bookingId}`)).body;

      const { status, body } = await renter("GET", "/api/availability?appids=570,730,440,0570,570&rtt=0");
      assert.equal(status, 200);
      // Each game once, however it is spelled. The booking took pc-1, the cheapest by id;
      // pc-2 is free for Dota 2 only.
      const back = { busy: 1, backAt: claimBy + 30 * 60_000, backName: "Nova-01" };
      const pc2 = {
        id: "pc-2",
        name: "Nova-01",
        gpu: REPORT.hardware.gpu,
        latency: { rttMs: 12, jitterMs: 2.5, source: "estimate" },
        availableUntil: null,
      };
      assert.deepEqual(body, [
        { appid: 570, free: 1, ready: 1, best: pc2, ...back },
        { appid: 730, free: 0, ready: 0, best: null, ...back },
        { appid: 440, free: 0, ready: 0, best: null, busy: 0, backAt: null, backName: null },
      ]);
      const machines = (await renter("GET", "/api/games/730/machines?minutes=60&rtt=0")).body;
      assert.deepEqual(machines.machines, []);
      assert.deepEqual(machines.busy, [{ id: "pc-1", name: "Nova-01", backAt: claimBy + 30 * 60_000 }]);
    });

    it("says which machines are ready for the minutes asked for, and offers the best of those", async () => {
      await offer("pc-1", { available: true, ...REPORT, price: 300 });
      await offer("pc-2", {
        available: true,
        ...REPORT,
        name: "Ember",
        net: { rttMs: 2, jitterMs: 1, upMbps: 48 },
        until: now + 30 * 60_000,
      });
      const ask = async (query: string) =>
        (await renter("GET", `/api/availability?appids=730&rtt=0${query}`)).body[0];

      // Asked for no length, both are ready and the nearer one leads.
      const any = await ask("");
      assert.deepEqual([any.free, any.ready, any.best.id], [2, 2, "pc-2"]);
      assert.equal(any.best.availableUntil, now + 30 * 60_000);
      assert.equal(any.best.name, "Ember");
      // An hour: only pc-1 lasts it, so only pc-1 is ready, and it is the one offered.
      const hour = await ask("&minutes=60");
      assert.deepEqual([hour.free, hour.ready, hour.best.id], [2, 1, "pc-1"]);
      assert.equal(hour.best.availableUntil, null);
      assert.equal(hour.best.latency.rttMs, 12);
      // Nothing lasts the whole night.
      const pc1Until = await offer("pc-1", { available: true, ...REPORT, until: now + 60 * 60_000 });
      assert.equal(pc1Until.status, 200);
      const night = await ask("&minutes=600");
      assert.deepEqual([night.free, night.ready, night.best], [2, 0, null]);
      assert.doesNotMatch(JSON.stringify(night), /owner|address|"ip"/i);
    });

    it("does not count a busy machine that is taken until its owner wants it back", async () => {
      await offer("pc-1", { available: true, ...REPORT, until: now + 31 * 60_000 });
      await as(signedIn(OTHER))("POST", "/api/bookings", { gameId: 730, minutes: 30 });
      const { body } = await renter("GET", "/api/availability?appids=730&rtt=0");
      assert.deepEqual(body, [
        { appid: 730, free: 0, ready: 0, best: null, busy: 0, backAt: null, backName: null },
      ]);
      const machines = await renter("GET", "/api/games/730/machines?minutes=30&rtt=0");
      assert.deepEqual(machines.body.busy, []);
    });

    it("neither counts nor lists a machine whose offer has run out", async () => {
      await offer("pc-1", { available: true, ...REPORT, until: now + 10 * 60_000 });
      now += 15 * 60_000;
      await call("POST", "/api/machines/pc-1/heartbeat", undefined, MACHINE_KEY);
      const { body } = await renter("GET", "/api/availability?appids=730&rtt=0");
      assert.deepEqual(body, [
        { appid: 730, free: 0, ready: 0, best: null, busy: 0, backAt: null, backName: null },
      ]);
      const machines = await renter("GET", "/api/games/730/machines?minutes=1&rtt=0");
      assert.deepEqual(machines.body.machines, []);
    });

    it("holds each renter to a budget of these reads, with a 429 past it", async () => {
      await offer();
      const path = (i: number) =>
        i % 2 ? "/api/availability?appids=730&rtt=0" : "/api/games/730/machines?minutes=60&rtt=0";
      for (let i = 0; i < DISCOVERY_BURST; i++) assert.equal((await renter("GET", path(i))).status, 200);

      const refused = await renter("GET", path(0));
      assert.equal(refused.status, 429);
      assert.equal(refused.headers.get("retry-after"), String(DISCOVERY_REFILL_MS / 1000));
      assert.equal((await renter("GET", path(1))).status, 429);
      // Another renter has a budget of their own, and the rest of the API is not limited.
      assert.equal((await as(signedIn(OTHER))("GET", path(0))).status, 200);
      assert.equal((await renter("GET", "/api/me")).status, 200);

      now += DISCOVERY_REFILL_MS;
      assert.equal((await renter("GET", path(0))).status, 200);
      assert.equal((await renter("GET", path(0))).status, 429);
    });

    it("lists a busy machine only when it is back in time for the minutes asked for", async () => {
      await offer("pc-1", { available: true, ...REPORT, until: now + 60 * 60_000 });
      const booked = await as(signedIn(OTHER))("POST", "/api/bookings", { gameId: 730, minutes: 30 });
      const { claimBy } = (await as(signedIn(OTHER))("GET", `/api/bookings/${booked.body.bookingId}`)).body;
      const backAt = claimBy + 30 * 60_000; // 31 minutes from now, 29 before the offer ends

      const busy = async (minutes: number) =>
        (await renter("GET", `/api/games/730/machines?minutes=${minutes}&rtt=0`)).body.busy;
      assert.deepEqual(await busy(29), [{ id: "pc-1", name: "Nova-01", backAt }]);
      assert.deepEqual(await busy(30), []);
      const { body } = await renter("GET", "/api/availability?appids=730&rtt=0");
      assert.deepEqual(body, [
        { appid: 730, free: 0, ready: 0, best: null, busy: 1, backAt, backName: "Nova-01" },
      ]);
    });

    it("rejects a malformed question with a 400", async () => {
      discovery = new RequestBudget({ burst: 100, now: () => now });
      const bad = [
        "/api/availability?rtt=0",
        "/api/availability?appids=&rtt=0",
        "/api/availability?appids=730,abc&rtt=0",
        "/api/availability?appids=0&rtt=0",
        `/api/availability?appids=${Array.from({ length: 101 }, (_, i) => i + 1).join(",")}&rtt=0`,
        "/api/availability?appids=730",
        "/api/availability?appids=730&rtt=-1",
        "/api/availability?appids=730&rtt=",
        "/api/availability?appids=730&rtt=abc",
        "/api/availability?appids=730&rtt=Infinity",
        "/api/availability?appids=730&rtt=10001",
        "/api/availability?appids=730&rtt=0&controls=joystick",
        "/api/availability?appids=730&rtt=0&minutes=0",
        "/api/availability?appids=730&rtt=0&minutes=721",
        "/api/availability?appids=730&rtt=0&minutes=",
        "/api/games/730/machines?rtt=0",
        "/api/games/730/machines?minutes=0&rtt=0",
        "/api/games/730/machines?minutes=721&rtt=0",
        "/api/games/730/machines?minutes=1.5&rtt=0",
        "/api/games/abc/machines?minutes=60&rtt=0",
        "/api/games/730/machines?minutes=60",
        "/api/games/730/machines?minutes=60&rtt=",
        "/api/games/730/machines?minutes=60&rtt=-1",
        "/api/games/730/machines?minutes=60&rtt=abc",
        "/api/games/730/machines?minutes=60&rtt=NaN",
        "/api/games/730/machines?minutes=60&rtt=10001",
        "/api/games/730/machines?minutes=60&rtt=0&picture=8k",
      ];
      for (const path of bad) assert.equal((await renter("GET", path)).status, 400, path);
    });
  });
});

describe("the real server", () => {
  const SERVER = fileURLToPath(new URL("../index.js", import.meta.url));
  const PORT = 8500 + Math.floor(Math.random() * 400);
  const call = client(`http://localhost:${PORT}`);
  const renter = client(`http://localhost:${PORT}`, signedIn(RENTER));
  let server: ChildProcess | undefined;
  let database: ServerDatabase;

  before(async () => {
    database = await serverDatabase();
    server = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT: String(PORT),
        ROOM_SECRET: SECRET,
        SESSION_SECRET: SESSION,
        MACHINE_KEYS,
        DATABASE_URL: database.url,
      },
      stdio: "ignore",
    });
    // Up to 15 s: the server opens its database before it listens, slower under a full test run.
    for (let i = 0; i < 150; i++) {
      try {
        await fetch(`http://localhost:${PORT}/api/bookings/none`);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("server did not start");
  });

  after(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((resolve) => server!.once("exit", resolve));
      server.kill();
      await exited;
    }
    await database.close();
  });

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

  it("pushes the match to the renter's event stream as it happens", async () => {
    const { body } = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    assert.equal(body.status, "queued", "every machine is busy or taken back");
    const abort = new AbortController();
    const response = await fetch(`http://localhost:${PORT}/api/events?booking=${body.bookingId}`, {
      signal: abort.signal,
      headers: { cookie: signedIn(RENTER) },
    });
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = response.body!.getReader();
    let text = "";
    /** Read the stream until `needle` has arrived. */
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { done, value } = await reader.read();
        assert.ok(!done, `the stream ended before ${needle}`);
        text += new TextDecoder().decode(value);
      }
    };
    await readUntil('"status":"queued"');

    await call("PUT", "/api/machines/pc-5/availability", { available: true, ...REPORT }, MACHINE_KEY);
    await readUntil('"status":"matched"');
    assert.match(text, /"machine":\{"id":"pc-5"/);
    abort.abort();
    assert.equal((await renter("POST", `/api/bookings/${body.bookingId}/claim`)).status, 200);
  });

  it("takes a PC offline the moment its socket closes, handing its booking back", async () => {
    await call("PUT", "/api/machines/pc-4/availability", { available: true, ...REPORT }, MACHINE_KEY);
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const registered = new Promise<SignalMessage>((resolve, reject) => {
      ws.once("open", () => ws.send(JSON.stringify({ type: "register", hostId: "pc-4", key: MACHINE_KEY })));
      ws.once("message", (raw) => resolve(JSON.parse(String(raw)) as SignalMessage));
      ws.once("error", reject);
    });
    assert.equal((await registered).type, "registered");
    const { body } = await renter("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    assert.equal(body.machine?.id, "pc-4");

    ws.close();
    await new Promise((resolve) => ws.once("close", resolve));
    await new Promise((r) => setTimeout(r, 100));
    // Well inside the 15 s a silent heartbeat would take.
    assert.equal((await renter("GET", `/api/bookings/${body.bookingId}`)).body.status, "queued");
  });
});
