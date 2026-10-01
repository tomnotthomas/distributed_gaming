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
import { parseMachineKeys, verifyTicket, type Access } from "../access.js";
import { createApi } from "../api.js";
import { Platform, QUEUE_TIMEOUT_MS } from "../platform.js";
import type { SignalMessage } from "../protocol.js";
import { MAX_GAMES } from "../profile.js";
import { REPORT } from "./report.js";

const SECRET = "test-room-secret-that-is-long-enough-to-pass";
const MACHINE_KEY = "test-machine-key";
const HASH = createHash("sha256").update(MACHINE_KEY).digest("hex");
const MACHINE_KEYS = `pc-1:${HASH},pc-2:${HASH}`;

type Reply = { status: number; body: any };

/** A JSON caller for `origin`, sending the machine key as a bearer token when given one. */
function client(origin: string) {
  return async (method: string, path: string, body?: unknown, key?: string): Promise<Reply> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (key) headers.authorization = `Bearer ${key}`;
    const response = await fetch(`${origin}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
}

describe("booking and host API", () => {
  let now: number;
  let platform: Platform;
  let access: Access;
  let server: Server;
  let call: ReturnType<typeof client>;

  before(async () => {
    access = { secret: SECRET, machines: parseMachineKeys(MACHINE_KEYS) };
    const games = async () => [{ id: 730, name: "Counter-Strike 2", image: null }];
    server = createServer(async (req, res) => {
      // Built per request so each test's fresh platform is the one served.
      const api = createApi({ platform, access, fallbackOrigin: "http://localhost", games });
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (!(await api(req, res, path))) res.writeHead(418).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    call = client(`http://localhost:${(server.address() as AddressInfo).port}`);
  });

  after(() => server.close());

  beforeEach(() => {
    now = Date.UTC(2026, 8, 30, 12);
    platform = new Platform({ now: () => now });
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
    const booked = await call("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    assert.equal(booked.status, 202);
    assert.equal(booked.body.status, "queued");
    const id = booked.body.bookingId;

    assert.equal((await offer("pc-1", { available: true, ...REPORT, price: 120 })).status, 200);
    const matched = await call("GET", `/api/bookings/${id}`);
    assert.equal(matched.body.status, "matched");
    assert.equal(matched.body.machine.id, "pc-1");
    assert.equal(matched.body.machine.gpu, REPORT.hardware.gpu);

    const claim = await call("POST", `/api/bookings/${id}/claim`);
    assert.equal(claim.status, 200);
    assert.equal(claim.body.roomId, "pc-1");
    assert.match(claim.body.signalingUrl, /^ws:\/\/localhost:\d+$/);
    assert.equal(typeof claim.body.sessionId, "string");
    const ticket = verifyTicket(SECRET, claim.body.ticket);
    assert.equal(ticket?.room, "pc-1");
    assert.ok(ticket && Math.abs(ticket.exp * 1000 - (Date.now() + 30 * 60_000)) < 5_000);

    assert.equal((await call("GET", `/api/bookings/${id}`)).body.status, "claimed");
    const beat = await call("POST", "/api/machines/pc-1/heartbeat", undefined, MACHINE_KEY);
    assert.deepEqual(beat.body.session, { id: claim.body.sessionId });

    const start = await call("POST", `/api/sessions/${claim.body.sessionId}/start`, undefined, MACHINE_KEY);
    assert.equal(start.status, 200);
    assert.equal((await call("GET", `/api/bookings/${id}`)).body.status, "playing");
    const end = await call("POST", `/api/sessions/${claim.body.sessionId}/end`, {}, MACHINE_KEY);
    assert.equal(end.status, 200);
    assert.equal((await call("GET", `/api/bookings/${id}`)).body.status, "ended");
    const again = await call("POST", `/api/sessions/${claim.body.sessionId}/end`, {}, MACHINE_KEY);
    assert.equal(again.status, 409);
  });

  it("answers 409 to a claim after the reservation has lapsed and the renter is gone", async () => {
    await offer();
    const { body } = await call("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    now += QUEUE_TIMEOUT_MS;
    await call("POST", "/api/machines/pc-1/heartbeat", undefined, MACHINE_KEY);

    const claim = await call("POST", `/api/bookings/${body.bookingId}/claim`);
    assert.equal(claim.status, 409);
    assert.equal(claim.body.status, "expired");
    assert.equal(claim.body.ticket, undefined);
  });

  it("answers 409 to a second claim and 404 to an unknown booking", async () => {
    await offer();
    const { body } = await call("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    assert.equal((await call("POST", `/api/bookings/${body.bookingId}/claim`)).status, 200);
    assert.equal((await call("POST", `/api/bookings/${body.bookingId}/claim`)).status, 409);
    assert.equal((await call("POST", "/api/bookings/nope/claim")).status, 404);
    assert.equal((await call("GET", "/api/bookings/nope")).status, 404);
  });

  it("does not spend the reservation when no ticket can be minted", async () => {
    await offer();
    const { body } = await call("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    access.secret = null;
    assert.equal((await call("POST", `/api/bookings/${body.bookingId}/claim`)).status, 503);
    assert.equal((await call("GET", `/api/bookings/${body.bookingId}`)).body.status, "matched");
  });

  it("refuses the Host API without the machine's own key", async () => {
    assert.equal((await call("PUT", "/api/machines/pc-1/availability", { available: true })).status, 401);
    assert.equal(
      (await call("PUT", "/api/machines/pc-1/availability", { available: true }, "wrong")).status,
      401,
    );
    assert.equal((await call("POST", "/api/machines/pc-9/heartbeat", undefined, MACHINE_KEY)).status, 401);

    await offer();
    const { body } = await call("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    const claim = await call("POST", `/api/bookings/${body.bookingId}/claim`);
    const start = `/api/sessions/${claim.body.sessionId}/start`;
    assert.equal((await call("POST", start)).status, 401);
    assert.equal((await call("POST", start, undefined, "wrong")).status, 401);
    assert.equal((await call("POST", "/api/sessions/nope/start", undefined, MACHINE_KEY)).status, 404);
  });

  it("rejects malformed requests without falling over", async () => {
    for (const body of [{}, { gameId: 730 }, { gameId: -1, minutes: 30 }, { gameId: 730, minutes: 1.5 }]) {
      assert.equal((await call("POST", "/api/bookings", body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await call("POST", "/api/bookings", "{not json")).status, 400);
    assert.equal((await call("POST", "/api/bookings", "x".repeat(20_000))).status, 413);
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
});

describe("the real server", () => {
  const SERVER = fileURLToPath(new URL("../index.js", import.meta.url));
  const PORT = 8500 + Math.floor(Math.random() * 400);
  const call = client(`http://localhost:${PORT}`);
  let server: ChildProcess | undefined;

  before(async () => {
    server = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: String(PORT), ROOM_SECRET: SECRET, MACHINE_KEYS, DATABASE_PATH: "" },
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
    const { body } = await call("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    const claim = await call("POST", `/api/bookings/${body.bookingId}/claim`);
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
    const { body } = await call("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    const claim = await call("POST", `/api/bookings/${body.bookingId}/claim`);
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
    const { body } = await call("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    const claim = await call("POST", `/api/bookings/${body.bookingId}/claim`);
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
    assert.deepEqual(restarted, { status: 409, body: { error: "not-claimed" } });
  });
});
