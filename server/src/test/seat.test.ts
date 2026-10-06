// Friend seats: a host keeps a few named seats at their PC for friends, each
// with its own link; the friend who takes one joins the crew it is in and may
// play on that PC (gate E7), with their own Steam games, until the host takes
// it back or they leave the crew.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import {
  inviteToken,
  mintRenterSession,
  parseMachineKeys,
  parseMachineOwners,
  seatToken,
  verifySeatToken,
  type Access,
} from "../access.js";
import { createApi } from "../api.js";
import { RequestBudget } from "../budget.js";
import {
  MAX_CREWS,
  MAX_SEATS,
  Platform,
  SEAT_HOLD_MS,
  SEAT_NAME_MAX,
  seatNameOf,
  type MachineSpec,
} from "../platform.js";
import { SESSION_COOKIE } from "../signin.js";
import { emptyProfile } from "../steam.js";
import { testDatabase } from "./db.js";
import { REPORT } from "./report.js";

const SECRET = "test-room-secret-that-is-long-enough-to-pass";
const SESSION = "test-session-secret-that-is-long-enough-too";
const MACHINE_KEY = "test-machine-key";
/** A test's sign-in session lasts ten years from its fixed date, so the real clock never finds it expired. */
const SESSION_TTL_S = 10 * 365 * 24 * 3600;
const HASH = createHash("sha256").update(MACHINE_KEY).digest("hex");
/** Has the gaming PC and keeps seats at it. */
const LENA = "76561198000000021";
/** The friend Lena keeps a seat for. */
const JONAS = "76561198000000022";
/** Another friend of Lena's. */
const MIA = "76561198000000023";
/** Nobody's friend. */
const STRANGER = "76561198000000024";
/** pc-1 is Lena's; pc-2 has no owner on record. */
const MACHINE_KEYS = [`pc-1:${HASH}:${LENA}`, `pc-2:${HASH}`].join(",");
const PERSONA: Record<string, string> = { [LENA]: "Lena", [JONAS]: "Jonas", [MIA]: "Mia" };

let now: number;
let platform: Platform;
const owners = parseMachineOwners(MACHINE_KEYS);

const open = async () => {
  platform = await Platform.open({ database: await testDatabase(), now: () => now, owners });
};

const offer = (machineId: string, spec: MachineSpec = {}) =>
  platform.setAvailability(machineId, true, { ...REPORT, ...spec });

/** A seat at pc-1 for `friend`, which must be made. */
async function seatFor(friend: string) {
  const made = await platform.createSeat("pc-1", friend, "Lena");
  assert.ok(made.ok, `seat for ${friend}: ${JSON.stringify(made)}`);
  return made.seat;
}

/** `userId` takes seat `seatId`, which must work. */
async function take(seatId: string, userId: string) {
  const taken = await platform.takeSeat(seatId, userId, PERSONA[userId] ?? null);
  assert.ok(taken.ok, `take: ${JSON.stringify(taken)}`);
  return taken;
}

describe("friend seats", () => {
  beforeEach(async () => {
    now = Date.UTC(2026, 9, 6, 20);
    await open();
  });

  afterEach(() => platform.close());

  describe("making seats", () => {
    it("founds a crew for a PC that plays for none, which plays for it from then on", async () => {
      await offer("pc-1", { crewOnly: false });
      const seat = await seatFor("Jonas");
      assert.deepEqual(
        { ...seat, id: undefined, crewId: undefined },
        {
          id: undefined,
          crewId: undefined,
          friend: "Jonas",
          number: 1,
          state: "open",
          expiresAt: now + SEAT_HOLD_MS,
          takenBy: null,
        },
      );
      const crew = (await platform.crew(seat.crewId, LENA))!;
      assert.equal(crew.name, "Lena");
      assert.deepEqual(
        crew.machines.map((m) => m.name),
        ["Nova-01"],
      );
      const view = await platform.heartbeat("pc-1");
      assert.equal(view.crew.only, true, "a PC with seats is for its friends, no longer anyone's");
      // A second seat goes into the same crew.
      assert.equal((await seatFor("Mia")).crewId, seat.crewId);
    });

    it("keeps the seat in the first crew the PC plays for", async () => {
      const crew = await platform.createCrew(LENA, "Lena", "Freitagsrunde");
      assert.ok(crew !== "too-many");
      await offer("pc-1", { crews: [crew.id] });
      assert.equal((await seatFor("Jonas")).crewId, crew.id);
      assert.equal((await platform.crews(LENA)).length, 1, "no crew is founded beside it");
    });

    it("keeps at most MAX_SEATS at a PC, and an unanswered seat frees its place once it has waited out its time", async () => {
      await offer("pc-1");
      for (let i = 1; i <= MAX_SEATS; i++) {
        now += 1000;
        assert.equal((await seatFor(`Friend ${i}`)).number, i);
      }
      assert.deepEqual(await platform.createSeat("pc-1", "One more", "Lena"), { ok: false, reason: "full" });

      // The first seat, made MAX_SEATS - 1 seconds before the last, runs out first.
      now += SEAT_HOLD_MS - (MAX_SEATS - 1) * 1000;
      assert.equal((await platform.seats("pc-1")).length, MAX_SEATS - 1);
      assert.equal((await seatFor("One more")).number, MAX_SEATS);
    });

    it("refuses a PC never heard from, and one with no owner on record", async () => {
      assert.deepEqual(await platform.createSeat("pc-1", "Jonas"), { ok: false, reason: "unknown-machine" });
      await offer("pc-2");
      assert.deepEqual(await platform.createSeat("pc-2", "Jonas"), { ok: false, reason: "no-owner" });
    });

    it("refuses to found a crew for an owner in MAX_CREWS crews already", async () => {
      await offer("pc-1", { crewOnly: false });
      for (let i = 0; i < MAX_CREWS; i++) {
        const crew = await platform.createCrew(LENA, "Lena");
        assert.ok(crew !== "too-many");
        await platform.bringPc(crew.id, LENA, "off");
      }
      await offer("pc-1", { crews: [] });
      assert.deepEqual(await platform.createSeat("pc-1", "Jonas"), { ok: false, reason: "too-many" });
    });

    it("folds a friend's name as a crew's, at most SEAT_NAME_MAX characters", () => {
      assert.equal(seatNameOf("  Jonas \n K. "), "Jonas K.");
      assert.equal(seatNameOf("‮evil"), "evil");
      assert.equal(seatNameOf(" "), null);
      assert.equal(seatNameOf(7), null);
      assert.equal([...seatNameOf("x".repeat(80))!].length, SEAT_NAME_MAX);
    });
  });

  describe("taking a seat", () => {
    it("joins the friend to the crew, and lets them alone of outsiders play on the PC", async () => {
      await offer("pc-1");
      const seat = await seatFor("Jonas");
      const opened = (await platform.seat(seat.id))!;
      assert.deepEqual(opened, {
        host: "Lena",
        friend: "Jonas",
        number: 1,
        of: 1,
        state: "open",
        expiresAt: now + SEAT_HOLD_MS,
        pc: { name: "Nova-01", gpu: "NVIDIA GeForce RTX 4070", state: "ready", rentalMode: false },
        crewId: null,
      });

      assert.equal(await platform.bookMachine("pc-1", 730, 30, JONAS), null, "not before taking it");
      const taken = await take(seat.id, JONAS);
      assert.equal(taken.crewId, seat.crewId);
      assert.equal(taken.joined, true);
      assert.equal(taken.seat.state, "yours");
      assert.equal(taken.seat.crewId, seat.crewId);
      assert.deepEqual(
        (await platform.crew(seat.crewId, JONAS))!.members.map((m) => m.name),
        ["Lena", "Jonas"],
      );
      assert.deepEqual(
        (await platform.seats("pc-1")).map((s) => [s.friend, s.state, s.takenBy]),
        [["Jonas", "taken", "Jonas"]],
      );

      assert.equal(await platform.bookMachine("pc-1", 730, 30, STRANGER), null);
      const booked = await platform.bookMachine("pc-1", 730, 30, JONAS);
      assert.equal(booked?.status, "matched");
      assert.equal(booked?.machine?.id, "pc-1");
      assert.equal((await platform.claim(booked!.bookingId, JONAS)).ok, true);
    });

    it("is taken once: by the first friend to open it, never by its host, and not after its time", async () => {
      await offer("pc-1");
      const seat = await seatFor("Jonas");
      assert.deepEqual(await platform.takeSeat(seat.id, LENA), { ok: false, reason: "own" });
      assert.equal((await platform.seat(seat.id, LENA))!.state, "host");
      await take(seat.id, JONAS);
      const again = await take(seat.id, JONAS);
      assert.equal(again.joined, false, "taking it twice changes nothing");
      assert.deepEqual(await platform.takeSeat(seat.id, MIA), { ok: false, reason: "taken" });
      assert.equal((await platform.seat(seat.id, MIA))!.state, "taken");
      assert.equal((await platform.seat(seat.id, MIA))!.crewId, null, "only its holder learns the crew");

      const late = await seatFor("Mia");
      now += SEAT_HOLD_MS;
      assert.deepEqual(await platform.takeSeat(late.id, MIA), { ok: false, reason: "expired" });
      assert.deepEqual(
        { ...(await platform.seat(late.id, MIA))!, pc: undefined },
        {
          host: "Lena",
          friend: "Mia",
          number: 2,
          of: 2,
          state: "expired",
          expiresAt: now,
          pc: undefined,
          crewId: null,
        },
      );
      // The taken one is held still.
      assert.equal((await platform.seat(seat.id, JONAS))!.state, "yours");
    });

    it("keeps one seat per friend at a PC", async () => {
      await offer("pc-1");
      const first = await seatFor("Jonas");
      const second = await seatFor("Jonas again");
      await take(first.id, JONAS);
      assert.deepEqual(await platform.takeSeat(second.id, JONAS), { ok: false, reason: "taken" });
      assert.equal((await platform.seat(second.id, MIA))!.state, "open", "left for someone else");
    });

    it("refuses a friend in MAX_CREWS crews already", async () => {
      await offer("pc-1");
      const seat = await seatFor("Jonas");
      for (let i = 0; i < MAX_CREWS; i++)
        assert.ok((await platform.createCrew(JONAS, "Jonas")) !== "too-many");
      assert.deepEqual(await platform.takeSeat(seat.id, JONAS), { ok: false, reason: "too-many" });
    });

    it("holds the seat on the PC itself, whichever crews its host picks for it later", async () => {
      await offer("pc-1");
      const seat = await seatFor("Jonas");
      await take(seat.id, JONAS);
      const other = await platform.createCrew(LENA, "Lena", "Werkstatt");
      assert.ok(other !== "too-many");
      await offer("pc-1", { crews: [other.id] });
      const booked = await platform.bookMachine("pc-1", 730, 30, JONAS);
      assert.equal(booked?.machine?.id, "pc-1");
    });
  });

  describe("taking a seat back", () => {
    it("closes an open seat's link", async () => {
      await offer("pc-1");
      const seat = await seatFor("Jonas");
      assert.equal(await platform.revokeSeat("pc-1", seat.id), true);
      assert.equal(await platform.seat(seat.id), null);
      assert.deepEqual(await platform.takeSeat(seat.id, JONAS), { ok: false, reason: "not-found" });
      assert.deepEqual(await platform.seats("pc-1"), []);
      assert.equal(await platform.revokeSeat("pc-1", seat.id), false, "gone already");
    });

    it("ends the friend's play on the PC and the membership taking it made", async () => {
      await offer("pc-1");
      const seat = await seatFor("Jonas");
      await take(seat.id, JONAS);
      const booked = await platform.bookMachine("pc-1", 730, 30, JONAS);
      assert.equal(booked?.status, "matched");

      assert.equal(await platform.revokeSeat("pc-1", seat.id), true);
      assert.deepEqual(await platform.crews(JONAS), []);
      assert.deepEqual(await platform.claim(booked!.bookingId, JONAS), {
        ok: false,
        reason: "not-claimable",
        status: "queued",
      });
      await platform.endBooking(booked!.bookingId, JONAS);
      assert.equal(await platform.bookMachine("pc-1", 730, 30, JONAS), null);
    });

    it("leaves a friend who was in the crew before in it", async () => {
      await offer("pc-1");
      const seat = await seatFor("Jonas");
      const crew = (await platform.crew(seat.crewId, LENA))!;
      const joined = await platform.joinCrew(crew.inviteId!, JONAS, "Jonas");
      assert.ok(joined.ok);
      const taken = await take(seat.id, JONAS);
      assert.equal(taken.joined, false);
      await platform.revokeSeat("pc-1", seat.id);
      assert.deepEqual(
        (await platform.crews(JONAS)).map((c) => c.id),
        [seat.crewId],
      );
    });

    it("lets the seat go when its holder leaves the crew, and with it the PC", async () => {
      await offer("pc-1");
      const seat = await seatFor("Jonas");
      await take(seat.id, JONAS);
      const { memberId } = (await platform.crew(seat.crewId, JONAS))!;
      assert.equal(await platform.leaveCrew(memberId, JONAS), true);
      assert.deepEqual(await platform.seats("pc-1"), []);
      assert.equal(await platform.bookMachine("pc-1", 730, 30, JONAS), null);
    });

    it("lets the seats at a host's PC go when the host leaves the crew they are in", async () => {
      await offer("pc-1");
      const seat = await seatFor("Jonas");
      await take(seat.id, JONAS);
      const open = await seatFor("Mia");
      const { memberId } = (await platform.crew(seat.crewId, LENA))!;
      assert.equal(await platform.leaveCrew(memberId, LENA), true);
      assert.deepEqual(await platform.seats("pc-1"), []);
      assert.equal(await platform.seat(open.id), null);
    });
  });
});

describe("seat API", () => {
  let server: Server;
  let origin: string;
  const access: Access = { secret: SECRET, machines: parseMachineKeys(MACHINE_KEYS), owners };

  before(async () => {
    // Everyone owns Counter-Strike 2 alone, and nothing is free to play.
    const profile = async (steamId: string) => ({
      ...emptyProfile(steamId),
      persona: PERSONA[steamId] ?? "",
      lib: true,
      library: Uint32Array.from([730]),
    });
    server = createServer(async (req, res) => {
      const api = createApi({
        platform,
        access,
        sessionSecret: SESSION,
        publicOrigin: "http://localhost",
        fallbackOrigin: "http://localhost",
        games: async () => [
          { id: 730, name: "Counter-Strike 2", image: null },
          { id: 570, name: "Dota 2", image: null },
        ],
        profile,
        discovery: new RequestBudget({ now: () => now }),
        isFree: async () => false,
      });
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (!(await api(req, res, path))) res.writeHead(418).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(() => server.close());

  beforeEach(async () => {
    now = Date.UTC(2026, 9, 6, 20);
    await open();
  });

  afterEach(() => platform.close());

  /** One JSON call, as `steamId` signed in when given one, with the machine key when `key` is set. */
  async function call(method: string, path: string, steamId?: string, body?: unknown, key = false) {
    const headers: Record<string, string> = {};
    // The server reads the session against the real clock, not the test's: it outlasts any date here.
    if (steamId)
      headers.cookie = `${SESSION_COOKIE}=${mintRenterSession(SESSION, steamId, SESSION_TTL_S, now)}`;
    if (key) headers.authorization = `Bearer ${MACHINE_KEY}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${origin}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }

  const offerPc = () =>
    call("PUT", "/api/machines/pc-1/availability", undefined, { available: true, ...REPORT }, true);

  /** The host app makes a seat at pc-1 for `friend`. */
  async function makeSeat(friend: string) {
    const made = await call("POST", "/api/machines/pc-1/seats", undefined, { friend }, true);
    assert.equal(made.status, 201);
    return made.body.seat as { id: string; token: string; crewId: string };
  }

  it("lets the host app keep seats with the machine key alone, each with its own link", async () => {
    await offerPc();
    assert.equal(
      (await call("POST", "/api/machines/pc-1/seats", undefined, { friend: "Jonas" })).status,
      401,
    );
    assert.equal(
      (await call("GET", "/api/machines/pc-1/seats", LENA)).status,
      401,
      "a sign-in is no machine key",
    );
    assert.equal(
      (await call("POST", "/api/machines/pc-1/seats", undefined, { friend: " " }, true)).status,
      400,
    );

    const seat = await makeSeat("Jonas");
    assert.match(seat.token, /^[\w-]{44}$/);
    assert.equal(verifySeatToken(SESSION, seat.token), seat.id);
    const listed = await call("GET", "/api/machines/pc-1/seats", undefined, undefined, true);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.max, MAX_SEATS);
    assert.deepEqual(
      listed.body.seats.map((s: { friend: string; token: string }) => [s.friend, s.token]),
      [["Jonas", seat.token]],
    );
    assert.equal(
      listed.headers.get("access-control-allow-origin"),
      "*",
      "the host app reads it from its own origin",
    );

    for (let i = 2; i <= MAX_SEATS; i++) await makeSeat(`Friend ${i}`);
    const full = await call("POST", "/api/machines/pc-1/seats", undefined, { friend: "More" }, true);
    assert.equal(full.status, 409);
    assert.equal(full.body.code, "full");
  });

  it("shows a seat to anyone with its link, signed out too, and refuses a forged one or a crew link", async () => {
    await offerPc();
    const seat = await makeSeat("Jonas");
    const opened = await call("GET", `/api/seats/${seat.token}`);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.seat.host, "Lena", "the owner's Steam persona, read when the seat was made");
    assert.equal(opened.body.seat.friend, "Jonas");
    assert.equal(opened.body.seat.state, "open");
    assert.equal(opened.body.seat.pc.gpu, "NVIDIA GeForce RTX 4070");
    assert.equal(JSON.stringify(opened.body).includes(LENA), false, "never a Steam id");

    const forged = seat.token.slice(0, 22) + "A".repeat(22);
    assert.equal((await call("GET", `/api/seats/${forged}`)).status, 404);
    assert.equal((await call("GET", `/api/seats/${inviteToken(SESSION, seat.id)}`)).status, 404);
    assert.equal((await call("POST", `/api/seats/${forged}/take`, JONAS)).status, 404);
    assert.equal((await call("GET", `/api/seats/${seatToken(SECRET, seat.id)}`)).status, 404);
  });

  it("has the friend take the seat signed in, book that PC, and play only their own games", async () => {
    await offerPc();
    const seat = await makeSeat("Jonas");
    assert.equal((await call("POST", `/api/seats/${seat.token}/take`)).status, 401);
    const taken = await call("POST", `/api/seats/${seat.token}/take`, JONAS);
    assert.equal(taken.status, 200);
    assert.equal(taken.body.crewId, seat.crewId);
    assert.equal(taken.body.seat.state, "yours");
    assert.equal((await call("GET", `/api/crews/${seat.crewId}`, JONAS)).status, 200);

    const again = await call("POST", `/api/seats/${seat.token}/take`, MIA);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "taken");
    const own = await call("POST", `/api/seats/${seat.token}/take`, LENA);
    assert.equal(own.body.code, "own");

    const stranger = await call("POST", "/api/bookings", STRANGER, {
      gameId: 730,
      minutes: 30,
      machineId: "pc-1",
    });
    assert.equal(stranger.status, 409);
    // Dota 2 is on the PC, but not in Jonas's own library: nobody plays on someone else's account.
    const notHis = await call("POST", "/api/bookings", JONAS, {
      gameId: 570,
      minutes: 30,
      machineId: "pc-1",
    });
    assert.equal(notHis.status, 403);
    assert.equal(notHis.body.code, "not-owned");
    const booked = await call("POST", "/api/bookings", JONAS, {
      gameId: 730,
      minutes: 30,
      machineId: "pc-1",
    });
    assert.equal(booked.status, 202);
    assert.equal(booked.body.status, "matched");
    assert.equal(booked.body.machine.id, "pc-1");
  });

  it("takes a seat back from the host app, which closes its link and the PC to its friend", async () => {
    await offerPc();
    const seat = await makeSeat("Jonas");
    await call("POST", `/api/seats/${seat.token}/take`, JONAS);
    assert.equal((await call("DELETE", `/api/machines/pc-1/seats?seat=${seat.id}`)).status, 401);
    assert.equal(
      (await call("DELETE", "/api/machines/pc-1/seats?seat=nope", undefined, undefined, true)).status,
      400,
    );
    const revoked = await call(
      "DELETE",
      `/api/machines/pc-1/seats?seat=${seat.id}`,
      undefined,
      undefined,
      true,
    );
    assert.equal(revoked.status, 200);
    assert.deepEqual(revoked.body.seats, []);
    assert.equal(
      (await call("DELETE", `/api/machines/pc-1/seats?seat=${seat.id}`, undefined, undefined, true)).status,
      404,
    );
    assert.equal((await call("GET", `/api/seats/${seat.token}`)).status, 404);
    const booked = await call("POST", "/api/bookings", JONAS, {
      gameId: 730,
      minutes: 30,
      machineId: "pc-1",
    });
    assert.equal(booked.status, 409);
  });

  it("answers the host app's preflight for taking a seat back", async () => {
    const res = await fetch(`${origin}/api/machines/pc-1/seats`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-allow-methods") ?? "", /DELETE/);
  });
});
