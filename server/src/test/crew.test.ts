// Crews: a player's personal invite link, the friend who joins by it, and
// crew-only PCs, which are offered and matched to their owner's crew alone
// (gate E7), however a renter comes to them: the wall, the game page, the
// queue, a machine picked from the list, or a claim.

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
  verifyInviteToken,
  type Access,
} from "../access.js";
import { createApi } from "../api.js";
import { RequestBudget } from "../budget.js";
import { Platform, type MachineSpec } from "../platform.js";
import { SESSION_COOKIE } from "../signin.js";
import { emptyProfile } from "../steam.js";
import { testDatabase } from "./db.js";
import { REPORT } from "./report.js";

const SECRET = "test-room-secret-that-is-long-enough-to-pass";
const SESSION = "test-session-secret-that-is-long-enough-too";
const MACHINE_KEY = "test-machine-key";
const HASH = createHash("sha256").update(MACHINE_KEY).digest("hex");
/** The player who sends the invite. */
const ALEX = "76561198000000011";
/** Alex's PC friend, who joins and hosts. */
const HOST = "76561198000000012";
/** Someone in no crew of theirs. */
const STRANGER = "76561198000000013";
/** Another friend of Alex's, who plays and hosts nothing. */
const JO = "76561198000000014";
/** pc-1 and pc-2 are the host's; pc-3 is someone else's, open to anyone. */
const MACHINE_KEYS = `pc-1:${HASH}:${HOST},pc-2:${HASH}:${HOST},pc-3:${HASH}:76561198000000099`;
const PERSONA: Record<string, string> = { [ALEX]: "Alex", [HOST]: "Sam" };

let now: number;
let platform: Platform;
const owners = parseMachineOwners(MACHINE_KEYS);

const offer = (machineId: string, spec: MachineSpec = {}) =>
  platform.setAvailability(machineId, true, { ...REPORT, ...spec });

/** Alex's invite, and the host joined by it. */
async function hostJoinsAlex() {
  const { inviteId } = await platform.crewInvite(ALEX, "Alex");
  const joined = await platform.joinCrew(inviteId, HOST, "Sam");
  assert.ok(joined.ok);
  return inviteId;
}

describe("crews", () => {
  beforeEach(async () => {
    now = Date.UTC(2026, 9, 6, 20);
    platform = await Platform.open({ database: await testDatabase(), now: () => now, owners });
  });

  afterEach(() => platform.close());

  describe("invite links", () => {
    it("gives each player one link to their own crew, the same each time they ask", async () => {
      const first = await platform.crewInvite(ALEX, "Alex");
      const again = await platform.crewInvite(ALEX, null);
      assert.equal(again.inviteId, first.inviteId);
      // A read that found no name keeps the one known.
      assert.deepEqual(again.crew, { name: "Alex", own: true, size: 1 });
      assert.notEqual((await platform.crewInvite(HOST, "Sam")).inviteId, first.inviteId);
    });

    it("replaces a link for good when its inviter asks for a new one", async () => {
      const old = await platform.crewInvite(ALEX, "Alex");
      const renewed = await platform.crewInvite(ALEX, "Alex", { renew: true });
      assert.notEqual(renewed.inviteId, old.inviteId);
      assert.equal(await platform.invite(old.inviteId), null);
      assert.deepEqual(await platform.joinCrew(old.inviteId, HOST), { ok: false, reason: "not-found" });
      assert.deepEqual(await platform.invite(renewed.inviteId), {
        name: "Alex",
        own: false,
        size: 1,
        member: false,
      });
    });

    it("joins whoever opens it to the inviter's crew, once, and never the inviter", async () => {
      const { inviteId } = await platform.crewInvite(ALEX, "Alex");
      assert.deepEqual(await platform.joinCrew(inviteId, ALEX), { ok: false, reason: "own-invite" });
      assert.deepEqual(await platform.joinCrew("no-such-invite", HOST), { ok: false, reason: "not-found" });

      assert.deepEqual(await platform.joinCrew(inviteId, HOST), {
        ok: true,
        joined: true,
        crew: { name: "Alex", own: false, size: 2 },
      });
      assert.deepEqual(await platform.joinCrew(inviteId, HOST), {
        ok: true,
        joined: false,
        crew: { name: "Alex", own: false, size: 2 },
      });
      assert.equal((await platform.invite(inviteId, HOST))?.member, true);
      assert.equal((await platform.invite(inviteId, STRANGER))?.member, false);
    });

    it("signs the link, so the id the database holds opens nothing on its own", () => {
      const token = inviteToken(SESSION, "abcdefghijklmnopqrstuv");
      assert.equal(token.length, 44);
      assert.doesNotMatch(token, /\./, "a dot would make the link's path read as a file");
      assert.equal(verifyInviteToken(SESSION, token), "abcdefghijklmnopqrstuv");
      assert.equal(verifyInviteToken(SESSION, "abcdefghijklmnopqrstuv"), null);
      assert.equal(verifyInviteToken("another-secret-that-is-long-enough-too", token), null);
      assert.equal(verifyInviteToken(SESSION, token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")), null);
      assert.equal(verifyInviteToken(SESSION, 42), null);
    });
  });

  describe("crew-only PCs", () => {
    it("makes the joining host's PCs crew-only, and tells the host app whose crew", async () => {
      await offer("pc-1");
      assert.deepEqual((await platform.heartbeat("pc-1")).crew, { only: false, crews: [] });
      await hostJoinsAlex();
      assert.deepEqual((await platform.heartbeat("pc-1")).crew, {
        only: true,
        crews: [{ name: "Alex", own: false, size: 2 }],
      });
      // A PC of theirs first heard from after they joined starts crew-only too.
      assert.equal((await offer("pc-2")).crew.only, true);
      // Someone else's is left as it was.
      assert.equal((await offer("pc-3")).crew.only, false);
    });

    it("leaves a PC open while its owner is only in a crew of their own", async () => {
      await platform.crewInvite(HOST, "Sam");
      assert.equal((await offer("pc-1")).crew.only, false);
    });

    it("never matches a crew-only PC to anyone outside the crew, and does to the crew", async () => {
      await hostJoinsAlex();
      await offer("pc-1");
      const stranger = await platform.book(730, 30, STRANGER);
      assert.equal(stranger.status, "queued");
      assert.equal(await platform.bookMachine("pc-1", 730, 30, STRANGER), null);

      const alex = await platform.book(730, 30, ALEX);
      assert.equal(alex.status, "matched");
      assert.equal(alex.machine?.id, "pc-1");
      assert.equal((await platform.booking(stranger.bookingId, STRANGER))?.status, "queued");
    });

    it("offers it to anyone once its owner opens it, and to the crew alone again when they close it", async () => {
      await hostJoinsAlex();
      await offer("pc-1", { crewOnly: false });
      const stranger = await platform.book(730, 30, STRANGER);
      assert.equal(stranger.machine?.id, "pc-1");
      await platform.endBooking(stranger.bookingId, STRANGER);

      // An offer that leaves crewOnly out keeps what was chosen.
      assert.equal((await offer("pc-1")).crew.only, false);
      assert.equal((await offer("pc-1", { crewOnly: true })).crew.only, true);
      assert.equal(await platform.bookMachine("pc-1", 730, 30, STRANGER), null);
    });

    it("refuses a claim on a PC made crew-only since the match, and queues the booking again", async () => {
      await offer("pc-1");
      const stranger = await platform.book(730, 30, STRANGER);
      assert.equal(stranger.machine?.id, "pc-1");
      await hostJoinsAlex();

      assert.deepEqual(await platform.claim(stranger.bookingId, STRANGER), {
        ok: false,
        reason: "not-claimable",
        status: "queued",
      });
      assert.equal((await platform.heartbeat("pc-1")).status, "available");
      // The crew is matched to it as before.
      assert.equal((await platform.book(730, 30, ALEX)).machine?.id, "pc-1");
    });

    it("tells the wall's reads who may see it", async () => {
      await hostJoinsAlex();
      await offer("pc-1");
      await offer("pc-3");
      const { machines } = await platform.offeredMachines();
      const crewOf = (id: string) => machines.find((m) => m.host.id === id)?.host.crew;
      assert.deepEqual(crewOf("pc-1"), [ALEX, HOST].sort());
      assert.equal(crewOf("pc-3"), undefined);
    });
  });

  describe("leaving and removing", () => {
    it("lets the crew's owner remove a member, who from then on matches none of its crew-only PCs", async () => {
      const inviteId = await hostJoinsAlex();
      now += 60_000;
      await platform.joinCrew(inviteId, JO, "Jo");
      await offer("pc-1");
      const { members } = await platform.crewInvite(ALEX, "Alex");
      assert.deepEqual(
        members.map((m) => m.name),
        ["Sam", "Jo"],
      );
      const jo = members[1]!;
      // Nobody else may remove them: not another member, not the member removing someone else.
      assert.equal(await platform.leaveCrew(jo.id, HOST), false);
      assert.equal(await platform.leaveCrew(members[0]!.id, JO), false);
      assert.equal(await platform.leaveCrew("no-such-member", ALEX), false);

      assert.equal(await platform.leaveCrew(jo.id, ALEX), true);
      assert.equal(await platform.leaveCrew(jo.id, ALEX), false);
      assert.equal((await platform.book(730, 30, JO)).status, "queued");
      assert.equal(await platform.bookMachine("pc-1", 730, 30, JO), null);
      const { machines } = await platform.offeredMachines();
      assert.deepEqual(machines.find((m) => m.host.id === "pc-1")?.host.crew, [ALEX, HOST].sort());
      assert.equal((await platform.crewInvite(ALEX, "Alex")).crew.size, 2);
    });

    it("lets a member leave, and their PC hosts that crew no more until they join again", async () => {
      const inviteId = await hostJoinsAlex();
      await offer("pc-1");
      const [joined] = (await platform.crewInvite(HOST, "Sam")).joined;
      assert.deepEqual({ ...joined, id: undefined }, { id: undefined, name: "Alex", own: false, size: 2 });

      assert.equal(await platform.leaveCrew(joined!.id, HOST), true);
      assert.deepEqual((await platform.heartbeat("pc-1")).crew, { only: true, crews: [] });
      assert.deepEqual((await platform.crewInvite(HOST, "Sam")).joined, []);
      assert.deepEqual((await platform.crewInvite(ALEX, "Alex")).members, []);
      const queued = await platform.book(730, 30, ALEX);
      assert.equal(queued.status, "queued");

      // Joining again by a live link puts them back, and the queue is matched anew.
      assert.ok((await platform.joinCrew(inviteId, HOST, "Sam")).ok);
      assert.equal((await platform.booking(queued.bookingId, ALEX))?.status, "matched");
    });

    it("keeps a removed host's PC crew-only, matched to nobody, and tells the host app so", async () => {
      await hostJoinsAlex();
      await offer("pc-1");
      const [sam] = (await platform.crewInvite(ALEX, "Alex")).members;
      assert.equal(await platform.leaveCrew(sam!.id, ALEX), true);

      assert.deepEqual((await platform.heartbeat("pc-1")).crew, { only: true, crews: [] });
      assert.equal((await platform.book(730, 30, ALEX)).status, "queued");
      assert.equal(await platform.bookMachine("pc-1", 730, 30, STRANGER), null);
      const { machines } = await platform.offeredMachines();
      assert.deepEqual(machines.find((m) => m.host.id === "pc-1")?.host.crew, []);
      // A PC of theirs first heard from now starts open: its owner shares no crew with anyone.
      assert.equal((await offer("pc-2")).crew.only, false);
    });

    it("sends a match made before the removal back to the queue at the claim", async () => {
      const inviteId = await hostJoinsAlex();
      await platform.joinCrew(inviteId, JO, "Jo");
      await offer("pc-1");
      const booked = await platform.book(730, 30, JO);
      assert.equal(booked.machine?.id, "pc-1");

      const { members } = await platform.crewInvite(ALEX, "Alex");
      assert.equal(await platform.leaveCrew(members.find((m) => m.name === "Jo")!.id, ALEX), true);
      assert.deepEqual(await platform.claim(booked.bookingId, JO), {
        ok: false,
        reason: "not-claimable",
        status: "queued",
      });
    });
  });
});

/** The API over HTTP, as the web app and the host app call it. */
describe("crew API", () => {
  let server: Server;
  let origin: string;
  const access: Access = {
    secret: SECRET,
    machines: parseMachineKeys(MACHINE_KEYS),
    owners,
  };

  before(async () => {
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
        games: async () => [{ id: 730, name: "Counter-Strike 2", image: null }],
        profile,
        discovery: new RequestBudget({ now: () => now }),
        isFree: async () => true,
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
    platform = await Platform.open({ database: await testDatabase(), now: () => now, owners });
  });

  afterEach(() => platform.close());

  /** One JSON call, as `steamId` signed in when given one, with the machine key when `key` is set. */
  async function call(method: string, path: string, steamId?: string, body?: unknown, key = false) {
    const headers: Record<string, string> = {};
    if (steamId) headers.cookie = `${SESSION_COOKIE}=${mintRenterSession(SESSION, steamId, 3600, now)}`;
    if (key) headers.authorization = `Bearer ${MACHINE_KEY}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${origin}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  const offerPc = (id: string, extra: object = {}) =>
    call(
      "PUT",
      `/api/machines/${id}/availability`,
      undefined,
      { available: true, ...REPORT, ...extra },
      true,
    );

  /** Alex's link, opened and joined by the host. */
  async function joinByLink() {
    const { body } = await call("GET", "/api/me/invite", ALEX);
    const joined = await call("POST", `/api/invites/${body.token}/join`, HOST);
    assert.equal(joined.status, 200);
    return body.token as string;
  }

  it("hands a signed-in player their personal link, named after their Steam persona", async () => {
    assert.equal((await call("GET", "/api/me/invite")).status, 401);
    const { status, body } = await call("GET", "/api/me/invite", ALEX);
    assert.equal(status, 200);
    assert.match(body.token, /^[\w-]{44}$/);
    assert.deepEqual(body.crew, { name: "Alex", own: true, size: 1 });
    assert.equal((await call("GET", "/api/me/invite", ALEX)).body.token, body.token);
  });

  it("names the inviter to anyone who opens the link, signed out too, and refuses a forged or replaced one", async () => {
    const { body } = await call("GET", "/api/me/invite", ALEX);
    const opened = await call("GET", `/api/invites/${body.token}`);
    assert.equal(opened.status, 200);
    assert.deepEqual(opened.body, { crew: { name: "Alex", own: false, size: 1, member: false } });
    assert.equal((await call("GET", `/api/invites/${body.token}`, ALEX)).body.crew.own, true);

    const forged = body.token.slice(0, 22) + "A".repeat(22);
    assert.equal((await call("GET", `/api/invites/${forged}`)).status, 404);
    assert.equal((await call("GET", "/api/invites/not-a-link")).status, 404);

    const renewed = await call("POST", "/api/me/invite/renew", ALEX);
    assert.equal(renewed.status, 200);
    assert.notEqual(renewed.body.token, body.token);
    assert.equal((await call("GET", `/api/invites/${body.token}`)).status, 404);
    assert.equal((await call("POST", `/api/invites/${body.token}/join`, HOST)).status, 404);
    assert.equal((await call("GET", `/api/invites/${renewed.body.token}`)).status, 200);
  });

  it("joins the friend who signs in, never the inviter, and never signed out", async () => {
    const { body } = await call("GET", "/api/me/invite", ALEX);
    assert.equal((await call("POST", `/api/invites/${body.token}/join`)).status, 401);
    const own = await call("POST", `/api/invites/${body.token}/join`, ALEX);
    assert.equal(own.status, 409);
    assert.equal(own.body.code, "own-invite");

    const joined = await call("POST", `/api/invites/${body.token}/join`, HOST);
    assert.deepEqual(joined.body, { crew: { name: "Alex", own: false, size: 2 }, joined: true });
    assert.equal((await call("GET", `/api/invites/${body.token}`, HOST)).body.crew.member, true);
  });

  it("shows a crew-only PC to its crew alone, on the wall and on the game page", async () => {
    await joinByLink();
    await offerPc("pc-1");
    const wall = (who: string) => call("GET", "/api/availability?appids=730&rtt=10", who);
    const list = (who: string) => call("GET", "/api/games/730/machines?minutes=30&rtt=10", who);

    assert.equal((await wall(STRANGER)).body[0].free, 0);
    assert.deepEqual((await list(STRANGER)).body.machines, []);
    assert.equal((await wall(ALEX)).body[0].free, 1);
    assert.deepEqual(
      (await list(ALEX)).body.machines.map((m: { id: string }) => m.id),
      ["pc-1"],
    );

    // Busy, it is not even counted as coming back for anyone outside.
    const booked = await call("POST", "/api/bookings", ALEX, { gameId: 730, minutes: 30, machineId: "pc-1" });
    assert.equal(booked.status, 202);
    assert.equal((await wall(STRANGER)).body[0].busy, 0);
    assert.deepEqual((await list(STRANGER)).body.busy, []);
  });

  it("refuses a stranger who picks a crew-only PC, as a machine taken", async () => {
    await joinByLink();
    await offerPc("pc-1");
    const picked = await call("POST", "/api/bookings", STRANGER, {
      gameId: 730,
      minutes: 30,
      machineId: "pc-1",
    });
    assert.equal(picked.status, 409);
    assert.equal(picked.body.nextBest, null);
  });

  it("lets the host app open its PC to anyone, or close it to the crew again", async () => {
    await joinByLink();
    const offered = await offerPc("pc-1");
    assert.deepEqual(offered.body.crew, { only: true, crews: [{ name: "Alex", own: false, size: 2 }] });
    assert.equal((await offerPc("pc-1", { crewOnly: false })).body.crew.only, false);
    assert.equal((await call("GET", "/api/availability?appids=730&rtt=10", STRANGER)).body[0].free, 1);
    assert.equal((await offerPc("pc-1", { crewOnly: "yes" })).status, 400);
  });

  it("lists the crew by Steam persona, never Steam id, and lets its owner remove and a member leave", async () => {
    await joinByLink();
    const mine = await call("GET", "/api/me/invite", ALEX);
    assert.deepEqual(
      mine.body.members.map((m: { name: string }) => m.name),
      ["Sam"],
    );
    assert.doesNotMatch(JSON.stringify(mine.body), new RegExp(HOST));
    const [sam] = mine.body.members;

    assert.equal((await call("POST", `/api/crew-members/${sam.id}/remove`)).status, 401);
    assert.equal((await call("POST", `/api/crew-members/${sam.id}/remove`, STRANGER)).status, 404);
    assert.equal((await call("POST", `/api/crew-members/${sam.id}/remove`, ALEX)).status, 200);
    assert.deepEqual((await call("GET", "/api/me/invite", ALEX)).body.members, []);

    // Back in by the link, the host leaves on their own.
    await call("POST", `/api/invites/${mine.body.token}/join`, HOST);
    const theirs = await call("GET", "/api/me/invite", HOST);
    assert.deepEqual(
      theirs.body.joined.map((c: { name: string }) => c.name),
      ["Alex"],
    );
    assert.equal((await call("POST", `/api/crew-members/${theirs.body.joined[0].id}/remove`, HOST)).status, 200);
    assert.deepEqual((await call("GET", "/api/me/invite", HOST)).body.joined, []);
  });
});
