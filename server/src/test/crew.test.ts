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
import type { CatalogGame } from "../catalog.js";
import { RequestBudget } from "../budget.js";
import {
  CREW_NAME_MAX,
  crewNameOf,
  MAX_CREWS,
  PC_ARRIVED_MS,
  Platform,
  SESSION_OVER_MS,
  type MachineSpec,
} from "../platform.js";
import { SESSION_COOKIE } from "../signin.js";
import { emptyProfile } from "../steam.js";
import type { Database } from "../db.js";
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
/** The Steam libraries the API tests read, ascending: everyone owns Counter-Strike 2. */
const LIBRARIES: Record<string, number[]> = { [ALEX]: [550, 730], [HOST]: [550, 620, 730] };
/** A store entry for a test game. */
const media = (appid: number, name: string, free: boolean): CatalogGame => ({
  appid,
  name,
  free,
  art: { hero: null, capsule: `https://cdn.example/${appid}.jpg` },
  preview: null,
  trailer: null,
});
/** The store's answer for the games on the test PCs; 999 is installed but not a game. */
const MEDIA: Record<number, CatalogGame> = {
  730: media(730, "Counter-Strike 2", true),
  570: media(570, "Dota 2", true),
  550: media(550, "Left 4 Dead 2", false),
  620: media(620, "Portal 2", false),
  440: media(440, "Team Fortress 2", false),
};

let now: number;
let platform: Platform;
/** The database the platform under test runs on, for state no API call reaches. */
let database: Database;
/** Every crew-ready notice, in order: the crew and who was told. */
let ready: { crewId: string; memberIds: string[] }[];
const owners = parseMachineOwners(MACHINE_KEYS);

const open = async () => {
  ready = [];
  database = await testDatabase();
  platform = await Platform.open({
    database,
    now: () => now,
    owners,
    onCrewReady: (crewId, memberIds) => ready.push({ crewId, memberIds }),
  });
};

/** Found a crew, as someone in fewer than MAX_CREWS crews. */
async function found(...args: Parameters<Platform["createCrew"]>) {
  const crew = await platform.createCrew(...args);
  assert.ok(crew !== "too-many" && !("taken" in crew));
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
          session: null,
          shared: false,
          machines: [],
          busy: [],
          picks: 0,
          offered: 0,
        },
      );
      assert.deepEqual(crew.members, [
        { id: crew.memberId, name: "Alex", you: true, admin: true, pc: null, pcs: 0, rsvp: null, next: null },
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
          session: null,
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
      assert.equal(
        renamed !== null && renamed !== "forbidden" && !("taken" in renamed) && renamed.crewName,
        "Couch Koop",
      );
      assert.equal(await platform.renameCrew(crewId, HOST, "Mine now"), "forbidden");
      assert.equal(await platform.renameCrew(crewId, STRANGER, "Mine now"), null);
      assert.equal((await platform.invite(inviteId))?.crewName, "Couch Koop");

      const long = await platform.renameCrew(crewId, ALEX, "x".repeat(40));
      assert.equal(
        long !== null && long !== "forbidden" && !("taken" in long) && long.crewName,
        "x".repeat(CREW_NAME_MAX),
      );
      const emptied = await platform.renameCrew(crewId, ALEX, "   ");
      assert.equal(
        emptied !== null && emptied !== "forbidden" && !("taken" in emptied) && emptied.crewName,
        null,
      );
    });

    it("refuses a crew of a name its founder has a crew by, whatever its case, and says which", async () => {
      const night = await found(ALEX, "Alex", "Night Owls");
      // Jo's crew of the same name: Alex joins it all the same.
      const jos = await found(JO, "Jo", "Zockerbande");
      assert.ok((await platform.joinCrew(jos.inviteId!, ALEX, "Alex")).ok);
      assert.deepEqual(await platform.createCrew(ALEX, "Alex", "  NIGHT   owls "), {
        taken: { id: night.id, name: "Alex", crewName: "Night Owls", own: true },
      });
      // A crew they joined counts as theirs.
      assert.deepEqual(await platform.createCrew(ALEX, "Alex", "zockerbande"), {
        taken: { id: jos.id, name: "Jo", crewName: "Zockerbande", own: false },
      });
      // Another person's crew of that name is no reason to refuse it.
      assert.equal((await found(HOST, "Sam", "Night Owls")).crewName, "Night Owls");
      assert.equal((await found(ALEX, "Alex", "Night Owls 2")).crewName, "Night Owls 2");
    });

    it("lets its founder be the admin of one crew with no name of its own, called after them, at most", async () => {
      const first = await found(ALEX, "Alex");
      assert.deepEqual(await platform.createCrew(ALEX, "Alex"), {
        taken: { id: first.id, name: "Alex", crewName: null, own: true },
      });
      // Jo's crew with no name is called after Jo: Alex may still found one, and join Jo's.
      const jos = await found(JO, "Jo");
      assert.ok((await platform.joinCrew(jos.inviteId!, ALEX, "Alex")).ok);
      assert.equal((await found(HOST, "Sam")).crewName, null);
      // Named, the first one makes room for another with no name.
      await platform.renameCrew(first.id, ALEX, "Freitagsrunde");
      assert.equal((await found(ALEX, "Alex")).crewName, null);
    });

    it("lets a member take over a crew with no name while admin of one, and keeps to their oldest", async () => {
      const own = await found(HOST, "Sam");
      now += 1000;
      const jos = await found(JO, "Jo");
      now += 1000;
      assert.ok((await platform.joinCrew(jos.inviteId!, HOST, "Sam")).ok);
      now += 1000;
      // Jo leaves: the host takes Jo's crew over, a second one called after them.
      assert.equal(await platform.leaveCrew(jos.memberId, JO), true);
      assert.deepEqual(
        (await platform.crews(HOST)).map((c) => [c.id, c.crewName, c.own]),
        [
          [own.id, null, true],
          [jos.id, null, true],
        ],
      );
      assert.deepEqual(await platform.createCrew(HOST, "Sam"), {
        taken: { id: own.id, name: "Sam", crewName: null, own: true },
      });
      await offer("pc-1", { crews: [] });
      const seat = await platform.createSeat("pc-1", "Mia", "Sam");
      assert.ok(seat.ok);
      assert.equal(seat.seat.crewId, own.id);
    });

    it("founds once for a founding sent again with the same key, and anew for another key", async () => {
      const crew = await found(ALEX, "Alex", "Freitagsrunde", "key-1");
      now += 1000;
      const again = await found(ALEX, "Alex", "Freitagsrunde", "key-1");
      assert.equal(again.id, crew.id);
      assert.deepEqual(
        (await platform.crews(ALEX)).map((c) => c.id),
        [crew.id],
      );
      // The key is the founder's own: Jo's founding with it is a crew of Jo's.
      const jos = await found(JO, "Jo", "Freitagsrunde", "key-1");
      assert.notEqual(jos.id, crew.id);
      // A new key with a name they have is refused rather than founding a second.
      assert.deepEqual(await platform.createCrew(ALEX, "Alex", "Freitagsrunde", "key-2"), {
        taken: { id: crew.id, name: "Alex", crewName: "Freitagsrunde", own: true },
      });
      // Left, the crew a key founded is no answer to it any more: it founds anew.
      assert.equal(await platform.leaveCrew(crew.memberId, ALEX), true);
      const anew = await found(ALEX, "Alex", "Freitagsrunde", "key-1");
      assert.notEqual(anew.id, crew.id);
    });

    it("lets a key go with its crew's admin: the new admin's own founding by it stays theirs", async () => {
      const alexs = await found(ALEX, "Alex", "Freitagsrunde", "key-1");
      const jos = await found(JO, "Jo", "Montagsrunde", "key-1");
      assert.ok((await platform.joinCrew(alexs.inviteId!, JO, "Jo")).ok);
      assert.equal(await platform.leaveCrew(alexs.memberId, ALEX), true);
      assert.equal((await platform.crew(alexs.id, JO))?.own, true);
      assert.equal((await found(JO, "Jo", "Montagsrunde", "key-1")).id, jos.id);
    });

    it("refuses a new name the admin has another crew by, and keeps the one it has", async () => {
      const night = await found(ALEX, "Alex", "Night Owls");
      const other = await found(ALEX, "Alex", "Couch Koop");
      assert.deepEqual(await platform.renameCrew(other.id, ALEX, "night OWLS"), {
        taken: { id: night.id, name: "Alex", crewName: "Night Owls", own: true },
      });
      const unnamed = await found(ALEX, "Alex");
      assert.deepEqual(await platform.renameCrew(other.id, ALEX, " "), {
        taken: { id: unnamed.id, name: "Alex", crewName: null, own: true },
      });
      // Its own name again, in another case too, is no clash.
      const same = await platform.renameCrew(night.id, ALEX, "Night Owls");
      assert.ok(same && same !== "forbidden" && !("taken" in same));
      const recased = await platform.renameCrew(night.id, ALEX, "NIGHT OWLS");
      assert.ok(recased && recased !== "forbidden" && !("taken" in recased));
      assert.equal(recased.crewName, "NIGHT OWLS");
    });

    it("keeps crews of the same name a person had before, and founds no more of it", async () => {
      const first = await found(ALEX, "Alex", "Zockerbande");
      // Two of the same name, as founding made them before names were checked.
      await database.query(
        "INSERT INTO crews (id, owner_id, owner_name, name, created_at) VALUES ($1, $2, $3, $4, $5)",
        ["old-crew", ALEX, "Alex", "zockerbande", now],
      );
      await database.query(
        "INSERT INTO crew_members (id, crew_id, user_id, name, joined_at) VALUES ($1, $2, $3, $4, $5)",
        ["old-member", "old-crew", ALEX, "Alex", now + 1],
      );
      assert.deepEqual(
        (await platform.crews(ALEX)).map((c) => c.crewName),
        ["Zockerbande", "zockerbande"],
      );
      const refused = await platform.createCrew(ALEX, "Alex", "ZOCKERBANDE");
      assert.ok(refused !== "too-many" && "taken" in refused);
      // Saving either one's name unchanged still works.
      const kept = await platform.renameCrew(first.id, ALEX, "Zockerbande");
      assert.ok(kept && kept !== "forbidden" && !("taken" in kept));
      // So does a new spelling of its own name, the other one of that name notwithstanding.
      const recased = await platform.renameCrew(first.id, ALEX, "ZOCKERBANDE");
      assert.ok(recased && recased !== "forbidden" && !("taken" in recased));
      assert.equal(recased.crewName, "ZOCKERBANDE");
      const widened = await platform.renameCrew(first.id, ALEX, "Ｚｏｃｋｅｒｂａｎｄｅ");
      assert.ok(widened && widened !== "forbidden" && !("taken" in widened), "NFKC: the same name");
      assert.equal(widened.crewName, "Ｚｏｃｋｅｒｂａｎｄｅ");
      // A name other than its own is still refused for the other one.
      const other = await found(ALEX, "Alex", "Couch Koop");
      const clash = await platform.renameCrew(other.id, ALEX, "ZockerBande");
      assert.ok(clash && clash !== "forbidden" && "taken" in clash);
    });

    it("keeps a name to what can be shown: no control characters, emoji counted as one", () => {
      assert.equal(crewNameOf("Zocker‮bande\u0007"), "Zockerbande");
      assert.equal(crewNameOf(`${"🎮".repeat(30)}`), "🎮".repeat(CREW_NAME_MAX));
      assert.equal(crewNameOf(42), null);
    });
    it("keeps anyone to MAX_CREWS crews, founded and joined alike", async () => {
      const joinable = await found(JO, "Jo");
      for (let i = 0; i < MAX_CREWS; i++) await found(ALEX, "Alex", `Crew ${i}`);
      assert.equal(await platform.createCrew(ALEX, "Alex", "One more"), "too-many");
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
      now += 1000;
      assert.deepEqual(await platform.joinCrew(inviteId, JO, "Jo"), {
        ok: true,
        id: crewId,
        joined: true,
        crew: { name: "Alex", crewName: null, own: false, size: 3, state: "no-pc", pcs: 0, session: null },
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
        session: null,
        member: true,
        removed: false,
        guests: [
          { name: "Alex", admin: true, rsvp: null },
          { name: "Sam", admin: false, rsvp: null },
          { name: "Jo", admin: false, rsvp: null },
        ],
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
      assert.deepEqual(crew?.machines, [
        {
          id: "pc-1",
          name: "Nova-01",
          owner: "Sam",
          mine: false,
          state: "ready",
          games: [570, 730],
          playing: null,
        },
      ]);
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
      // Only its owner reads on the crew page whether the PC is open to anyone too.
      assert.equal((await platform.crew(crewId, HOST))?.machines[0]?.crewOnly, true);
      assert.equal((await platform.crew(crewId, ALEX))?.machines[0]?.crewOnly, undefined);
      assert.equal((await platform.crew(crewId, HOST))?.machines[0]?.crews, 1);
      assert.equal((await platform.crew(crewId, ALEX))?.machines[0]?.crews, undefined);
      assert.deepEqual(
        closed.crew.crews.map((c) => [c.id, c.plays]),
        [[crewId, true]],
      );
      assert.equal(await platform.bookMachine("pc-1", 730, 30, STRANGER), null);
      // Playing for a second crew of its owner's, it is no longer this crew's alone.
      const own = await found(HOST, "Sam");
      await offer("pc-1", { crews: [crewId, own.id] });
      assert.equal((await platform.crew(crewId, HOST))?.machines[0]?.crews, 2);
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

    it("lets someone the admin removed back only by a new link, and one who left by the same one", async () => {
      const { crewId, inviteId } = await hostJoinsAlex();
      await platform.joinCrew(inviteId, JO, "Jo");
      const members = (await platform.crew(crewId, ALEX))!.members;
      assert.equal(await platform.leaveCrew(members.find((m) => m.name === "Jo")!.id, ALEX), true);
      assert.deepEqual(await platform.joinCrew(inviteId, JO, "Jo"), { ok: false, reason: "not-found" });
      assert.equal(await platform.crew(crewId, JO), null);
      // The old link tells them they are out, and shows them neither who is in nor the Zockrunde; others see the invite.
      assert.equal(typeof (await platform.setCrewSession(crewId, ALEX, now + 86_400_000)), "object");
      const out = await platform.invite(inviteId, JO);
      assert.equal(out?.removed, true);
      assert.equal(out?.member, false);
      assert.equal(out?.session, null);
      assert.deepEqual(out?.guests, []);
      const other = await platform.invite(inviteId, STRANGER);
      assert.equal(other?.removed, false);
      assert.notEqual(other?.session, null);
      assert.equal(other?.guests.length, 2);

      // Leaving by themselves keeps the way back open.
      const sam = members.find((m) => m.name === "Sam")!;
      assert.equal(await platform.leaveCrew(sam.id, HOST), true);
      assert.equal((await platform.joinCrew(inviteId, HOST, "Sam")).ok, true);

      // The admin's new link lets Jo in again, and from then on the old removal is gone.
      assert.ok(await platform.renewCrewLink(crewId, ALEX));
      const renewed = (await platform.crew(crewId, ALEX))!.inviteId!;
      assert.notEqual(renewed, inviteId);
      const back = await platform.joinCrew(renewed, JO, "Jo");
      assert.equal(back.ok && back.joined, true);
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
  /** Store lookups for game media, and whether the store fails them, answers only for MEDIA, or throws after the first. */
  let lookups = 0;
  let store: "up" | "down" | "partly" | "throws" = "up";
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
      library: Uint32Array.from(LIBRARIES[steamId] ?? [730]),
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
        gameMedia: async (appids) => {
          lookups++;
          if (store === "down") return { games: [], failed: true };
          if (store === "throws" && lookups > 1) throw new Error("lookup broke");
          if (store === "partly")
            return { games: appids.flatMap((appid) => MEDIA[appid] ?? []), failed: true };
          const games = appids.flatMap((appid) =>
            MEDIA[appid] ? [MEDIA[appid]] : appid < 100 ? [media(appid, `Paid ${appid}`, false)] : [],
          );
          return { games, failed: false };
        },
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
    lookups = 0;
    store = "up";
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

  it("refuses a crew of a name the player has with 409 name-taken, saying which, and founds once per key", async () => {
    const first = await call("POST", "/api/crews", ALEX, { name: "Freitagsrunde", key: "k-1" });
    assert.equal(first.status, 201);
    const again = await call("POST", "/api/crews", ALEX, { name: "Freitagsrunde", key: "k-1" });
    assert.equal(again.status, 201);
    assert.equal(again.body.crew.id, first.body.crew.id, "the same founding sent again is the crew it made");

    const clash = await call("POST", "/api/crews", ALEX, { name: "freitagsrunde", key: "k-2" });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.code, "name-taken");
    assert.deepEqual(clash.body.crew, {
      id: first.body.crew.id,
      name: "Alex",
      crewName: "Freitagsrunde",
      own: true,
    });
    for (const key of [7, "", "has space", "x".repeat(65)])
      assert.equal((await call("POST", "/api/crews", ALEX, { key })).status, 400);

    const other = await call("POST", "/api/crews", ALEX, { name: "Couch Koop" });
    const renamed = await call("POST", `/api/crews/${other.body.crew.id}/name`, ALEX, {
      name: "FREITAGSRUNDE",
    });
    assert.equal(renamed.status, 409);
    assert.equal(renamed.body.code, "name-taken");
    assert.equal(renamed.body.crew.id, first.body.crew.id);
    assert.equal((await call("GET", "/api/crews", ALEX)).body.crews.length, 2);
  });

  it("refuses to found or join past MAX_CREWS crews with 409", async () => {
    const { body } = await call("POST", "/api/crews", JO, {});
    for (let i = 0; i < MAX_CREWS; i++)
      assert.equal((await call("POST", "/api/crews", ALEX, { name: `Crew ${i}` })).status, 201);
    const founding = await call("POST", "/api/crews", ALEX, { name: "One more" });
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

  it("sets and moves the crew's Zockrunde as its admin, asks everyone again, and takes each answer", async () => {
    const crew = await joinByLink();
    const at = now + 3 * 24 * 3600 * 1000;
    assert.equal((await call("POST", `/api/crews/${crew.id}/session`, HOST, { at })).status, 403);
    assert.equal((await call("POST", `/api/crews/${crew.id}/session`, STRANGER, { at })).status, 404);
    for (const bad of [undefined, "friday", now - 2 * 3600 * 1000, now + 91 * 24 * 3600 * 1000, at + 0.5])
      assert.equal((await call("POST", `/api/crews/${crew.id}/session`, ALEX, { at: bad })).status, 400);
    const early = await call("POST", `/api/crews/${crew.id}/rsvp`, HOST, { rsvp: "yes" });
    assert.equal(early.status, 409);
    assert.equal(early.body.code, "no-session");
    const unshared = await call("POST", `/api/crews/${crew.id}/shared`, HOST);
    assert.equal(unshared.status, 409, "an invite with no date to answer does not count as sent");
    assert.equal(unshared.body.code, "no-session");

    const set = await call("POST", `/api/crews/${crew.id}/session`, ALEX, { at });
    assert.equal(set.status, 200);
    assert.deepEqual(set.body.crew.session, { at, yes: 1, no: 0 }, "the admin who sets it is in");
    assert.equal(set.body.crew.shared, false);
    assert.equal((await call("POST", `/api/crews/${crew.id}/rsvp`, HOST, { rsvp: "maybe" })).status, 400);
    const answered = await call("POST", `/api/crews/${crew.id}/rsvp`, HOST, { rsvp: "no" });
    assert.deepEqual(answered.body.crew.session, { at, yes: 1, no: 1 });
    assert.deepEqual(
      answered.body.crew.members.map((m: { name: string; rsvp: string | null }) => [m.name, m.rsvp]),
      [
        ["Alex", "yes"],
        ["Sam", "no"],
      ],
    );
    const shared = await call("POST", `/api/crews/${crew.id}/shared`, HOST);
    assert.equal(shared.body.crew.shared, true);
    assert.equal((await call("POST", `/api/crews/${crew.id}/shared`, STRANGER)).status, 404);
    // Whoever opens the link sees the date and who is in.
    assert.deepEqual((await call("GET", `/api/invites/${crew.token}`)).body.crew.session, {
      at,
      yes: 1,
      no: 1,
    });

    // Moved, everyone is asked again and the invite is to go out again with the new date.
    const moved = await call("POST", `/api/crews/${crew.id}/session`, ALEX, { at: at + 3600 * 1000 });
    assert.deepEqual(moved.body.crew.session, { at: at + 3600 * 1000, yes: 1, no: 0 });
    assert.equal(moved.body.crew.shared, false);
    assert.deepEqual(
      moved.body.crew.members.map((m: { rsvp: string | null }) => m.rsvp),
      ["yes", null],
    );
  });

  it("stops showing and answering a Zockrunde once it is over, 6 hours after it starts", async () => {
    const crew = await joinByLink();
    const at = now + 3600 * 1000;
    await call("POST", `/api/crews/${crew.id}/session`, ALEX, { at });
    now = at + SESSION_OVER_MS - 1;
    assert.deepEqual((await call("GET", `/api/invites/${crew.token}`)).body.crew.session, {
      at,
      yes: 1,
      no: 0,
    });
    assert.equal((await call("POST", `/api/crews/${crew.id}/rsvp`, HOST, { rsvp: "yes" })).status, 200);

    now += 1;
    assert.equal((await call("GET", `/api/invites/${crew.token}`)).body.crew.session, null);
    const late = await call("POST", `/api/crews/${crew.id}/rsvp`, HOST, { rsvp: "no" });
    assert.equal(late.status, 409);
    assert.equal(late.body.code, "no-session");
    // The crew itself still knows its last one, so its page can ask for the next.
    assert.deepEqual((await call("GET", `/api/crews/${crew.id}`, HOST)).body.crew.session, {
      at,
      yes: 2,
      no: 0,
    });
  });

  it("offers the games on the crew's PCs, everyone's apart from some's, and keeps who wants which", async () => {
    const crew = await joinByLink();
    const none = await call("GET", `/api/crews/${crew.id}/games`, ALEX);
    assert.deepEqual(none.body, { games: [], size: 2 }, "no PC, no games");
    assert.equal((await call("GET", `/api/crews/${crew.id}/games`, STRANGER)).status, 404);
    assert.equal((await call("GET", `/api/crews/${crew.id}/games`)).status, 401);

    assert.equal((await offerPc("pc-1", { games: [730, 570, 550, 620, 440, 999] })).status, 200);
    assert.equal((await call("POST", `/api/crews/${crew.id}/pc`, HOST, { pc: "yes" })).status, 200);
    const read = await call("GET", `/api/crews/${crew.id}/games`, ALEX);
    type Game = {
      id: number;
      name: string;
      everyone: boolean;
      owners: number;
      wants: string[];
      mine: boolean;
    };
    const shown = (games: Game[]) => games.map((g) => [g.name, g.everyone, g.owners, g.wants.length, g.mine]);
    // Free, or in both libraries: everyone; Portal 2 only Sam has; Team Fortress 2
    // here nobody owns and is not free, and 999 is not a game: neither is offered.
    assert.deepEqual(shown(read.body.games), [
      ["Left 4 Dead 2", true, 2, 0, false],
      ["Counter-Strike 2", true, 2, 0, false],
      ["Portal 2", false, 1, 0, false],
      ["Dota 2", true, 0, 0, false],
    ]);
    assert.equal(read.body.games[0].image, "https://cdn.example/550.jpg");

    const marked = await call("POST", `/api/crews/${crew.id}/games`, ALEX, { appid: 620, want: true });
    assert.equal(marked.status, 200);
    assert.deepEqual(marked.body.games[0].name, "Portal 2", "the most wanted first");
    assert.equal(marked.body.games[0].mine, true);
    await call("POST", `/api/crews/${crew.id}/games`, HOST, { appid: 620, want: true });
    await call("POST", `/api/crews/${crew.id}/games`, HOST, { appid: 730, want: true });
    const both = await call("GET", `/api/crews/${crew.id}/games`, HOST);
    assert.deepEqual(shown(both.body.games).slice(0, 2), [
      ["Portal 2", false, 1, 2, true],
      ["Counter-Strike 2", true, 2, 1, true],
    ]);
    const members = (await call("GET", `/api/crews/${crew.id}`, HOST)).body.crew;
    assert.deepEqual(
      both.body.games[0].wants,
      members.members.map((m: { id: string }) => m.id),
    );
    assert.equal(members.picks, 2);
    assert.doesNotMatch(JSON.stringify(both.body), new RegExp(`${ALEX}|${HOST}`));

    const missing = await call("POST", `/api/crews/${crew.id}/games`, ALEX, { appid: 12345, want: true });
    assert.equal(missing.status, 409);
    assert.equal(missing.body.code, "not-installed");
    assert.equal(
      (await call("POST", `/api/crews/${crew.id}/games`, ALEX, { appid: "620", want: true })).status,
      400,
    );
    assert.equal((await call("POST", `/api/crews/${crew.id}/games`, ALEX, { appid: 620 })).status, 400);
    assert.equal(
      (await call("POST", `/api/crews/${crew.id}/games`, STRANGER, { appid: 620, want: true })).status,
      404,
    );

    const unmarked = await call("POST", `/api/crews/${crew.id}/games`, ALEX, { appid: 620, want: false });
    assert.equal(unmarked.body.games.find((g: Game) => g.id === 620).wants.length, 1);
    assert.equal((await call("GET", `/api/crews/${crew.id}`, ALEX)).body.crew.picks, 0);

    // Whoever leaves takes their wishes with them.
    const sam = members.members.find((m: { you: boolean }) => m.you).id;
    assert.equal((await call("POST", `/api/crew-members/${sam}/remove`, HOST)).status, 200);
    const left = await call("GET", `/api/crews/${crew.id}/games`, ALEX);
    assert.deepEqual(left.body, { games: [], size: 1 }, "Sam's PC left with Sam");
    assert.equal(
      (await platform.crewGames(crew.id, ALEX))!.wants.length,
      0,
      "Sam's wishes are gone with Sam",
    );
  });

  it("keeps games nobody in the crew may start from taking the places of those on offer", async () => {
    const crew = await joinByLink();
    // More than one store lookup's worth, all ranked ahead of the free one.
    const unowned = Array.from({ length: 250 }, (_, i) => i + 1);
    assert.equal((await offerPc("pc-1", { games: [...unowned, 570] })).status, 200);
    assert.equal((await call("POST", `/api/crews/${crew.id}/pc`, HOST, { pc: "yes" })).status, 200);
    const read = await call("GET", `/api/crews/${crew.id}/games`, ALEX);
    assert.deepEqual(
      read.body.games.map((g: { name: string }) => g.name),
      ["Dota 2"],
      "250 games nobody may start, ranked ahead, still leave the free one on offer",
    );
  });

  it("looks past a whole batch the store knows no games in", async () => {
    const crew = await joinByLink();
    // A store lookup's worth of installs that are not games, ranked ahead of the free one.
    const unknown = Array.from({ length: 200 }, (_, i) => i + 101);
    assert.equal((await offerPc("pc-1", { games: [...unknown, 570] })).status, 200);
    assert.equal((await call("POST", `/api/crews/${crew.id}/pc`, HOST, { pc: "yes" })).status, 200);
    lookups = 0;
    const read = await call("GET", `/api/crews/${crew.id}/games`, ALEX);
    assert.deepEqual(
      read.body.games.map((g: { name: string }) => g.name),
      ["Dota 2"],
    );
    assert.equal(lookups, 2);
  });

  it("asks the store once, not once per batch, while it is down", async () => {
    const crew = await joinByLink();
    const many = Array.from({ length: 450 }, (_, i) => i + 1);
    assert.equal((await offerPc("pc-1", { games: [...many, 570] })).status, 200);
    assert.equal((await call("POST", `/api/crews/${crew.id}/pc`, HOST, { pc: "yes" })).status, 200);
    store = "down";
    lookups = 0;
    const read = await call("GET", `/api/crews/${crew.id}/games`, ALEX);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.games, []);
    assert.equal(lookups, 1);
  });

  it("answers with the games gathered so far when a lookup throws, then stops", async () => {
    const crew = await joinByLink();
    const unknown = Array.from({ length: 200 }, (_, i) => i + 101);
    assert.equal((await offerPc("pc-1", { games: [730, ...unknown, 570] })).status, 200);
    assert.equal((await call("POST", `/api/crews/${crew.id}/pc`, HOST, { pc: "yes" })).status, 200);
    store = "throws";
    lookups = 0;
    const read = await call("GET", `/api/crews/${crew.id}/games`, ALEX);
    assert.equal(read.status, 200);
    assert.deepEqual(
      read.body.games.map((g: { name: string }) => g.name),
      ["Counter-Strike 2"],
    );
    assert.equal(lookups, 2);
  });

  it("keeps the games the store did answer for when it fails for some, then stops", async () => {
    const crew = await joinByLink();
    const many = Array.from({ length: 450 }, (_, i) => i + 1001);
    assert.equal((await offerPc("pc-1", { games: [730, 570, ...many] })).status, 200);
    assert.equal((await call("POST", `/api/crews/${crew.id}/pc`, HOST, { pc: "yes" })).status, 200);
    store = "partly";
    lookups = 0;
    const read = await call("GET", `/api/crews/${crew.id}/games`, ALEX);
    assert.deepEqual(
      read.body.games.map((g: { name: string }) => g.name),
      ["Counter-Strike 2", "Dota 2"],
    );
    assert.equal(lookups, 1);
  });

  it("counts only the picks on games a PC of the crew still has", async () => {
    const crew = await joinByLink();
    assert.equal((await offerPc("pc-1", { games: [730, 570] })).status, 200);
    assert.equal((await call("POST", `/api/crews/${crew.id}/pc`, HOST, { pc: "yes" })).status, 200);
    await call("POST", `/api/crews/${crew.id}/games`, ALEX, { appid: 730, want: true });
    await call("POST", `/api/crews/${crew.id}/games`, ALEX, { appid: 570, want: true });
    assert.equal((await call("GET", `/api/crews/${crew.id}`, ALEX)).body.crew.picks, 2);
    assert.equal((await call("GET", `/api/crews/${crew.id}`, ALEX)).body.crew.offered, 2);

    const sam = (await call("GET", `/api/crews/${crew.id}`, HOST)).body.crew.members.find(
      (m: { you: boolean }) => m.you,
    ).id;
    assert.equal((await call("POST", `/api/crew-members/${sam}/remove`, HOST)).status, 200);
    assert.deepEqual((await call("GET", `/api/crews/${crew.id}/games`, ALEX)).body.games, []);
    assert.equal(
      (await call("GET", `/api/crews/${crew.id}`, ALEX)).body.crew.picks,
      0,
      "Sam's PC left with Sam",
    );
    assert.equal(
      (await call("GET", `/api/crews/${crew.id}`, ALEX)).body.crew.offered,
      0,
      "nothing left to pick",
    );
  });

  it("marks the days another crew's Zockrunde already has one of the crew's PCs", async () => {
    const crew = await joinByLink();
    assert.equal((await offerPc("pc-1")).status, 200);
    assert.equal((await call("POST", `/api/crews/${crew.id}/pc`, HOST, { pc: "yes" })).status, 200);
    const other = (await call("POST", "/api/crews", JO, { name: "Couch-Koop" })).body.crew;
    assert.equal((await call("POST", `/api/invites/${other.token}/join`, HOST)).status, 200);
    assert.equal((await call("POST", `/api/crews/${other.id}/pc`, HOST, { pc: "yes" })).status, 200);
    assert.deepEqual((await call("GET", `/api/crews/${crew.id}`, ALEX)).body.crew.busy, []);

    const at = now + 24 * 3600 * 1000;
    assert.equal((await call("POST", `/api/crews/${other.id}/session`, JO, { at })).status, 200);
    const busy = (await call("GET", `/api/crews/${crew.id}`, ALEX)).body.crew.busy;
    assert.deepEqual(busy, [{ at, owner: "Sam", mine: false }], "whose PC, never which crew");
    assert.deepEqual(
      (await call("GET", `/api/crews/${crew.id}`, HOST)).body.crew.busy,
      [{ at, owner: "Sam", mine: true }],
      "Sam's own PC is his",
    );
    assert.doesNotMatch(JSON.stringify(busy), /Couch-Koop|Jo/);
    assert.deepEqual(
      (await call("GET", `/api/crews/${other.id}`, JO)).body.crew.busy,
      [],
      "a crew's own Zockrunde never marks its own days",
    );

    // An archived crew keeps no hold on the PC, even where its PC row was left behind.
    await database.query("UPDATE crews SET archived_at = $1 WHERE id = $2", [now, other.id]);
    assert.deepEqual(
      (await call("GET", `/api/crews/${crew.id}`, ALEX)).body.crew.busy,
      [],
      "archived: free again",
    );
    await database.query("UPDATE crews SET archived_at = NULL WHERE id = $1", [other.id]);

    now = at + SESSION_OVER_MS;
    assert.deepEqual(
      (await call("GET", `/api/crews/${crew.id}`, ALEX)).body.crew.busy,
      [],
      "over: free again",
    );
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
        session: null,
        member: false,
        removed: false,
        guests: [{ name: "Alex", admin: true, rsvp: null }],
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
      crew: { name: "Alex", crewName: null, own: false, size: 2, state: "no-pc", pcs: 0, session: null },
      joined: true,
    });
    const own = await call("POST", `/api/invites/${body.crew.token}/join`, ALEX);
    assert.equal(own.status, 200);
    assert.equal(own.body.joined, false);
  });

  it("shows who is coming on the invite, and joins with the friend's answer to the Zockrunde", async () => {
    const { body } = await call("POST", "/api/crews", ALEX, {});
    const crew = body.crew as { id: string; token: string };
    // With no Zockrunde set, an answer given on joining is left out: there is nothing to answer.
    const early = await call("POST", `/api/invites/${crew.token}/join`, JO, { rsvp: "yes" });
    assert.equal(early.status, 200);
    assert.deepEqual((await call("GET", `/api/invites/${crew.token}`)).body.crew.guests, [
      { name: "Alex", admin: true, rsvp: null },
      { name: "Jo", admin: false, rsvp: null },
    ]);

    const at = now + 24 * 3600 * 1000;
    await call("POST", `/api/crews/${crew.id}/session`, ALEX, { at });
    now += 1000;
    const joined = await call("POST", `/api/invites/${crew.token}/join`, HOST, { rsvp: "yes" });
    assert.equal(joined.status, 200);
    assert.deepEqual(joined.body.crew.session, { at, yes: 2, no: 0 });
    // "Can't make it, but join anyway" from a friend already in changes only the answer.
    const cant = await call("POST", `/api/invites/${crew.token}/join`, JO, { rsvp: "no" });
    assert.equal(cant.body.joined, false);
    assert.deepEqual((await call("GET", `/api/invites/${crew.token}`)).body.crew.guests, [
      { name: "Alex", admin: true, rsvp: "yes" },
      { name: "Jo", admin: false, rsvp: "no" },
      { name: "Sam", admin: false, rsvp: "yes" },
    ]);
    // Anything but yes or no joins without an answer.
    await call("POST", `/api/crews/${crew.id}/session`, ALEX, { at: at + 3600 * 1000 });
    await call("POST", `/api/invites/${crew.token}/join`, HOST, { rsvp: "maybe" });
    const members = (await call("GET", `/api/crews/${crew.id}`, HOST)).body.crew.members;
    assert.deepEqual(
      members.map((m: { name: string; rsvp: string | null }) => [m.name, m.rsvp]),
      [
        ["Alex", "yes"],
        ["Jo", null],
        ["Sam", null],
      ],
    );
  });

  it("lines up who plays next on the crew's PC, and takes them out of line once they start", async () => {
    const crew = await joinByLink();
    await call("POST", `/api/crews/${crew.id}/pc`, HOST, { pc: "yes" });
    await offerPc("pc-1");
    const read = await call("GET", `/api/crews/${crew.id}`, ALEX);
    assert.deepEqual(
      read.body.crew.machines.map((m: { id: string; playing: unknown }) => [m.id, m.playing]),
      [["pc-1", null]],
    );
    assert.equal((await call("POST", `/api/crews/${crew.id}/next`, STRANGER, { gameId: 730 })).status, 404);
    for (const bad of ["730", -1, 1.5, true, 3_000_000_000])
      assert.equal((await call("POST", `/api/crews/${crew.id}/next`, ALEX, { gameId: bad })).status, 400);

    const host = await call("POST", `/api/crews/${crew.id}/next`, HOST, { gameId: 730 });
    assert.equal(host.status, 200);
    now += 1000;
    await call("POST", `/api/crews/${crew.id}/next`, ALEX, { gameId: 570 });
    now += 1000;
    // Changing the game keeps the place in line.
    const changed = await call("POST", `/api/crews/${crew.id}/next`, HOST, { gameId: 440 });
    assert.deepEqual(
      changed.body.crew.members.map((m: { name: string; next: unknown }) => [m.name, m.next]),
      [
        ["Alex", { gameId: 570, at: now - 1000 }],
        ["Sam", { gameId: 440, at: now - 2000 }],
      ],
    );

    // Alex starts first: he is out of line, and plays on the crew's PC for everyone to see.
    const booked = await call("POST", "/api/bookings", ALEX, { gameId: 730, minutes: 30, machineId: "pc-1" });
    assert.equal(booked.status, 202);
    const claimed = await platform.claim(booked.body.bookingId, ALEX);
    assert.ok(claimed.ok);
    const seen = (await call("GET", `/api/crews/${crew.id}`, HOST)).body.crew;
    assert.deepEqual(
      seen.members.map((m: { name: string; next: unknown }) => [m.name, m.next]),
      [
        ["Alex", null],
        ["Sam", { gameId: 440, at: now - 2000 }],
      ],
    );
    const playing = seen.machines[0].playing;
    assert.equal(playing.player, "Alex");
    assert.equal(playing.you, false);
    assert.equal(playing.gameId, 730);
    assert.equal(playing.starting, true);
    assert.equal(typeof playing.sessionId, "string");
    assert.equal((await call("GET", `/api/crews/${crew.id}`, ALEX)).body.crew.machines[0].playing.you, true);

    // Leaving the line.
    const left = await call("POST", `/api/crews/${crew.id}/next`, HOST, { gameId: null });
    assert.equal(left.body.crew.members[1].next, null);
  });

  it("brings a member's PC to the crew, or takes it out; there is no putting it off", async () => {
    const crew = await joinByLink();
    await offerPc("pc-1");
    assert.equal((await call("POST", `/api/crews/${crew.id}/pc`, HOST, { pc: "maybe" })).status, 400);
    assert.equal((await call("POST", `/api/crews/${crew.id}/pc`, STRANGER, { pc: "yes" })).status, 404);
    assert.equal((await call("POST", `/api/crews/${crew.id}/pc`, HOST, { pc: "later" })).status, 400);
    const yes = await call("POST", `/api/crews/${crew.id}/pc`, HOST, { pc: "yes" });
    assert.equal(yes.body.crew.state, "ready");
    assert.deepEqual(yes.body.crew.machines, [
      {
        id: "pc-1",
        name: "Nova-01",
        owner: "Sam",
        mine: true,
        crewOnly: true,
        crews: 1,
        state: "ready",
        games: [570, 730],
        playing: null,
      },
    ]);
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
          session: null,
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

    // The link they had no longer lets them in; the admin's new one does, and the host leaves on their own.
    assert.equal((await call("POST", `/api/invites/${crew.token}/join`, HOST)).status, 404);
    const renewed = await call("POST", `/api/crews/${crew.id}/link`, ALEX);
    assert.equal((await call("POST", `/api/invites/${renewed.body.crew.token}/join`, HOST)).status, 200);
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
