// Crews: groups anyone founds in a tap and joins by the crew's one link,
// whoever in it shared it; PCs that play for the crews their owners pick,
// offered and matched to those crews alone (gate E7) however a renter comes to
// them: the wall, the game page, the queue, a machine picked from the list, or
// a claim; and a crew's readiness, which everyone in it hears about once.

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
import {
  CREW_NAME_MAX,
  crewNameOf,
  MAX_CREWS,
  PC_ARRIVED_MS,
  Platform,
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
/** Founds the crew, with no PC. */
const ALEX = "76561198000000011";
/** Alex's friend with a gaming PC. */
const HOST = "76561198000000012";
/** Someone in no crew of theirs. */
const STRANGER = "76561198000000013";
/** Another friend of Alex's, who plays and has a PC later. */
const JO = "76561198000000014";
/** pc-1 and pc-2 are the host's, pc-3 Jo's, pc-4 someone else's, open to anyone. */
const MACHINE_KEYS = [
  `pc-1:${HASH}:${HOST}`,
  `pc-2:${HASH}:${HOST}`,
  `pc-3:${HASH}:${JO}`,
  `pc-4:${HASH}:76561198000000099`,
].join(",");
const PERSONA: Record<string, string> = { [ALEX]: "Alex", [HOST]: "Sam", [JO]: "Jo" };

let now: number;
let platform: Platform;
/** Every crew-ready notice, in order: the crew and who was told. */
let ready: { crewId: string; memberIds: string[] }[];
const owners = parseMachineOwners(MACHINE_KEYS);

const open = async () => {
  ready = [];
  platform = await Platform.open({
    database: await testDatabase(),
    now: () => now,
    owners,
    onCrewReady: (crewId, memberIds) => ready.push({ crewId, memberIds }),
  });
};

/** Found a crew, as someone in fewer than MAX_CREWS crews. */
async function found(...args: Parameters<Platform["createCrew"]>) {
  const crew = await platform.createCrew(...args);
  assert.ok(crew !== "too-many");
  return crew;
}

const offer = (machineId: string, spec: MachineSpec = {}) =>
  platform.setAvailability(machineId, true, { ...REPORT, ...spec });

/** Alex's crew, and its link's invite. */
async function alexFounds() {
  const crew = await found(ALEX, "Alex");
  return { crewId: crew.id, inviteId: crew.inviteId! };
}

/** Alex's crew with the host in it, joined by its link, with no PC brought yet. */
async function hostJoinsAlex() {
  const crew = await alexFounds();
  const joined = await platform.joinCrew(crew.inviteId, HOST, "Sam");
  assert.ok(joined.ok);
  return crew;
}

/** Who may play on each offered machine, as the wall reads it. */
async function crewOf(machineId: string) {
  const { machines } = await platform.offeredMachines();
  return machines.find((m) => m.host.id === machineId)?.host.crew;
}

describe("crews", () => {
  beforeEach(async () => {
    now = Date.UTC(2026, 9, 6, 20);
    await open();
  });

  afterEach(() => platform.close());

  describe("founding and naming", () => {
    it("founds a crew in one tap, with its link, asking nothing about a PC", async () => {
      const crew = await found(ALEX, "Alex");
      assert.ok(crew.inviteId);
      assert.deepEqual(
        { ...crew, id: undefined, memberId: undefined, inviteId: undefined, members: undefined },
        {
          id: undefined,
          memberId: undefined,
          inviteId: undefined,
          members: undefined,
          name: "Alex",
          crewName: null,
          own: true,
          size: 1,
          state: "no-pc",
          pcs: 0,
          machines: [],
        },
      );
      assert.deepEqual(crew.members, [
        { id: crew.memberId, name: "Alex", you: true, admin: true, pc: null, pcs: 0 },
      ]);
      assert.deepEqual(await platform.crews(ALEX), [
        {
          id: crew.id,
          memberId: crew.memberId,
          name: "Alex",
          crewName: null,
          own: true,
          size: 1,
          state: "no-pc",
          pcs: 0,
          pcArrived: false,
        },
      ]);
    });

    it("lets anyone found several crews and be in several, each with a link of its own", async () => {
      const first = await found(ALEX, "Alex", "Freitagsrunde");
      now += 1000;
      const second = await found(ALEX, "Alex");
      now += 1000;
      assert.notEqual(first.inviteId, second.inviteId);
      assert.ok((await platform.joinCrew((await found(JO, "Jo")).inviteId!, ALEX)).ok);
      assert.deepEqual(
        (await platform.crews(ALEX)).map((c) => [c.crewName, c.name, c.own]),
        [
          ["Freitagsrunde", "Alex", true],
          [null, "Alex", true],
          [null, "Jo", false],
        ],
      );
    });

    it("renames as its admin only, cuts a long name, and names it after its admin again when emptied", async () => {
      const { crewId, inviteId } = await hostJoinsAlex();
      const renamed = await platform.renameCrew(crewId, ALEX, "  Couch \n Koop  ");
      assert.equal(renamed !== null && renamed !== "forbidden" && renamed.crewName, "Couch Koop");
      assert.equal(await platform.renameCrew(crewId, HOST, "Mine now"), "forbidden");
      assert.equal(await platform.renameCrew(crewId, STRANGER, "Mine now"), null);
      assert.equal((await platform.invite(inviteId))?.crewName, "Couch Koop");

      const long = await platform.renameCrew(crewId, ALEX, "x".repeat(40));
      assert.equal(long !== null && long !== "forbidden" && long.crewName, "x".repeat(CREW_NAME_MAX));
      const emptied = await platform.renameCrew(crewId, ALEX, "   ");
      assert.equal(emptied !== null && emptied !== "forbidden" && emptied.crewName, null);
    });

    it("keeps a name to what can be shown: no control characters, emoji counted as one", () => {
      assert.equal(crewNameOf("Zocker‮bande\u0007"), "Zockerbande");
      assert.equal(crewNameOf(`${"🎮".repeat(30)}`), "🎮".repeat(CREW_NAME_MAX));
      assert.equal(crewNameOf(42), null);
    });
    it("keeps anyone to MAX_CREWS crews, founded and joined alike", async () => {
      const joinable = await found(JO, "Jo");
      for (let i = 0; i < MAX_CREWS; i++) await found(ALEX, "Alex");
      assert.equal(await platform.createCrew(ALEX, "Alex"), "too-many");
      assert.deepEqual(await platform.joinCrew(joinable.inviteId!, ALEX), { ok: false, reason: "too-many" });
      // Leaving one makes room again; a crew they are in already still opens.
      const [first] = await platform.crews(ALEX);
      const again = await platform.joinCrew((await platform.crew(first!.id, ALEX))!.inviteId!, ALEX);
      assert.equal(again.ok && again.joined, false);
      assert.equal(await platform.leaveCrew(first!.memberId, ALEX), true);
      assert.equal((await platform.joinCrew(joinable.inviteId!, ALEX)).ok, true);
    });
  });

  describe("the crew's link", () => {
    it("joins whoever opens it to that crew, whoever in it shared it, once", async () => {
      const { crewId, inviteId } = await hostJoinsAlex();
      // The host shares the same link on: Jo lands in Alex's crew, not in one of the host's.
      assert.deepEqual(await platform.joinCrew(inviteId, JO, "Jo"), {
        ok: true,
        id: crewId,
        joined: true,
        crew: { name: "Alex", crewName: null, own: false, size: 3, state: "no-pc", pcs: 0 },
      });
      const again = await platform.joinCrew(inviteId, JO, "Jo");
      assert.equal(again.ok && again.joined, false);
      // Alex opening their crew's own link is already in it.
      assert.deepEqual(await platform.invite(inviteId, ALEX), {
        name: "Alex",
        crewName: null,
        own: true,
        size: 3,
        state: "no-pc",
        pcs: 0,
        member: true,
      });
      assert.equal((await platform.invite(inviteId, STRANGER))?.member, false);
      assert.deepEqual(await platform.joinCrew("no-such-invite", STRANGER), {
        ok: false,
        reason: "not-found",
      });
    });

    it("replaces the link for good, as its admin only", async () => {
      const { crewId, inviteId } = await hostJoinsAlex();
      assert.equal(await platform.renewCrewLink(crewId, HOST), "forbidden");
      assert.equal(await platform.renewCrewLink(crewId, STRANGER), null);
      const renewed = await platform.renewCrewLink(crewId, ALEX);
      assert.ok(renewed && renewed !== "forbidden");
      assert.notEqual(renewed.inviteId, inviteId);
      assert.equal(await platform.invite(inviteId), null);
      assert.deepEqual(await platform.joinCrew(inviteId, JO), { ok: false, reason: "not-found" });
      assert.ok((await platform.joinCrew(renewed.inviteId!, JO)).ok);
      // The host still sees the same crew, now with the new link.
      assert.equal((await platform.crew(crewId, HOST))?.inviteId, renewed.inviteId);
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

  describe("bringing a PC", () => {
    it("changes no PC when its owner joins: it stays as it was until they bring it", async () => {
      await offer("pc-1");
      const { crewId } = await hostJoinsAlex();
      assert.equal((await platform.heartbeat("pc-1")).crew.only, false);
      assert.equal((await platform.crew(crewId, ALEX))?.state, "no-pc");
    });

    it("makes the crew ready when a member brings a PC later, and tells everyone in it once", async () => {
      const { crewId } = await hostJoinsAlex();
      assert.equal((await platform.bringPc(crewId, HOST, "later"))?.members[1]?.pc, "later");
      assert.deepEqual(ready, []);

      // Weeks later the host says yes, before the PC was ever heard from.
      const brought = await platform.bringPc(crewId, HOST, "yes");
      assert.equal(brought?.state, "no-pc");
      assert.equal(brought?.members[1]?.pc, "yes");
      now += 60_000;
      const offered = await offer("pc-1");
      assert.equal(offered.crew.only, true);
      assert.deepEqual(
        offered.crew.crews.map((c) => [c.id, c.plays]),
        [[crewId, true]],
      );
      assert.deepEqual(ready, [{ crewId, memberIds: [ALEX, HOST] }]);
      // Whoever missed it live hears on their next visit; whoever joins later finds it ready.
      assert.equal((await platform.crews(ALEX))[0]?.pcArrived, true);
      const { inviteId } = (await platform.crew(crewId, ALEX))!;
      assert.ok((await platform.joinCrew(inviteId!, JO, "Jo")).ok);
      assert.equal((await platform.crews(JO))[0]?.pcArrived, false);

      const crew = await platform.crew(crewId, ALEX);
      assert.equal(crew?.state, "ready");
      assert.equal(crew?.pcs, 1);
      assert.deepEqual(crew?.machines, [{ name: "Nova-01", owner: "Sam", mine: false, state: "ready" }]);
      assert.equal((await platform.crew(crewId, HOST))?.machines[0]?.mine, true);

      // Away and back: the crew knows, and nobody is told twice.
      await platform.setAvailability("pc-1", false);
      assert.equal((await platform.crew(crewId, ALEX))?.state, "offline");
      assert.equal((await platform.crew(crewId, ALEX))?.machines[0]?.state, "offline");
      await offer("pc-1");
      assert.equal(ready.length, 1);
      const booked = await platform.book(730, 30, ALEX);
      assert.equal(booked.machine?.id, "pc-1");
      assert.equal((await platform.crew(crewId, ALEX))?.machines[0]?.state, "busy");
      assert.equal((await platform.crew(crewId, ALEX))?.state, "ready");
    });

    it("tells a member who was away about the first PC for a week after it came, then no more", async () => {
      const { crewId } = await hostJoinsAlex();
      await platform.bringPc(crewId, HOST, "yes");
      now += 60_000;
      await offer("pc-1");
      now += PC_ARRIVED_MS - 1;
      assert.equal((await platform.crews(ALEX))[0]?.pcArrived, true);
      now += 1;
      assert.equal((await platform.crews(ALEX))[0]?.pcArrived, false);
    });

    it("brings a PC its owner already offers at once", async () => {
      const { crewId } = await hostJoinsAlex();
      await offer("pc-1");
      await platform.bringPc(crewId, HOST, "yes");
      assert.equal((await platform.crew(crewId, ALEX))?.state, "ready");
      assert.equal(await platform.bookMachine("pc-1", 730, 30, STRANGER), null);
      assert.equal((await platform.book(730, 30, ALEX)).machine?.id, "pc-1");
    });

    it("has a founder's PC play for the crew they found", async () => {
      await offer("pc-1");
      const crew = await found(HOST, "Sam");
      assert.equal(crew.state, "ready");
      assert.equal(crew.members[0]?.pc, "yes");
      assert.deepEqual(ready, [{ crewId: crew.id, memberIds: [HOST] }]);
      assert.equal((await platform.heartbeat("pc-1")).crew.only, true);
      assert.equal(await platform.bookMachine("pc-1", 730, 30, STRANGER), null);
    });

    it("lets a crew have several PCs, and a PC owner be in several crews with a choice per crew", async () => {
      const alex = await hostJoinsAlex();
      now += 1000;
      const jo = await found(JO, "Jo");
      assert.ok((await platform.joinCrew(jo.inviteId!, HOST, "Sam")).ok);
      assert.ok((await platform.joinCrew(alex.inviteId, JO, "Jo")).ok);
      await offer("pc-1");
      await offer("pc-3");

      // The host brings their PC to Alex's crew only; Jo, who has one too, to both.
      await platform.bringPc(alex.crewId, HOST, "yes");
      await platform.bringPc(alex.crewId, JO, "yes");
      const both = await platform.crew(alex.crewId, ALEX);
      assert.equal(both?.pcs, 2);
      assert.deepEqual(
        both?.machines.map((m) => m.owner),
        ["Sam", "Jo"],
      );
      assert.deepEqual(await crewOf("pc-1"), [ALEX, HOST, JO].sort());
      // Jo founded a crew before having a PC: it plays there only once Jo brings it.
      assert.equal((await platform.crew(jo.id, JO))?.pcs, 0);

      // In the host app the host moves their PC to Jo's crew alone.
      const moved = await offer("pc-1", { crews: [jo.id] });
      assert.deepEqual(
        moved.crew.crews.map((c) => [c.name, c.plays]),
        [
          ["Alex", false],
          ["Jo", true],
        ],
      );
      assert.equal((await platform.crew(alex.crewId, ALEX))?.pcs, 1);
      assert.deepEqual(await crewOf("pc-1"), [HOST, JO].sort());
      // A crew its owner is not in is ignored.
      const stranger = await found(STRANGER, "Kim");
      assert.deepEqual(
        (await offer("pc-1", { crews: [stranger.id, jo.id] })).crew.crews
          .filter((c) => c.plays)
          .map((c) => c.name),
        ["Jo"],
      );
    });

    it("takes a member's PCs out of the crew, and leaves the question put off", async () => {
      const { crewId } = await hostJoinsAlex();
      await offer("pc-1");
      await platform.bringPc(crewId, HOST, "yes");
      const out = await platform.bringPc(crewId, HOST, "off");
      assert.equal(out?.state, "no-pc");
      assert.equal(out?.members[1]?.pc, "later");
      // Crew-only and in no crew, it plays for nobody.
      assert.deepEqual(await crewOf("pc-1"), []);
      assert.equal(await platform.bringPc(crewId, STRANGER, "yes"), null);
    });

    it("starts a new PC crew-only while its owner shares a crew, playing for nobody until they pick", async () => {
      await hostJoinsAlex();
      const offered = await offer("pc-2");
      assert.equal(offered.crew.only, true);
      assert.deepEqual(await crewOf("pc-2"), []);
      // Someone else's, whose owner is in no crew, is open as ever.
      assert.equal((await offer("pc-4")).crew.only, false);
    });

    it("keeps a PC open while its owner is only in a crew of their own without bringing it", async () => {
      await found(HOST, "Sam");
      assert.equal((await offer("pc-1")).crew.only, false);
    });
  });

  describe("who may play where", () => {
    it("never matches a crew-only PC to anyone outside its crews, and does to the crew", async () => {
      const { crewId } = await hostJoinsAlex();
      await platform.bringPc(crewId, HOST, "yes");
      await offer("pc-1");
      const stranger = await platform.book(730, 30, STRANGER);
      assert.equal(stranger.status, "queued");
      assert.equal(await platform.bookMachine("pc-1", 730, 30, STRANGER), null);

      const alex = await platform.book(730, 30, ALEX);
      assert.equal(alex.status, "matched");
      assert.equal(alex.machine?.id, "pc-1");
      assert.equal((await platform.booking(stranger.bookingId, STRANGER))?.status, "queued");
    });

    it("keeps the old host app's switch working: crew only plays for every crew, off opens it", async () => {
      const { crewId } = await hostJoinsAlex();
      await offer("pc-1", { crewOnly: false });
      const stranger = await platform.book(730, 30, STRANGER);
      assert.equal(stranger.machine?.id, "pc-1");
      await platform.endBooking(stranger.bookingId, STRANGER);

      // An offer that leaves both out keeps what was chosen.
      assert.equal((await offer("pc-1")).crew.only, false);
      const closed = await offer("pc-1", { crewOnly: true });
      assert.equal(closed.crew.only, true);
      assert.deepEqual(
        closed.crew.crews.map((c) => [c.id, c.plays]),
        [[crewId, true]],
      );
      assert.equal(await platform.bookMachine("pc-1", 730, 30, STRANGER), null);
    });

    it("refuses a claim on a PC taken from the renter's crew since the match, and queues the booking again", async () => {
      const { crewId } = await hostJoinsAlex();
      await platform.bringPc(crewId, HOST, "yes");
      await offer("pc-1");
      const booked = await platform.book(730, 30, ALEX);
      assert.equal(booked.machine?.id, "pc-1");
      await platform.bringPc(crewId, HOST, "off");

      assert.deepEqual(await platform.claim(booked.bookingId, ALEX), {
        ok: false,
        reason: "not-claimable",
        status: "queued",
      });
      assert.equal((await platform.heartbeat("pc-1")).status, "available");
    });

    it("tells the wall's reads who may see each PC", async () => {
      const { crewId } = await hostJoinsAlex();
      await platform.bringPc(crewId, HOST, "yes");
      await offer("pc-1");
      await offer("pc-4");
      assert.deepEqual(await crewOf("pc-1"), [ALEX, HOST].sort());
      assert.equal(await crewOf("pc-4"), undefined);
    });
  });

  describe("leaving and removing", () => {
    it("lets the admin remove a member, who from then on matches none of the crew's PCs", async () => {
      const { crewId, inviteId } = await hostJoinsAlex();
      now += 60_000;
      await platform.joinCrew(inviteId, JO, "Jo");
      await platform.bringPc(crewId, HOST, "yes");
      await offer("pc-1");
      const { members } = (await platform.crew(crewId, ALEX))!;
      assert.deepEqual(
        members.map((m) => m.name),
        ["Alex", "Sam", "Jo"],
      );
      const jo = members[2]!;
      // Nobody else may remove them: not another member, not a member removing someone else.
      assert.equal(await platform.leaveCrew(jo.id, HOST), false);
      assert.equal(await platform.leaveCrew(members[1]!.id, JO), false);
      assert.equal(await platform.leaveCrew("no-such-member", ALEX), false);

      assert.equal(await platform.leaveCrew(jo.id, ALEX), true);
      assert.equal(await platform.leaveCrew(jo.id, ALEX), false);
      assert.equal((await platform.book(730, 30, JO)).status, "queued");
      assert.equal(await platform.bookMachine("pc-1", 730, 30, JO), null);
      assert.deepEqual(await crewOf("pc-1"), [ALEX, HOST].sort());
      assert.equal(await platform.crew(crewId, JO), null);
    });

    it("has a member's PC leave with them, and come back only when they bring it again", async () => {
      const { crewId, inviteId } = await hostJoinsAlex();
      await platform.bringPc(crewId, HOST, "yes");
      await offer("pc-1");
      const mine = (await platform.crews(HOST))[0]!;
      assert.equal(await platform.leaveCrew(mine.memberId, HOST), true);
      assert.equal((await platform.crew(crewId, ALEX))?.state, "no-pc");
      assert.deepEqual((await platform.heartbeat("pc-1")).crew, { only: true, crews: [] });
      const queued = await platform.book(730, 30, ALEX);
      assert.equal(queued.status, "queued");

      // Back in by the link, the host is asked again; bringing the PC matches the queue anew.
      assert.ok((await platform.joinCrew(inviteId, HOST, "Sam")).ok);
      assert.equal((await platform.booking(queued.bookingId, ALEX))?.status, "queued");
      await platform.bringPc(crewId, HOST, "yes");
      assert.equal((await platform.booking(queued.bookingId, ALEX))?.status, "matched");
    });

    it("hands the crew to the longest member when its admin leaves, and archives it when the last one goes", async () => {
      const { crewId, inviteId } = await hostJoinsAlex();
      now += 60_000;
      await platform.joinCrew(inviteId, JO, "Jo");
      const alex = (await platform.crews(ALEX))[0]!;
      assert.equal(await platform.leaveCrew(alex.memberId, ALEX), true);
      const handed = await platform.crew(crewId, HOST);
      assert.equal(handed?.own, true);
      assert.equal(handed?.name, "Sam");
      assert.equal((await platform.renameCrew(crewId, HOST, "Sams Runde")) !== "forbidden", true);

      for (const who of [JO, HOST]) {
        const member = (await platform.crews(who))[0]!;
        assert.equal(await platform.leaveCrew(member.memberId, who), true);
      }
      assert.equal(await platform.invite(inviteId), null, "an archived crew's link opens nothing");
      assert.deepEqual(await platform.joinCrew(inviteId, STRANGER), { ok: false, reason: "not-found" });
    });

    it("sends a match made before the removal back to the queue at the claim", async () => {
      const { crewId, inviteId } = await hostJoinsAlex();
      await platform.joinCrew(inviteId, JO, "Jo");
      await platform.bringPc(crewId, HOST, "yes");
      await offer("pc-1");
      const booked = await platform.book(730, 30, JO);
      assert.equal(booked.machine?.id, "pc-1");

      const { members } = (await platform.crew(crewId, ALEX))!;
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

  /** Alex founds a crew; the host opens its link and joins. */
  async function joinByLink() {
    const { body } = await call("POST", "/api/crews", ALEX, {});
    const joined = await call("POST", `/api/invites/${body.crew.token}/join`, HOST);
    assert.equal(joined.status, 200);
    return body.crew as { id: string; token: string };
  }

  it("founds a crew for a signed-in player, named after their Steam persona until it has a name", async () => {
    assert.equal((await call("POST", "/api/crews")).status, 401);
    const { status, body } = await call("POST", "/api/crews", ALEX, {});
    assert.equal(status, 201);
    assert.match(body.crew.token, /^[\w-]{44}$/);
    assert.equal(body.crew.inviteId, undefined, "the invite id the database holds never leaves the server");
    assert.equal(body.crew.name, "Alex");
    assert.equal(body.crew.crewName, null);
    assert.equal(body.crew.state, "no-pc");

    now += 1000;
    const named = await call("POST", "/api/crews", ALEX, { name: "Freitagsrunde" });
    assert.equal(named.body.crew.crewName, "Freitagsrunde");
    assert.equal((await call("POST", "/api/crews", ALEX, { name: 7 })).status, 400);
    assert.deepEqual(
      (await call("GET", "/api/crews", ALEX)).body.crews.map((c: { crewName: string | null }) => c.crewName),
      [null, "Freitagsrunde"],
    );
    assert.equal((await call("GET", "/api/crews")).status, 401);
  });

  it("refuses to found or join past MAX_CREWS crews with 409", async () => {
    const { body } = await call("POST", "/api/crews", JO, {});
    for (let i = 0; i < MAX_CREWS; i++)
      assert.equal((await call("POST", "/api/crews", ALEX, {})).status, 201);
    const founding = await call("POST", "/api/crews", ALEX, {});
    assert.equal(founding.status, 409);
    assert.equal(founding.body.code, "too-many-crews");
    const joining = await call("POST", `/api/invites/${body.crew.token}/join`, ALEX);
    assert.equal(joining.status, 409);
    assert.equal(joining.body.code, "too-many-crews");
  });

  it("shows a crew only to the people in it, never by Steam id", async () => {
    const crew = await joinByLink();
    const read = await call("GET", `/api/crews/${crew.id}`, HOST);
    assert.equal(read.status, 200);
    assert.equal(read.body.crew.token, crew.token, "anyone in it shares the same link");
    assert.deepEqual(
      read.body.crew.members.map((m: { name: string; you: boolean; admin: boolean }) => [
        m.name,
        m.you,
        m.admin,
      ]),
      [
        ["Alex", false, true],
        ["Sam", true, false],
      ],
    );
    assert.doesNotMatch(JSON.stringify(read.body), new RegExp(`${ALEX}|${HOST}`));
    assert.equal((await call("GET", `/api/crews/${crew.id}`, STRANGER)).status, 404);
    assert.equal((await call("GET", "/api/crews/no-such-crew", ALEX)).status, 404);
    assert.equal((await call("GET", `/api/crews/${crew.id}`)).status, 401);
  });

  it("renames and replaces the link for its admin alone", async () => {
    const crew = await joinByLink();
    const renamed = await call("POST", `/api/crews/${crew.id}/name`, ALEX, { name: "Couch-Koop" });
    assert.equal(renamed.body.crew.crewName, "Couch-Koop");
    assert.equal((await call("POST", `/api/crews/${crew.id}/name`, HOST, { name: "Nope" })).status, 403);
    assert.equal((await call("POST", `/api/crews/${crew.id}/name`, ALEX, {})).status, 400);
    assert.equal((await call("POST", `/api/crews/${crew.id}/name`, STRANGER, { name: "x" })).status, 404);

    assert.equal((await call("POST", `/api/crews/${crew.id}/link`, HOST)).status, 403);
    const renewed = await call("POST", `/api/crews/${crew.id}/link`, ALEX);
    assert.notEqual(renewed.body.crew.token, crew.token);
    assert.equal((await call("GET", `/api/invites/${crew.token}`)).status, 404);
    assert.equal((await call("GET", `/api/invites/${renewed.body.crew.token}`)).status, 200);
  });

  it("names the crew to anyone who opens its link, signed out too, and refuses a forged one", async () => {
    const { body } = await call("POST", "/api/crews", ALEX, { name: "Freitagsrunde" });
    const opened = await call("GET", `/api/invites/${body.crew.token}`);
    assert.equal(opened.status, 200);
    assert.deepEqual(opened.body, {
      crew: {
        name: "Alex",
        crewName: "Freitagsrunde",
        own: false,
        size: 1,
        state: "no-pc",
        pcs: 0,
        member: false,
      },
    });
    assert.equal((await call("GET", `/api/invites/${body.crew.token}`, ALEX)).body.crew.member, true);

    const forged = body.crew.token.slice(0, 22) + "A".repeat(22);
    assert.equal((await call("GET", `/api/invites/${forged}`)).status, 404);
    assert.equal((await call("GET", "/api/invites/not-a-link")).status, 404);
  });

  it("joins the friend who signs in, and never signed out", async () => {
    const { body } = await call("POST", "/api/crews", ALEX, {});
    assert.equal((await call("POST", `/api/invites/${body.crew.token}/join`)).status, 401);
    const joined = await call("POST", `/api/invites/${body.crew.token}/join`, HOST);
    assert.deepEqual(joined.body, {
      id: body.crew.id,
      crew: { name: "Alex", crewName: null, own: false, size: 2, state: "no-pc", pcs: 0 },
      joined: true,
    });
    const own = await call("POST", `/api/invites/${body.crew.token}/join`, ALEX);
    assert.equal(own.status, 200);
    assert.equal(own.body.joined, false);
  });

  it("brings a member's PC to the crew, puts it off, or takes it out", async () => {
    const crew = await joinByLink();
    await offerPc("pc-1");
    assert.equal((await call("POST", `/api/crews/${crew.id}/pc`, HOST, { pc: "maybe" })).status, 400);
    assert.equal((await call("POST", `/api/crews/${crew.id}/pc`, STRANGER, { pc: "yes" })).status, 404);
    const later = await call("POST", `/api/crews/${crew.id}/pc`, HOST, { pc: "later" });
    assert.equal(later.body.crew.members[1].pc, "later");
    const yes = await call("POST", `/api/crews/${crew.id}/pc`, HOST, { pc: "yes" });
    assert.equal(yes.body.crew.state, "ready");
    assert.deepEqual(yes.body.crew.machines, [{ name: "Nova-01", owner: "Sam", mine: true, state: "ready" }]);
    const off = await call("POST", `/api/crews/${crew.id}/pc`, HOST, { pc: "off" });
    assert.equal(off.body.crew.state, "no-pc");
  });

  it("shows a crew-only PC to its crew alone, on the wall and on the game page", async () => {
    const crew = await joinByLink();
    await call("POST", `/api/crews/${crew.id}/pc`, HOST, { pc: "yes" });
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
    const crew = await joinByLink();
    await call("POST", `/api/crews/${crew.id}/pc`, HOST, { pc: "yes" });
    await offerPc("pc-1");
    const picked = await call("POST", "/api/bookings", STRANGER, {
      gameId: 730,
      minutes: 30,
      machineId: "pc-1",
    });
    assert.equal(picked.status, 409);
    assert.equal(picked.body.nextBest, null);
  });

  it("lets the host app pick the crews its PC plays for, one by one", async () => {
    const crew = await joinByLink();
    const offered = await offerPc("pc-1");
    assert.deepEqual(offered.body.crew, {
      only: true,
      crews: [
        {
          id: crew.id,
          name: "Alex",
          crewName: null,
          own: false,
          size: 2,
          state: "no-pc",
          pcs: 0,
          plays: false,
        },
      ],
    });
    const picked = await offerPc("pc-1", { crews: [crew.id] });
    assert.equal(picked.body.crew.crews[0].plays, true);
    assert.equal(picked.body.crew.crews[0].state, "ready");
    assert.equal((await call("GET", "/api/availability?appids=730&rtt=10", ALEX)).body[0].free, 1);
    assert.equal((await call("GET", "/api/availability?appids=730&rtt=10", STRANGER)).body[0].free, 0);

    assert.equal((await offerPc("pc-1", { crews: "all" })).status, 400);
    assert.equal((await offerPc("pc-1", { crews: [7] })).status, 400);
    assert.equal((await offerPc("pc-1", { crewOnly: "yes" })).status, 400);
  });

  it("keeps the choice the host app sends from Windows for a rental-mode PC, which Swiff OS offers without one", async () => {
    const crew = await joinByLink();
    const fromWindows = (choice: object) => offerPc("pc-1", { available: false, ...choice });
    const free = async (who: string) =>
      (await call("GET", "/api/availability?appids=730&rtt=10", who)).body[0].free;

    assert.equal((await fromWindows({ crewOnly: false })).body.crew.only, false);
    assert.equal(await free(STRANGER), 0, "off offer while in Windows");
    assert.equal((await offerPc("pc-1")).body.crew.only, false);
    assert.equal(await free(STRANGER), 1);
    // Its restart between renters keeps it.
    await offerPc("pc-1", { available: false, reset: true });
    assert.equal((await offerPc("pc-1")).body.crew.only, false);

    assert.equal((await fromWindows({ crews: [crew.id] })).body.crew.only, true);
    assert.equal((await offerPc("pc-1")).body.crew.crews[0].plays, true);
    assert.equal(await free(STRANGER), 0);
    assert.equal(await free(ALEX), 1);
  });

  it("lists the crew by Steam persona and lets its admin remove and a member leave", async () => {
    const crew = await joinByLink();
    const read = await call("GET", `/api/crews/${crew.id}`, ALEX);
    const sam = read.body.crew.members[1];

    assert.equal((await call("POST", `/api/crew-members/${sam.id}/remove`)).status, 401);
    assert.equal((await call("POST", `/api/crew-members/${sam.id}/remove`, STRANGER)).status, 404);
    assert.equal((await call("POST", `/api/crew-members/${sam.id}/remove`, ALEX)).status, 200);
    assert.equal((await call("GET", `/api/crews/${crew.id}`, ALEX)).body.crew.size, 1);

    // Back in by the link, the host leaves on their own.
    await call("POST", `/api/invites/${crew.token}/join`, HOST);
    const theirs = await call("GET", "/api/crews", HOST);
    assert.equal(theirs.body.crews.length, 1);
    assert.equal(
      (await call("POST", `/api/crew-members/${theirs.body.crews[0].memberId}/remove`, HOST)).status,
      200,
    );
    assert.deepEqual((await call("GET", "/api/crews", HOST)).body.crews, []);
  });

  it("founds no crew behind the old personal link, which is gone", async () => {
    assert.equal((await call("GET", "/api/me/invite", ALEX)).status, 404);
    assert.equal((await call("POST", "/api/me/invite/renew", ALEX)).status, 404);
    assert.deepEqual((await call("GET", "/api/crews", ALEX)).body.crews, []);
  });
});
