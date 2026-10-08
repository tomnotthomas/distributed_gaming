// Watching a crewmate play: only a crewmate may ask or watch, only the player's
// yes lets them watch, the player stops anyone at any time, leaving the crew or
// the session ending stops it, and watching costs the player nothing. The
// watch state (watch.ts), the platform's crew checks, the API that hands out
// watch tickets, and the signaling server that seats viewers and carries their
// frames to the player and nowhere else.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  mintRenterSession,
  mintWatchTicket,
  parseMachineKeys,
  parseMachineOwners,
  verifyWatchTicket,
  type Access,
} from "../access.js";
import { createApi } from "../api.js";
import { RequestBudget } from "../budget.js";
import { Platform } from "../platform.js";
import { MAX_WATCHERS, type SignalMessage } from "../protocol.js";
import { SESSION_COOKIE } from "../signin.js";
import { emptyProfile } from "../steam.js";
import { ASK_MS, AWAY_MS, COOLDOWN_MS, Watches } from "../watch.js";
import { serverDatabase, testDatabase, type ServerDatabase } from "./db.js";
import { REPORT } from "./report.js";

const SECRET = "test-room-secret-that-is-long-enough-to-pass";
const SESSION = "test-session-secret-that-is-long-enough-too";
const MACHINE_KEY = "test-machine-key";
const HASH = createHash("sha256").update(MACHINE_KEY).digest("hex");
/** The player, who plays and whose crew it is. */
const MARA = "76561198000000021";
/** Mara's friend, in her crew, who would like to watch. */
const LEA = "76561198000000022";
/** Another friend of Mara's. */
const JON = "76561198000000023";
/** Someone in no crew of theirs. */
const STRANGER = "76561198000000024";
/** Who owns the PCs, in Mara's crew so that they play for it: watching is the crew of the PC being played's. */
const OWNER = "76561198000000099";
const PERSONA: Record<string, string> = { [MARA]: "Mara", [LEA]: "Lea", [JON]: "Jon" };
const MACHINE_KEYS = ["pc-1", "pc-2"].map((id) => `${id}:${HASH}:${OWNER}`).join(",");

describe("watch state", () => {
  let now: number;
  let watches: Watches;
  const live = { sessionId: "s1", room: "pc-1", playerName: "Mara", exp: 4_000_000_000 };
  const viewer = (id: string) => ({ id, name: PERSONA[id] ?? null });
  const asked = (id: string, on = live) => {
    const result = watches.ask(on, viewer(id));
    assert.ok(result.ok);
    return result.watch;
  };

  beforeEach(() => {
    now = 1_000_000;
    watches = new Watches({ now: () => now });
  });

  it("asks the player first, and a yes lets the viewer watch", () => {
    const watch = asked(LEA);
    assert.equal(watch.state, "asking");
    assert.equal(watch.playerName, "Mara");
    assert.equal(watches.answer("s1", watch.id, true)?.state, "watching");
    assert.deepEqual(
      watches.list("s1").map((w) => [w.name, w.state]),
      [["Lea", "watching"]],
    );
  });

  it("is the same watch when the same viewer asks again", () => {
    const first = asked(LEA);
    assert.equal(asked(LEA).id, first.id);
    assert.equal(watches.list("s1").length, 1);
  });

  it("ends a watch the player turns down, and the viewer waits before asking again", () => {
    const watch = asked(LEA);
    assert.equal(watches.answer("s1", watch.id, false), watch);
    assert.equal(watches.get(watch.id), null);
    assert.equal(watches.over(watch.id), "watch-declined");
    const again = watches.ask(live, viewer(LEA));
    assert.deepEqual(again, { ok: false, reason: "cooldown", retryAfterMs: COOLDOWN_MS });
    now += COOLDOWN_MS;
    assert.equal(asked(LEA).state, "asking");
  });

  it("lets a viewer the player turned down watch at once when the player then shares", () => {
    const watch = asked(LEA);
    watches.answer("s1", watch.id, false);
    now += 1_000;
    watches.share("s1", true);
    assert.equal(asked(LEA).state, "watching");
  });

  it("takes an answer only for a viewer asking on the player's own session", () => {
    const watch = asked(LEA);
    assert.equal(watches.answer("s2", watch.id, true), null);
    assert.equal(watches.get(watch.id)?.state, "asking");
    watches.answer("s1", watch.id, true);
    // A yes is not taken back by a no after it: stopping is how.
    assert.equal(watches.answer("s1", watch.id, false), null);
    assert.equal(watches.get(watch.id)?.state, "watching");
  });

  it("lets everyone in at once while the player shares with their crew, and closing stops nobody", () => {
    const lea = asked(LEA);
    assert.deepEqual(
      watches.share("s1", true).map((w) => w.id),
      [lea.id],
    );
    assert.equal(asked(JON).state, "watching");
    watches.share("s1", false);
    assert.deepEqual(
      watches.list("s1").map((w) => w.state),
      ["watching", "watching"],
    );
    assert.equal(asked(STRANGER).state, "asking");
  });

  it(`takes at most ${MAX_WATCHERS} viewers on a session, asking or watching`, () => {
    for (let i = 0; i < MAX_WATCHERS; i++) asked(`7656119800000010${i}`);
    assert.deepEqual(watches.ask(live, viewer(LEA)), { ok: false, reason: "full" });
    // Another session is another count.
    assert.ok(watches.ask({ ...live, sessionId: "s2" }, viewer(LEA)).ok);
  });

  it("ends a request the player leaves unanswered, and a viewer who stays away, who may ask again at once", () => {
    const lea = asked(LEA);
    const jon = asked(JON);
    watches.back(lea.id);
    watches.back(jon.id);
    watches.answer("s1", jon.id, true);
    watches.away(jon.id);
    now += AWAY_MS;
    assert.deepEqual(
      watches.expire().map(({ watch, reason }) => [watch.name, reason]),
      [["Jon", "watch-left"]],
    );
    now += ASK_MS - AWAY_MS;
    assert.deepEqual(
      watches.expire().map(({ watch, reason }) => [watch.name, reason]),
      [["Lea", "watch-unanswered"]],
    );
  });

  it("keeps a viewer who comes back in time", () => {
    const watch = asked(LEA);
    watches.answer("s1", watch.id, true);
    watches.back(watch.id);
    watches.away(watch.id);
    now += AWAY_MS - 1;
    watches.back(watch.id);
    now += AWAY_MS;
    assert.deepEqual(watches.expire(), []);
  });

  it("counts a viewer whose page never came as away", () => {
    const watch = asked(LEA);
    watches.answer("s1", watch.id, true);
    now += AWAY_MS;
    assert.deepEqual(
      watches.expire().map(({ reason }) => reason),
      ["watch-left"],
    );
  });

  it("ends every watch when the session ends", () => {
    asked(LEA);
    asked(JON);
    const ended = watches.endSession("s1");
    assert.equal(ended.length, 2);
    assert.deepEqual(watches.list("s1"), []);
    assert.equal(watches.over(ended[0]!.id), "watch-ended");
    assert.equal(watches.sharing("s1"), false);
  });
});

describe("watch tickets", () => {
  const ticket = { room: "pc-1", session: "s1", watch: "w1", viewer: LEA, exp: 2_000_000_000 };

  it("opens only as signed, before its expiry, and never as another kind of token", () => {
    const token = mintWatchTicket(SECRET, ticket);
    assert.deepEqual(verifyWatchTicket(SECRET, token, 1_000), ticket);
    assert.equal(verifyWatchTicket(SECRET, token, ticket.exp * 1000), null);
    assert.equal(verifyWatchTicket("another-secret-that-is-long-enough-to-pass", token, 1_000), null);
    const [payload] = token.split(".");
    assert.equal(verifyWatchTicket(SECRET, `${payload}.AAAA`, 1_000), null);
  });
});

describe("crew live sessions", () => {
  let now: number;
  let platform: Platform;
  let server: Server;
  let origin: string;
  let watches: Watches;
  let crewLeft = 0;
  /** Whether a TURN relay is configured: watching is relay-only. */
  let relay = true;
  /** How many watches were on while each viewer credential was minted, and for which seat. */
  let mints: { seat: string; watches: number }[] = [];
  let availabilityChanged = 0;
  const owners = parseMachineOwners(MACHINE_KEYS);
  const access: Access = {
    secret: SECRET,
    machines: parseMachineKeys(MACHINE_KEYS),
    owners,
  } as Access;

  before(async () => {
    server = createServer(async (req, res) => {
      const api = createApi({
        platform,
        access,
        sessionSecret: SESSION,
        publicOrigin: "http://localhost",
        fallbackOrigin: "http://localhost",
        games: async () => [{ id: 730, name: "Counter-Strike 2", image: null }],
        profile: async (steamId) => ({ ...emptyProfile(steamId), persona: PERSONA[steamId] ?? "" }),
        discovery: new RequestBudget({ now: () => now }),
        isFree: async () => true,
        watches,
        watchRelay: async (seat) => {
          mints.push({ seat: seat.id, watches: watches.all().length });
          return relay
            ? [{ urls: "turn:turn.test:3478", username: `${seat.id}-${seat.side}`, credential: "c" }]
            : [];
        },
        onCrewLeft: () => crewLeft++,
      });
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (!(await api(req, res, path))) res.writeHead(418).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(() => server.close());

  beforeEach(async () => {
    now = Date.now();
    crewLeft = 0;
    relay = true;
    mints = [];
    watches = new Watches({ now: () => now });
    availabilityChanged = 0;
    platform = await Platform.open({
      database: await testDatabase(),
      now: () => now,
      owners,
      onAvailabilityChanged: () => availabilityChanged++,
    });
  });

  afterEach(() => platform.close());

  async function call(method: string, path: string, steamId?: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (steamId) headers.cookie = `${SESSION_COOKIE}=${mintRenterSession(SESSION, steamId, 3600)}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${origin}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }

  /** A crew `founder` founds, named `name`, that `members` join by its link and whose PCs the owner brings. */
  async function crewOf(founder: string, name: string | null, members: [string, string][]) {
    const crew = await platform.createCrew(founder, PERSONA[founder] ?? null, name);
    assert.ok(crew !== "too-many" && !("taken" in crew) && crew.inviteId);
    for (const [id, persona] of [...members, [OWNER, "Owner"] as [string, string]]) {
      assert.ok((await platform.joinCrew(crew.inviteId, id, persona)).ok);
    }
    assert.ok(await platform.bringPc(crew.id, OWNER, "yes"));
    return crew.id;
  }

  /** Mara's crew, which the PCs play for: Lea and Jon joined by her link. Returns Lea's membership. */
  async function maraCrew() {
    const id = await crewOf(MARA, null, [
      [LEA, "Lea"],
      [JON, "Jon"],
    ]);
    return (await platform.crew(id, MARA))!.members.find((m) => m.name === "Lea")!;
  }

  /**
   * `renter` books and claims pc-1, and (unless still `starting`, behind
   * Ignition) plays on it with the game on screen: the PC's game-started, which
   * the signaling server records as it relays it.
   */
  async function plays(renter: string, { starting = false } = {}) {
    await platform.setAvailability("pc-1", true, REPORT);
    const booking = await platform.book(730, 60, renter);
    const claim = await platform.claim(booking.bookingId, renter);
    assert.ok(claim.ok);
    if (!starting) {
      assert.equal(await platform.startSession("pc-1", claim.sessionId), true);
      watches.gameOnScreen(claim.sessionId);
    }
    return { bookingId: booking.bookingId, sessionId: claim.sessionId };
  }

  it("lists the sessions a player's crewmates play, never their own or a stranger's", async () => {
    await maraCrew();
    const { sessionId } = await plays(MARA);
    const seen = await platform.crewLive(LEA, () => null);
    assert.deepEqual(
      seen.map((s) => [s.sessionId, s.playerName, s.room, s.gameId]),
      [[sessionId, "Mara", "pc-1", 730]],
    );
    assert.deepEqual(await platform.crewLive(MARA, () => null), []);
    assert.deepEqual(await platform.crewLive(STRANGER, () => null), []);
  });

  it("says why a session may not be watched", async () => {
    const lea = await maraCrew();
    const { sessionId, bookingId } = await plays(MARA);
    assert.equal(typeof (await platform.watchable(sessionId, LEA, null)), "object");
    assert.equal(await platform.watchable(sessionId, STRANGER, null), "not-crew");
    assert.equal(await platform.watchable(sessionId, MARA, null), "not-crew");
    assert.equal(await platform.watchable("nope", LEA, null), "ended");
    assert.deepEqual(await platform.watchesStopped([{ sessionId, viewerId: LEA, picked: null }]), new Map());

    // Lea leaves Mara's crew: she may watch no more.
    assert.ok(await platform.leaveCrew(lea.id, LEA));
    assert.deepEqual(
      await platform.watchesStopped([
        { sessionId, viewerId: LEA, picked: null },
        { sessionId, viewerId: JON, picked: null },
      ]),
      new Map([[`${sessionId}:${LEA}`, "not-crew"]]),
    );

    await platform.endBooking(bookingId, MARA);
    assert.equal(await platform.watchable(sessionId, JON, null), "ended");
    assert.deepEqual(
      await platform.watchesStopped([{ sessionId, viewerId: JON, picked: null }]),
      new Map([[`${sessionId}:${JON}`, "ended"]]),
    );
  });

  it("keeps watching to the crew of the PC being played: another crew of the player's sees nothing", async () => {
    await maraCrew();
    // Mara's other crew, which the PC does not play for: Stranger is in it.
    const night = await platform.createCrew(MARA, "Mara", "Night Owls");
    assert.ok(night !== "too-many" && !("taken" in night) && night.inviteId);
    assert.ok((await platform.joinCrew(night.inviteId, STRANGER, "Stranger")).ok);
    const { sessionId } = await plays(MARA);
    assert.deepEqual((await call("GET", "/api/crew-live", STRANGER)).body.live, []);
    assert.equal((await call("POST", `/api/crew-live/${sessionId}/watch`, STRANGER)).status, 404);
    assert.equal(await platform.watchable(sessionId, STRANGER, null), "not-crew");
    // Picking a crew the PC does not play for opens watching to nobody.
    assert.equal(await platform.watchable(sessionId, STRANGER, night.id), "not-crew");
    assert.equal(await platform.watchable(sessionId, LEA, night.id), "not-crew");
    assert.equal(
      (await platform.watchCrews(sessionId)).some((c) => c.id === night.id),
      false,
    );
    assert.deepEqual(watches.all(), []);
  });

  it("opens watching to the one crew the player picks, of those the PC plays for", async () => {
    await maraCrew();
    now += 1_000;
    const night = await crewOf(MARA, "Night Owls", [[STRANGER, "Stranger"]]);
    const { sessionId } = await plays(MARA);
    const crews = await platform.watchCrews(sessionId);
    // The crew she joined first, unless she picks another.
    assert.deepEqual(
      crews.map((c) => c.name),
      [null, "Night Owls"],
    );
    assert.equal(typeof (await platform.watchable(sessionId, LEA, null)), "object");
    assert.equal(await platform.watchable(sessionId, STRANGER, null), "not-crew");
    assert.deepEqual((await call("GET", "/api/crew-live", STRANGER)).body.live, []);

    const asked = await call("POST", `/api/crew-live/${sessionId}/watch`, LEA);
    assert.equal(asked.status, 200);
    watches.choose(sessionId, night);
    assert.equal(await platform.watchable(sessionId, LEA, night), "not-crew");
    assert.equal(typeof (await platform.watchable(sessionId, STRANGER, night)), "object");
    assert.deepEqual((await call("GET", "/api/crew-live", LEA)).body.live, []);
    assert.equal((await call("GET", "/api/crew-live", STRANGER)).body.live.length, 1);
    // Lea, of the crew before, stops.
    assert.deepEqual(
      await platform.watchesStopped([{ sessionId, viewerId: LEA, picked: night }]),
      new Map([[`${sessionId}:${LEA}`, "not-crew"]]),
    );
  });

  it("stops everyone watching when the player leaves the crew of the PC being played", async () => {
    await maraCrew();
    const { sessionId } = await plays(MARA);
    const [crew] = await platform.watchCrews(sessionId);
    const mara = (await platform.crew(crew!.id, MARA))!.members.find((m) => m.you)!;
    assert.ok(await platform.leaveCrew(mara.id, MARA));
    assert.deepEqual(
      await platform.watchesStopped([{ sessionId, viewerId: LEA, picked: null }]),
      new Map([[`${sessionId}:${LEA}`, "not-crew"]]),
    );
    assert.deepEqual(await platform.watchCrews(sessionId), []);
  });

  it("lists a crewmate's session with whether they share and the viewer's own watch", async () => {
    await maraCrew();
    const { sessionId } = await plays(MARA);
    const listed = await call("GET", "/api/crew-live", LEA);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.live, [
      {
        sessionId,
        starting: false,
        player: "Mara",
        gameId: 730,
        machine: REPORT.name,
        startedAt: now,
        sharing: false,
        watching: 0,
        mine: null,
      },
    ]);
    assert.equal((await call("GET", "/api/crew-live")).status, 401);
    assert.deepEqual((await call("GET", "/api/crew-live", STRANGER)).body.live, []);

    await call("POST", `/api/crew-live/${sessionId}/watch`, LEA);
    assert.deepEqual((await call("GET", "/api/crew-live", LEA)).body.live[0].mine, { state: "asking" });
    assert.equal((await call("GET", "/api/crew-live", JON)).body.live[0].mine, null);
  });

  it("hands a crewmate a watch ticket for the session's room, ending with the session", async () => {
    await maraCrew();
    const { sessionId } = await plays(MARA);
    const asked = await call("POST", `/api/crew-live/${sessionId}/watch`, LEA);
    assert.equal(asked.status, 200);
    assert.equal(asked.body.state, "asking");
    assert.equal(asked.body.player, "Mara");
    assert.match(asked.body.signalingUrl, /^ws:\/\//);
    const ticket = verifyWatchTicket(SECRET, asked.body.ticket);
    assert.ok(ticket);
    assert.deepEqual(
      { ...ticket, exp: undefined },
      { room: "pc-1", session: sessionId, watch: asked.body.watchId, viewer: LEA, exp: undefined },
    );
    const deadline = (await platform.crewLive(LEA, () => null))[0]!.expiresAt;
    assert.equal(ticket.exp, Math.ceil(deadline / 1000));
    // Good to the session's last millisecond, not a moment less.
    assert.ok(verifyWatchTicket(SECRET, asked.body.ticket, deadline - 1));
    assert.equal(watches.get(asked.body.watchId)?.name, "Lea");
  });

  it("refuses anyone outside the crew, the player themselves, and a session not running", async () => {
    await maraCrew();
    const { sessionId } = await plays(MARA);
    assert.equal((await call("POST", `/api/crew-live/${sessionId}/watch`, STRANGER)).status, 404);
    assert.equal((await call("POST", `/api/crew-live/${sessionId}/watch`, MARA)).status, 404);
    assert.equal((await call("POST", "/api/crew-live/nope/watch", LEA)).status, 404);
    assert.equal((await call("POST", `/api/crew-live/${sessionId}/watch`)).status, 401);
    assert.deepEqual(watches.all(), []);
  });

  it("lists a crewmate still behind Ignition as starting, and takes no ask until they play", async () => {
    await maraCrew();
    const { sessionId } = await plays(MARA, { starting: true });
    assert.equal(await platform.watchable(sessionId, LEA, null), "ended");
    const listed = await call("GET", "/api/crew-live", LEA);
    assert.deepEqual(
      listed.body.live.map((s: { sessionId: string; starting: boolean }) => [s.sessionId, s.starting]),
      [[sessionId, true]],
    );
    assert.equal((await call("POST", `/api/crew-live/${sessionId}/watch`, LEA)).status, 404);
    assert.deepEqual(watches.all(), []);

    availabilityChanged = 0;
    assert.equal(await platform.startSession("pc-1", sessionId), true);
    // The walls hear of the start at once, so the crew band reads again without waiting for a poll.
    assert.equal(availabilityChanged, 1);
    // Playing from the first frame, but the game is still launching behind Ignition: no ask yet.
    assert.equal((await call("GET", "/api/crew-live", LEA)).body.live[0].starting, true);
    assert.equal((await call("POST", `/api/crew-live/${sessionId}/watch`, LEA)).status, 404);
    assert.deepEqual(watches.all(), []);

    watches.gameOnScreen(sessionId);
    assert.equal((await call("GET", "/api/crew-live", LEA)).body.live[0].starting, false);
    assert.equal((await call("POST", `/api/crew-live/${sessionId}/watch`, LEA)).status, 200);
  });

  it("takes no ask, with a plain answer, while no relay is configured: never direct candidates", async () => {
    await maraCrew();
    const { sessionId } = await plays(MARA);
    relay = false;
    const asked = await call("POST", `/api/crew-live/${sessionId}/watch`, LEA);
    assert.equal(asked.status, 503);
    assert.equal(asked.body.code, "no-relay");
    // Minted before any watch was made, so the player never had one to hear of.
    assert.equal(mints.length, 1);
    assert.equal(mints[0]!.watches, 0);
    assert.deepEqual(watches.all(), []);
    assert.deepEqual(watches.list(sessionId), []);

    // With the relay back, the credential is minted for the very watch made after it, once.
    relay = true;
    const again = await call("POST", `/api/crew-live/${sessionId}/watch`, LEA);
    assert.equal(again.status, 200);
    assert.equal(mints[1]!.seat, again.body.watchId);
    assert.equal(watches.get(again.body.watchId)?.relay[0]?.username, `${again.body.watchId}-viewer`);
    assert.equal(
      (await call("POST", `/api/crew-live/${sessionId}/watch`, LEA)).body.watchId,
      again.body.watchId,
    );
    assert.equal(mints.length, 2);
  });

  it("says when the session is full, and when a viewer turned down must wait", async () => {
    await maraCrew();
    const { sessionId } = await plays(MARA);
    const lea = await call("POST", `/api/crew-live/${sessionId}/watch`, LEA);
    watches.answer(sessionId, lea.body.watchId, false);
    const again = await call("POST", `/api/crew-live/${sessionId}/watch`, LEA);
    assert.equal(again.status, 429);
    assert.equal(again.body.code, "cooldown");
    assert.equal(again.headers.get("retry-after"), String(COOLDOWN_MS / 1000));

    const full = new Watches({ maxWatchers: 0 });
    full.gameOnScreen(sessionId);
    watches = full;
    const refused = await call("POST", `/api/crew-live/${sessionId}/watch`, JON);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "full");
  });

  it("costs the player nothing: no booking, no machine and no time is spent on a viewer", async () => {
    await maraCrew();
    const { bookingId, sessionId } = await plays(MARA);
    const before = await platform.booking(bookingId, MARA);
    const deadline = (await platform.crewLive(LEA, () => null))[0]!.expiresAt;
    const asked = await call("POST", `/api/crew-live/${sessionId}/watch`, LEA);
    watches.answer(sessionId, asked.body.watchId, true);
    assert.deepEqual(await platform.booking(bookingId, MARA), before);
    // The session still ends when the player's own time runs out, not a moment later.
    assert.equal((await platform.crewLive(LEA, () => null))[0]!.expiresAt, deadline);
    // Lea booked nothing and holds nothing: her crew-live list is all she has.
    assert.equal((await call("GET", "/api/bookings/none", LEA)).status, 404);
    assert.equal((await platform.crewLive(LEA, () => null)).length, 1);
  });

  it("tells the server when someone leaves a crew, so their watching stops", async () => {
    const lea = await maraCrew();
    assert.equal((await call("POST", `/api/crew-members/${lea.id}/remove`, MARA)).status, 200);
    assert.equal(crewLeft, 1);
  });
});

// --- The signaling server ----------------------------------------------------

const SERVER = fileURLToPath(new URL("../index.js", import.meta.url));
const PORT = 8500 + Math.floor(Math.random() * 400);
/** A relay candidate, its related address already blank: the only kind that passes between player and viewer. */
const RELAY_CANDIDATE = "candidate:1 1 udp 41885439 203.0.113.9 50000 typ relay raddr 0.0.0.0 rport 0";
/** A fake TURN relay the signaling server mints credentials for; nothing here connects to it. */
const TURN = {
  urls: "turn:turn.test:3478?transport=udp",
  secret: "test-turn-secret-that-is-long-enough-to-pass",
};
const WS_ORIGIN = `ws://localhost:${PORT}`;
const HTTP = `http://localhost:${PORT}`;
const ROOMS = Array.from({ length: 30 }, (_, i) => `room-${i}`);
let roomIndex = 0;

type RecordingSocket = WebSocket & { received: SignalMessage[]; barriers: number };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const send = (ws: WebSocket, msg: unknown) => ws.send(JSON.stringify(msg));

async function open(): Promise<RecordingSocket> {
  const ws = new WebSocket(WS_ORIGIN) as RecordingSocket;
  ws.received = [];
  ws.barriers = 0;
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as SignalMessage;
    if (msg.type === "pong" && ws.barriers > 0) ws.barriers -= 1;
    else ws.received.push(msg);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

/** Wait until the server has handled everything `ws` sent, and a moment for what it sent others. */
async function handled(ws: RecordingSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    ws.barriers += 1;
    send(ws, { type: "ping" });
    const end = Date.now() + 10_000;
    while (ws.barriers > 0 && ws.readyState === WebSocket.OPEN && Date.now() < end) await wait(5);
  }
  await wait(50);
}

/** Wait until `ws` has received a message `match` accepts, and return it. */
async function heard<T extends SignalMessage>(
  ws: RecordingSocket,
  match: (m: SignalMessage) => m is T,
  what: string,
): Promise<T> {
  const end = Date.now() + 10_000;
  for (;;) {
    const found = [...ws.received].reverse().find(match);
    if (found) return found;
    if (Date.now() > end) throw new Error(`never heard ${what}: ${JSON.stringify(ws.received)}`);
    await wait(10);
  }
}

const closed = (ws: WebSocket) =>
  new Promise<number>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) resolve(-1);
    ws.once("close", (code) => resolve(code));
  });

const denial = (ws: RecordingSocket) =>
  ws.received.find((m): m is Extract<SignalMessage, { type: "denied" }> => m.type === "denied")?.reason;

describe("watching through the signaling server", () => {
  let server: ChildProcess | undefined;
  let database: ServerDatabase;
  const sockets: WebSocket[] = [];

  before(async () => {
    database = await serverDatabase();
    server = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT: String(PORT),
        ROOM_SECRET: SECRET,
        SESSION_SECRET: SESSION,
        MACHINE_KEYS: ROOMS.map((room) => `${room}:${HASH}:${OWNER}`).join(","),
        DATABASE_URL: database.url,
        SWIFF_PLAYABILITY: "off",
        SWIFF_TICKET_RECONCILE_MS: "200",
        // A relay to hand out (none is reached here): watching is relay-only.
        TURN_URLS: TURN.urls,
        TURN_SECRET: TURN.secret,
      },
      stdio: "ignore",
    });
    for (let i = 0; i < 150; i++) {
      try {
        (await open()).close();
        return;
      } catch {
        await wait(100);
      }
    }
    throw new Error("signaling server did not start");
  });

  after(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((resolve) => server!.once("exit", resolve));
      server.kill();
      await exited;
    }
    await database.close();
  });

  afterEach(() => {
    for (const ws of sockets.splice(0)) ws.close();
    return database.exec("UPDATE bookings SET status = 'expired' WHERE status = 'queued'");
  });

  async function call(method: string, path: string, steamId?: string, body?: unknown, key?: string) {
    const headers: Record<string, string> = {};
    if (steamId) headers.cookie = `${SESSION_COOKIE}=${mintRenterSession(SESSION, steamId, 3600)}`;
    if (key) headers.authorization = `Bearer ${key}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${HTTP}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  const tracked = async () => {
    const ws = await open();
    sockets.push(ws);
    return ws;
  };

  /** Mara's crew (she founds it), founded once per test run: Lea, Jon and the PCs' owner, who brings them, are in it. */
  let crewMade: { id: string; token: string } | null = null;
  let membersIn = false;
  async function crew() {
    if (!crewMade) {
      const founded = await call("POST", "/api/crews", MARA, {});
      crewMade = { id: founded.body.crew.id, token: founded.body.crew.token };
    }
    if (membersIn) return crewMade.id;
    for (const friend of [LEA, JON, OWNER]) {
      assert.equal((await call("POST", `/api/invites/${crewMade.token}/join`, friend)).status, 200);
    }
    assert.equal((await call("POST", `/api/crews/${crewMade.id}/pc`, OWNER, { pc: "yes" })).status, 200);
    membersIn = true;
    return crewMade.id;
  }

  /**
   * Mara plays in a fresh room: its PC registered, her booking claimed and
   * started, and her page seated with the ticket. Lea asks to watch and her page takes its seat.
   */
  async function scene({ crews, viewerId = LEA }: { crews?: string[]; viewerId?: string } = {}) {
    await crew();
    const room = ROOMS[roomIndex++]!;
    assert.equal(
      (
        await call(
          "PUT",
          `/api/machines/${room}/availability`,
          undefined,
          { available: true, ...REPORT, ...(crews ? { crews } : {}) },
          MACHINE_KEY,
        )
      ).status,
      200,
    );
    const host = await tracked();
    send(host, { type: "register", hostId: room, key: MACHINE_KEY });
    await handled(host);
    // Picked, so it is this room's whatever else is on offer.
    const booking = await call("POST", "/api/bookings", MARA, { gameId: 730, minutes: 30, machineId: room });
    const claim = await call("POST", `/api/bookings/${booking.body.bookingId}/claim`, MARA);
    assert.equal(claim.status, 200);
    const player = await tracked();
    send(player, { type: "join", ticket: claim.body.ticket });
    await handled(player);
    // The player's first frame starts the session, and the PC is told to launch the game.
    assert.equal(
      (await call("POST", `/api/sessions/${claim.body.sessionId}/start`, undefined, {}, claim.body.ticket))
        .status,
      200,
    );
    // The game on screen: the PC says so, through the server, to the player.
    send(host, { type: "game-started", sessionId: claim.body.sessionId });
    await heard(player, (m): m is SignalMessage => m.type === "game-started", "game-started");
    const asked = await call("POST", `/api/crew-live/${claim.body.sessionId}/watch`, viewerId);
    assert.equal(asked.status, 200);
    const viewer = await tracked();
    send(viewer, { type: "watch", ticket: asked.body.ticket });
    await handled(viewer);
    return {
      room,
      host,
      player,
      viewer,
      watchId: asked.body.watchId as string,
      ticket: asked.body.ticket as string,
      bookingId: booking.body.bookingId as string,
      sessionId: claim.body.sessionId as string,
      playerTicket: claim.body.ticket as string,
    };
  }

  const isWatchers = (m: SignalMessage): m is Extract<SignalMessage, { type: "watchers" }> =>
    m.type === "watchers";
  const isWatching = (m: SignalMessage): m is Extract<SignalMessage, { type: "watching" }> =>
    m.type === "watching";

  async function accepted() {
    const s = await scene();
    send(s.player, { type: "watch-answer", watchId: s.watchId, accept: true });
    await handled(s.player);
    return s;
  }

  it("takes no ask while the game launches, and tells the crew's walls once it is on screen", async () => {
    await crew();
    const room = ROOMS[roomIndex++]!;
    const offer = { available: true, ...REPORT };
    assert.equal(
      (await call("PUT", `/api/machines/${room}/availability`, undefined, offer, MACHINE_KEY)).status,
      200,
    );
    const host = await tracked();
    send(host, { type: "register", hostId: room, key: MACHINE_KEY });
    await handled(host);
    const booking = await call("POST", "/api/bookings", MARA, { gameId: 730, minutes: 30, machineId: room });
    const claim = await call("POST", `/api/bookings/${booking.body.bookingId}/claim`, MARA);
    const sessionId = claim.body.sessionId as string;
    const player = await tracked();
    send(player, { type: "join", ticket: claim.body.ticket });
    await handled(player);
    assert.equal(
      (await call("POST", `/api/sessions/${sessionId}/start`, undefined, {}, claim.body.ticket)).status,
      200,
    );

    // Playing since the first frame, but the game is still launching behind Ignition.
    const starting = (await call("GET", "/api/crew-live", LEA)).body.live.find(
      (s: { sessionId: string }) => s.sessionId === sessionId,
    );
    assert.equal(starting.starting, true);
    assert.equal((await call("POST", `/api/crew-live/${sessionId}/watch`, LEA)).status, 404);

    const abort = new AbortController();
    const wall = await fetch(`${HTTP}/api/events`, {
      signal: abort.signal,
      headers: { cookie: `${SESSION_COOKIE}=${mintRenterSession(SESSION, LEA, 3600)}` },
    });
    let text = "";
    const reading = (async () => {
      const decoder = new TextDecoder();
      const reader = wall.body!.getReader();
      try {
        for (let read = await reader.read(); !read.done; read = await reader.read())
          text += decoder.decode(read.value, { stream: true });
      } catch {
        // Aborted at the end of the test.
      }
    })();
    try {
      await wait(100);
      send(host, { type: "game-started", sessionId });
      await heard(player, (m): m is SignalMessage => m.type === "game-started", "game-started");
      await wait(100);
      assert.match(text, /event: crew\n/);
      const live = (await call("GET", "/api/crew-live", LEA)).body.live.find(
        (s: { sessionId: string }) => s.sessionId === sessionId,
      );
      assert.equal(live.starting, false);
      assert.equal((await call("POST", `/api/crew-live/${sessionId}/watch`, LEA)).status, 200);
    } finally {
      abort.abort();
      await reading;
    }
  });

  it("seats a viewer to wait for the player's yes, and tells the player who asks", async () => {
    const { player, viewer, watchId } = await scene();
    const crewId = await crew();
    const watching = await heard(viewer, isWatching, "watching");
    // No Steam here, so nobody has a name; and no relay credential until the player's yes.
    assert.deepEqual(watching, {
      type: "watching",
      watchId,
      state: "asking",
      player: null,
      playerHere: true,
    });
    const watchers = await heard(player, isWatchers, "watchers");
    // The crew that may watch, by its own name or its admin's: no Steam here, so neither.
    const mine = { id: crewId, name: null, admin: null };
    assert.deepEqual(watchers, {
      type: "watchers",
      sharing: false,
      crew: mine,
      crews: [mine],
      watchers: [{ watchId, name: null, state: "asking", here: true }],
    });
  });

  it("carries nothing between the player and a viewer still asking", async () => {
    const { player, viewer, watchId } = await scene();
    send(player, { type: "offer", sdp: { type: "offer", sdp: "v=0 player" }, watchId });
    send(viewer, { type: "ice", candidate: { candidate: RELAY_CANDIDATE } });
    await handled(player);
    await handled(viewer);
    assert.ok(!viewer.received.some((m) => m.type === "offer"));
    assert.ok(!player.received.some((m) => m.type === "ice"));
  });

  it("on the player's yes, carries the player's offer to the viewer and the viewer's answer back, never to the PC", async () => {
    const { host, player, viewer, watchId, sessionId } = await accepted();
    assert.equal((await heard(viewer, isWatching, "watching")).state, "watching");
    const before = host.received.length;

    send(player, { type: "offer", sdp: { type: "offer", sdp: "v=0 player" }, watchId });
    send(player, { type: "crew", watchId, data: { kind: "roster", people: [] } });
    await handled(player);
    assert.deepEqual(
      viewer.received.filter((m) => m.type === "offer" || m.type === "crew"),
      [
        { type: "offer", sdp: { type: "offer", sdp: "v=0 player" }, watchId },
        { type: "crew", watchId, data: { kind: "roster", people: [] } },
      ],
    );

    // A viewer's frames name no one: the server sends them to the player, as from that viewer.
    send(viewer, { type: "answer", sdp: { type: "answer", sdp: "v=0 viewer" }, watchId: "someone-else" });
    send(viewer, { type: "ice", candidate: { candidate: RELAY_CANDIDATE } });
    send(viewer, { type: "crew", data: { kind: "voice", inVoice: true, muted: false } });
    // Nothing else a viewer sends goes anywhere: no offer, no game-started, no input.
    send(viewer, { type: "offer", sdp: { type: "offer", sdp: "v=0 viewer" } });
    send(viewer, { type: "game-started", sessionId: "x" });
    await handled(viewer);
    await handled(player);
    assert.deepEqual(
      // The PC's own game-started, from before anyone asked, aside.
      player.received.filter(
        (m) =>
          ["answer", "ice", "crew", "offer", "game-started"].includes(m.type) &&
          !(m.type === "game-started" && m.sessionId === sessionId),
      ),
      [
        { type: "answer", sdp: { type: "answer", sdp: "v=0 viewer" }, watchId },
        { type: "ice", candidate: { candidate: RELAY_CANDIDATE }, watchId },
        { type: "crew", data: { kind: "voice", inVoice: true, muted: false }, watchId },
      ],
    );
    // The PC never hears of the viewer, nor of anything the player says to them.
    assert.deepEqual(host.received.slice(before), []);
  });

  it("passes a viewer no address but the relay's: relay candidates only, an SDP stripped of the rest", async () => {
    const { player, viewer, watchId } = await accepted();
    const watching = await heard(viewer, isWatching, "watching");
    // The viewer's connection is relay-only: it is handed the TURN relay and nothing else.
    assert.deepEqual(
      watching.iceServers?.map((server) => server.urls),
      [[TURN.urls]],
    );

    const sdp = [
      "v=0",
      "o=- 1 2 IN IP4 192.168.1.20",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "c=IN IP4 198.51.100.7",
      "a=rtcp:9 IN IP4 198.51.100.7",
      "a=candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host generation 0",
      "a=candidate:2 1 udp 1686052607 198.51.100.7 54321 typ srflx raddr 192.168.1.20 rport 54321",
      "a=candidate:3 1 udp 41885439 203.0.113.9 50000 typ relay raddr 198.51.100.7 rport 54321",
      "a=mid:0",
    ].join("\r\n");
    send(player, {
      type: "offer",
      sdp: { type: "offer", sdp },
      watchId,
      extra: "not passed on",
    } as SignalMessage);
    const host = "candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host generation 0";
    const srflx = "candidate:2 1 udp 1686052607 198.51.100.7 54321 typ srflx raddr 192.168.1.20 rport 54321";
    const relayed = "candidate:3 1 udp 41885439 203.0.113.9 50000 typ relay raddr 198.51.100.7 rport 54321";
    for (const candidate of [host, srflx, relayed, ""]) {
      send(player, { type: "ice", candidate: { candidate, sdpMid: "0", sdpMLineIndex: 0 }, watchId });
    }
    await handled(player);
    await wait(100);

    const offer = viewer.received.find((m) => m.type === "offer");
    assert.deepEqual(offer, {
      type: "offer",
      sdp: {
        type: "offer",
        sdp: [
          "v=0",
          "o=- 1 2 IN IP4 0.0.0.0",
          "m=video 9 UDP/TLS/RTP/SAVPF 96",
          "c=IN IP4 0.0.0.0",
          "a=rtcp:9 IN IP4 0.0.0.0",
          "a=candidate:3 1 udp 41885439 203.0.113.9 50000 typ relay raddr 0.0.0.0 rport 0",
          "a=mid:0",
        ].join("\r\n"),
      },
      watchId,
    });
    const candidates = viewer.received
      .filter((m): m is Extract<SignalMessage, { type: "ice" }> => m.type === "ice")
      .map((m) => m.candidate.candidate);
    assert.deepEqual(candidates, [
      "candidate:3 1 udp 41885439 203.0.113.9 50000 typ relay raddr 0.0.0.0 rport 0",
      "",
    ]);
    // Nothing a viewer receives names a host or srflx address.
    const heardText = JSON.stringify(viewer.received);
    for (const address of ["192.168.1.20", "typ srflx", "198.51.100.7"]) {
      assert.ok(!heardText.includes(address), `a viewer heard ${address}`);
    }

    // And the same the other way: a viewer's host candidate never reaches the player.
    send(viewer, { type: "ice", candidate: { candidate: host } });
    send(viewer, { type: "ice", candidate: { candidate: srflx } });
    await handled(viewer);
    await wait(100);
    assert.ok(!player.received.some((m) => m.type === "ice"));
  });

  it("never lets the PC reach a viewer, nor the player's own talk to the PC name one", async () => {
    const { host, player, viewer, watchId } = await accepted();
    send(host, { type: "offer", sdp: { type: "offer", sdp: "v=0 host" }, watchId });
    send(host, { type: "crew", data: { kind: "roster", people: [] } });
    send(player, { type: "crew", data: { kind: "voice", inVoice: true, muted: false } });
    await handled(host);
    await handled(player);
    assert.ok(!viewer.received.some((m) => m.type === "offer" || m.type === "crew"));
    assert.ok(!player.received.some((m) => m.type === "offer" || m.type === "crew"));
    assert.ok(!host.received.some((m) => m.type === "crew"));
  });

  it("tells a viewer the player said no, and hangs up", async () => {
    const { player, viewer, watchId } = await scene();
    const gone = closed(viewer);
    send(player, { type: "watch-answer", watchId, accept: false });
    await gone;
    assert.equal(denial(viewer), "watch-declined");
    await handled(player);
    assert.deepEqual((await heard(player, isWatchers, "watchers")).watchers, []);
  });

  it("lets the player stop a viewer at any time, and the ticket opens nothing after", async () => {
    const { player, viewer, watchId, ticket } = await accepted();
    const gone = closed(viewer);
    send(player, { type: "watch-stop", watchId });
    await gone;
    assert.equal(denial(viewer), "watch-stopped");
    const again = await tracked();
    send(again, { type: "watch", ticket });
    await closed(again);
    assert.equal(denial(again), "watch-stopped");
  });

  it("takes the player's say only from the player, about their own session", async () => {
    const { viewer, watchId } = await scene();
    // Lea cannot let herself in.
    send(viewer, { type: "watch-answer", watchId, accept: true });
    await handled(viewer);
    assert.ok(!viewer.received.some((m) => m.type === "watching" && m.state === "watching"));
    // Nor can another room's player.
    const other = await scene();
    send(other.player, { type: "watch-answer", watchId, accept: true });
    send(other.player, { type: "watch-stop", watchId });
    await handled(other.player);
    assert.equal(viewer.readyState, WebSocket.OPEN);
    assert.ok(!viewer.received.some((m) => m.type === "watching" && m.state === "watching"));
  });

  it("lets everyone asking in when the player shares with the crew", async () => {
    const { player, viewer } = await scene();
    send(player, { type: "watch-share", open: true });
    await handled(player);
    assert.equal((await heard(viewer, isWatching, "watching")).state, "watching");
    assert.equal((await heard(player, isWatchers, "watchers")).sharing, true);
  });

  it("drops a share the database cannot answer, and leaves the player's own socket open", async () => {
    const { player, viewer } = await scene();
    // The crew read fails: its table is gone for the moment.
    await database.exec("ALTER TABLE crew_machines RENAME TO crew_machines_away");
    try {
      send(player, { type: "watch-share", open: true });
      await handled(player);
      await wait(300);
      assert.equal(player.readyState, WebSocket.OPEN);
      assert.equal(viewer.readyState, WebSocket.OPEN);
      assert.ok(!viewer.received.some((m) => m.type === "watching" && m.state === "watching"));
    } finally {
      await database.exec("ALTER TABLE crew_machines_away RENAME TO crew_machines");
    }
    // Once it can answer, the same share goes through.
    send(player, { type: "watch-share", open: true });
    await handled(player);
    assert.equal((await heard(viewer, isWatching, "watching")).state, "watching");
    assert.equal((await heard(player, isWatchers, "watchers")).sharing, true);
    // Closing reads nothing: with the table away again, the player's no still stops the share.
    await database.exec("ALTER TABLE crew_machines RENAME TO crew_machines_away");
    try {
      player.received.length = 0;
      send(player, { type: "watch-share", open: false });
      await handled(player);
    } finally {
      await database.exec("ALTER TABLE crew_machines_away RENAME TO crew_machines");
    }
    const closed = (m: SignalMessage): m is Extract<SignalMessage, { type: "watchers" }> =>
      isWatchers(m) && !m.sharing;
    assert.equal((await heard(player, closed, "the share closed")).sharing, false);
  });

  it("hands each viewer a relay credential minted for their own watch, never the player's or the relay's secret", async () => {
    const lea = await scene();
    const asked = await call("POST", `/api/crew-live/${lea.sessionId}/watch`, JON);
    assert.equal(asked.status, 200);
    const jon = { viewer: await tracked(), watchId: asked.body.watchId as string };
    send(jon.viewer, { type: "watch", ticket: asked.body.ticket });
    await handled(jon.viewer);
    send(lea.player, { type: "watch-share", open: true });
    await handled(lea.player);

    const turnOf = async (viewer: RecordingSocket) => {
      const watching = await heard(viewer, isWatching, "watching");
      assert.equal(watching.state, "watching");
      assert.equal(watching.iceServers?.length, 1);
      return watching.iceServers![0]!;
    };
    const leas = await turnOf(lea.viewer);
    const jons = await turnOf(jon.viewer);
    const joined = lea.player.received.find(
      (m): m is Extract<SignalMessage, { type: "joined" }> => m.type === "joined",
    );
    const players = joined?.iceServers?.[0];
    assert.ok(players, "the player is handed a relay credential of their own");

    // Each names its own watch, in the TURN REST form the relay checks: `<expiry>:<who>`, signed with its secret.
    for (const [mine, watchId] of [
      [leas, lea.watchId],
      [jons, jon.watchId],
    ] as const) {
      assert.match(String(mine.username), new RegExp(`^\\d+:${watchId}-viewer$`));
      assert.equal(
        mine.credential,
        createHmac("sha1", TURN.secret).update(String(mine.username)).digest("base64"),
      );
    }
    // Shared with nobody: not with the other viewer, nor the player.
    const usernames = new Set([leas.username, jons.username, players.username]);
    const credentials = new Set([leas.credential, jons.credential, players.credential]);
    assert.equal(usernames.size, 3);
    assert.equal(credentials.size, 3);
    // And nobody is ever handed the relay's own secret.
    for (const ws of [lea.viewer, jon.viewer, lea.player]) {
      assert.ok(!JSON.stringify(ws.received).includes(TURN.secret));
    }
  });

  it("tells the crew's walls when the player's sharing changes, not each time they say it again", async () => {
    const { player } = await scene();
    const abort = new AbortController();
    const wall = await fetch(`${HTTP}/api/events`, {
      signal: abort.signal,
      headers: { cookie: `${SESSION_COOKIE}=${mintRenterSession(SESSION, LEA, 3600)}` },
    });
    let text = "";
    const reading = (async () => {
      const decoder = new TextDecoder();
      const reader = wall.body!.getReader();
      try {
        for (let read = await reader.read(); !read.done; read = await reader.read())
          text += decoder.decode(read.value, { stream: true });
      } catch {
        // Aborted at the end of the test.
      }
    })();
    const crewEvents = () => text.split("event: crew\n").length - 1;
    try {
      await wait(100);
      for (const open of [true, true, true, false, false]) {
        send(player, { type: "watch-share", open });
        await handled(player);
      }
      await wait(200);
      assert.equal(crewEvents(), 2);
    } finally {
      abort.abort();
      await reading;
    }
  });

  it("stops a viewer who leaves the player's crew", async () => {
    const { viewer } = await accepted();
    // Lea leaves: her membership is hers to end.
    const mine = await call("GET", "/api/crews", LEA);
    const membership = mine.body.crews[0].memberId as string;
    const gone = closed(viewer);
    assert.equal((await call("POST", `/api/crew-members/${membership}/remove`, LEA)).status, 200);
    await gone;
    assert.equal(denial(viewer), "not-crew");
    membersIn = false;
  });

  it("keeps a share with the crew it was made for when the PC comes to play for another", async () => {
    const first = await crew();
    // Mara's later crew, which the stranger is in: the room plays for it alone, so it is the session's.
    const later = await call("POST", "/api/crews", MARA, { name: "Later Squad" });
    const laterId = later.body.crew.id as string;
    for (const member of [STRANGER, OWNER]) {
      assert.equal((await call("POST", `/api/invites/${later.body.crew.token}/join`, member)).status, 200);
    }
    const { player, viewer, room, sessionId } = await scene({ crews: [laterId], viewerId: STRANGER });
    send(player, { type: "watch-share", open: true });
    await handled(player);
    assert.equal((await heard(viewer, isWatching, "watching")).state, "watching");

    // The PC now plays for her first crew too, which would be the session's had she not shared.
    assert.equal(
      (
        await call(
          "PUT",
          `/api/machines/${room}/availability`,
          undefined,
          { available: true, ...REPORT, crews: [first, laterId] },
          MACHINE_KEY,
        )
      ).status,
      200,
    );
    assert.equal((await call("POST", `/api/crew-live/${sessionId}/watch`, LEA)).status, 404);
    await wait(500);
    assert.equal(denial(viewer), undefined);
    const told = await heard(player, isWatchers, "watchers");
    assert.equal(told.crew?.id, laterId);
    assert.equal(told.sharing, true);
  });

  it("drops the crew a share was made for once the PC no longer plays for it, and falls back to the one left", async () => {
    const first = await crew();
    const other = await call("POST", "/api/crews", MARA, { name: "Left Over" });
    const otherId = other.body.crew.id as string;
    for (const member of [STRANGER, OWNER]) {
      assert.equal((await call("POST", `/api/invites/${other.body.crew.token}/join`, member)).status, 200);
    }
    // The room plays for both; the session's crew is the first, which Lea is in.
    const { player, viewer, room, sessionId } = await scene({ crews: [first, otherId] });
    send(player, { type: "watch-share", open: true });
    await handled(player);
    assert.equal((await heard(viewer, isWatching, "watching")).state, "watching");

    // The PC stops playing for the first crew.
    const gone = closed(viewer);
    assert.equal(
      (
        await call(
          "PUT",
          `/api/machines/${room}/availability`,
          undefined,
          { available: true, ...REPORT, crews: [otherId] },
          MACHINE_KEY,
        )
      ).status,
      200,
    );
    await gone;
    assert.equal(denial(viewer), "not-crew");
    const told = await heard(
      player,
      (m): m is Extract<SignalMessage, { type: "watchers" }> =>
        m.type === "watchers" && m.crew?.id === otherId,
      "watchers for the crew left",
    );
    assert.equal(told.sharing, false);
    assert.deepEqual(told.watchers, []);
    // Anyone in the crew left may ask, and waits for a yes: the share closed with the crew it was for.
    const asked = await call("POST", `/api/crew-live/${sessionId}/watch`, STRANGER);
    assert.equal(asked.status, 200);
    assert.equal(asked.body.state, "asking");
    assert.equal((await call("POST", `/api/crew-live/${sessionId}/watch`, LEA)).status, 404);
  });

  /** A room playing for Mara's first crew and a fresh one the stranger is in; Lea asks, Mara shares, pinning the first. */
  /** How many crews pinnedThenLeft founded: each is a new one, by a name of its own. */
  let leftCrews = 0;
  async function pinnedThenLeft() {
    const first = await crew();
    const other = await call("POST", "/api/crews", MARA, { name: `Still Here ${++leftCrews}` });
    assert.equal(other.status, 201);
    const otherId = other.body.crew.id as string;
    for (const member of [STRANGER, OWNER]) {
      assert.equal((await call("POST", `/api/invites/${other.body.crew.token}/join`, member)).status, 200);
    }
    const s = await scene({ crews: [first, otherId] });
    send(s.player, { type: "watch-share", open: true });
    await handled(s.player);
    assert.equal((await heard(s.viewer, isWatching, "watching")).state, "watching");
    // The PC stops playing for the pinned crew.
    const gone = closed(s.viewer);
    assert.equal(
      (
        await call(
          "PUT",
          `/api/machines/${s.room}/availability`,
          undefined,
          { available: true, ...REPORT, crews: [otherId] },
          MACHINE_KEY,
        )
      ).status,
      200,
    );
    return { ...s, otherId, gone };
  }

  it("shares with the crew left when the player shares right after the PC leaves the pinned one", async () => {
    const { player, viewer, sessionId, otherId, gone } = await pinnedThenLeft();
    send(player, { type: "watch-share", open: true });
    await gone;
    assert.equal(denial(viewer), "not-crew");
    const told = await heard(
      player,
      (m): m is Extract<SignalMessage, { type: "watchers" }> =>
        m.type === "watchers" && m.crew?.id === otherId && m.sharing,
      "sharing with the crew left",
    );
    assert.deepEqual(told.watchers, []);
    const asked = await call("POST", `/api/crew-live/${sessionId}/watch`, STRANGER);
    assert.equal(asked.status, 200);
    assert.equal(asked.body.state, "watching");
  });

  it("takes an ask from the crew left right after the PC leaves the pinned one", async () => {
    const { sessionId, gone } = await pinnedThenLeft();
    const asked = await call("POST", `/api/crew-live/${sessionId}/watch`, STRANGER);
    assert.equal(asked.status, 200);
    assert.equal(asked.body.state, "asking");
    await gone;
  });

  it("opens watching to the crew the player picks, and stops anyone of the one before", async () => {
    const { player, viewer, sessionId } = await accepted();
    const first = await crew();
    // Mara's other crew, which the PCs play for too.
    const night = await call("POST", "/api/crews", MARA, { name: "Night Owls" });
    const nightId = night.body.crew.id as string;
    for (const member of [STRANGER, OWNER]) {
      assert.equal((await call("POST", `/api/invites/${night.body.crew.token}/join`, member)).status, 200);
    }
    assert.equal((await call("POST", `/api/crews/${nightId}/pc`, OWNER, { pc: "yes" })).status, 200);
    // Not a crew of hers: nothing changes.
    send(player, { type: "watch-share", open: true, crew: "no-such-crew" });
    await handled(player);
    assert.equal(denial(viewer), undefined);
    assert.equal((await call("POST", `/api/crew-live/${sessionId}/watch`, STRANGER)).status, 404);

    const gone = closed(viewer);
    send(player, { type: "watch-share", open: true, crew: nightId });
    await gone;
    assert.equal(denial(viewer), "not-crew");
    const told = await heard(
      player,
      (m): m is Extract<SignalMessage, { type: "watchers" }> =>
        m.type === "watchers" && m.crew?.id === nightId && m.watchers.length === 0,
      "watchers for Night Owls",
    );
    assert.equal(told.sharing, true);
    assert.deepEqual(
      told.crews.map((c) => c.id),
      [first, nightId],
    );
    assert.equal((await call("POST", `/api/crew-live/${sessionId}/watch`, LEA)).status, 404);
    const stranger = await call("POST", `/api/crew-live/${sessionId}/watch`, STRANGER);
    assert.equal(stranger.status, 200);
    assert.equal(stranger.body.state, "watching");
  });

  it("ends every watch when the session ends", async () => {
    const { viewer, bookingId } = await accepted();
    const gone = closed(viewer);
    assert.equal((await call("POST", `/api/bookings/${bookingId}/end`, MARA)).status, 200);
    await gone;
    assert.equal(denial(viewer), "watch-ended");
  });

  it("keeps the viewers when the player's page drops, and tells them when it is back", async () => {
    const { player, viewer, room, playerTicket, watchId } = await accepted();
    player.close();
    await wait(100);
    assert.equal((await heard(viewer, isWatching, "watching")).playerHere, false);
    assert.equal(viewer.readyState, WebSocket.OPEN);
    const back = await tracked();
    send(back, { type: "join", ticket: playerTicket });
    await handled(back);
    assert.equal((await heard(viewer, isWatching, "watching")).playerHere, true);
    assert.deepEqual((await heard(back, isWatchers, "watchers")).watchers, [
      { watchId, name: null, state: "watching", here: true },
    ]);
    assert.ok(room);
  });

  it("tells the player nothing while their crews cannot be read, and tells them in full once they can", async () => {
    const { player, watchId, playerTicket } = await accepted();
    player.close();
    await wait(100);
    await database.exec("ALTER TABLE crew_machines RENAME TO crew_machines_away");
    const back = await tracked();
    try {
      send(back, { type: "join", ticket: playerTicket });
      await handled(back);
      // A few checks go by: never an empty list of crews, which would say nobody may watch.
      await wait(500);
      assert.deepEqual(back.received.filter(isWatchers), []);
    } finally {
      await database.exec("ALTER TABLE crew_machines_away RENAME TO crew_machines");
    }
    const told = await heard(
      back,
      (m): m is Extract<SignalMessage, { type: "watchers" }> => m.type === "watchers" && m.crews.length > 0,
      "watchers once the crews read again",
    );
    assert.ok(told.crew);
    assert.deepEqual(told.watchers, [{ watchId, name: null, state: "watching", here: true }]);
  });

  it("ends the watch at once when the viewer leaves, and lets them ask again", async () => {
    const { player, viewer, sessionId } = await accepted();
    viewer.close();
    await closed(viewer);
    await handled(player);
    assert.deepEqual((await heard(player, isWatchers, "watchers")).watchers, []);
    assert.equal((await call("POST", `/api/crew-live/${sessionId}/watch`, LEA)).status, 200);
  });

  it("keeps a viewer whose socket dropped, to come back on the same ticket", async () => {
    const { player, viewer, ticket, watchId } = await accepted();
    viewer.terminate();
    await closed(viewer);
    await handled(player);
    assert.deepEqual((await heard(player, isWatchers, "watchers")).watchers, [
      { watchId, name: null, state: "watching", here: false },
    ]);
    const back = await tracked();
    send(back, { type: "watch", ticket });
    await handled(back);
    assert.equal((await heard(back, isWatching, "watching")).state, "watching");
  });

  it("refuses a forged watch ticket, and one for another viewer's watch", async () => {
    const { watchId, sessionId, room } = await scene();
    const forged = await tracked();
    send(forged, { type: "watch", ticket: "nope.nope" });
    await closed(forged);
    assert.equal(denial(forged), "bad-watch-ticket");
    const exp = Math.floor(Date.now() / 1000) + 600;
    const stolen = await tracked();
    send(stolen, {
      type: "watch",
      ticket: mintWatchTicket(SECRET, { room, session: sessionId, watch: watchId, viewer: JON, exp }),
    });
    await closed(stolen);
    assert.equal(denial(stolen), "bad-watch-ticket");
  });
});
