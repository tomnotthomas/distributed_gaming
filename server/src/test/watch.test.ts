// Watching a crewmate play: only a crewmate may ask or watch, only the player's
// yes lets them watch, the player stops anyone at any time, leaving the crew or
// the session ending stops it, and watching costs the player nothing. The
// watch state (watch.ts), the platform's crew checks, the API that hands out
// watch tickets, and the signaling server that seats viewers and carries their
// frames to the player and nowhere else.

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
const PERSONA: Record<string, string> = { [MARA]: "Mara", [LEA]: "Lea", [JON]: "Jon" };
const MACHINE_KEYS = ["pc-1", "pc-2"].map((id) => `${id}:${HASH}:76561198000000099`).join(",");

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
    watches = new Watches({ now: () => now });
    platform = await Platform.open({ database: await testDatabase(), now: () => now, owners });
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

  /** Mara's crew: Lea and Jon joined by her link. Returns Lea's membership. */
  async function maraCrew() {
    const { inviteId } = await platform.crewInvite(MARA, "Mara");
    assert.ok((await platform.joinCrew(inviteId, LEA, "Lea")).ok);
    assert.ok((await platform.joinCrew(inviteId, JON, "Jon")).ok);
    return (await platform.crewInvite(MARA, "Mara")).members.find((m) => m.name === "Lea")!;
  }

  /** `renter` books and claims pc-1, and (unless still `starting`, behind Ignition) plays on it. */
  async function plays(renter: string, { starting = false } = {}) {
    await platform.setAvailability("pc-1", true, REPORT);
    const booking = await platform.book(730, 60, renter);
    const claim = await platform.claim(booking.bookingId, renter);
    assert.ok(claim.ok);
    if (!starting) assert.equal(await platform.startSession("pc-1", claim.sessionId), true);
    return { bookingId: booking.bookingId, sessionId: claim.sessionId };
  }

  it("lists the sessions a player's crewmates play, never their own or a stranger's", async () => {
    await maraCrew();
    const { sessionId } = await plays(MARA);
    const seen = await platform.crewLive(LEA);
    assert.deepEqual(
      seen.map((s) => [s.sessionId, s.playerName, s.room, s.gameId]),
      [[sessionId, "Mara", "pc-1", 730]],
    );
    assert.deepEqual(await platform.crewLive(MARA), []);
    assert.deepEqual(await platform.crewLive(STRANGER), []);
  });

  it("says why a session may not be watched", async () => {
    const lea = await maraCrew();
    const { sessionId, bookingId } = await plays(MARA);
    assert.equal(typeof (await platform.watchable(sessionId, LEA)), "object");
    assert.equal(await platform.watchable(sessionId, STRANGER), "not-crew");
    assert.equal(await platform.watchable(sessionId, MARA), "not-crew");
    assert.equal(await platform.watchable("nope", LEA), "ended");
    assert.deepEqual(await platform.watchesStopped([{ sessionId, viewerId: LEA }]), new Map());

    // Lea leaves Mara's crew: she may watch no more.
    assert.ok(await platform.leaveCrew(lea.id, LEA));
    assert.deepEqual(
      await platform.watchesStopped([
        { sessionId, viewerId: LEA },
        { sessionId, viewerId: JON },
      ]),
      new Map([[`${sessionId}:${LEA}`, "not-crew"]]),
    );

    await platform.endBooking(bookingId, MARA);
    assert.equal(await platform.watchable(sessionId, JON), "ended");
    assert.deepEqual(
      await platform.watchesStopped([{ sessionId, viewerId: JON }]),
      new Map([[`${sessionId}:${JON}`, "ended"]]),
    );
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
    const deadline = (await platform.crewLive(LEA))[0]!.expiresAt;
    assert.equal(ticket.exp, Math.floor(deadline / 1000));
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
    assert.equal(await platform.watchable(sessionId, LEA), "ended");
    const listed = await call("GET", "/api/crew-live", LEA);
    assert.deepEqual(
      listed.body.live.map((s: { sessionId: string; starting: boolean }) => [s.sessionId, s.starting]),
      [[sessionId, true]],
    );
    assert.equal((await call("POST", `/api/crew-live/${sessionId}/watch`, LEA)).status, 404);
    assert.deepEqual(watches.all(), []);

    assert.equal(await platform.startSession("pc-1", sessionId), true);
    assert.equal((await call("GET", "/api/crew-live", LEA)).body.live[0].starting, false);
    assert.equal((await call("POST", `/api/crew-live/${sessionId}/watch`, LEA)).status, 200);
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
    watches = full;
    const refused = await call("POST", `/api/crew-live/${sessionId}/watch`, JON);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "full");
  });

  it("costs the player nothing: no booking, no machine and no time is spent on a viewer", async () => {
    await maraCrew();
    const { bookingId, sessionId } = await plays(MARA);
    const before = await platform.booking(bookingId, MARA);
    const deadline = (await platform.crewLive(LEA))[0]!.expiresAt;
    const asked = await call("POST", `/api/crew-live/${sessionId}/watch`, LEA);
    watches.answer(sessionId, asked.body.watchId, true);
    assert.deepEqual(await platform.booking(bookingId, MARA), before);
    // The session still ends when the player's own time runs out, not a moment later.
    assert.equal((await platform.crewLive(LEA))[0]!.expiresAt, deadline);
    // Lea booked nothing and holds nothing: her crew-live list is all she has.
    assert.equal((await call("GET", "/api/bookings/none", LEA)).status, 404);
    assert.equal((await platform.crewLive(LEA)).length, 1);
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
        MACHINE_KEYS: ROOMS.map((room) => `${room}:${HASH}`).join(","),
        DATABASE_URL: database.url,
        SWIFF_PLAYABILITY: "off",
        SWIFF_TICKET_RECONCILE_MS: "200",
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

  /** A crew of Mara (who invites) and `friends`, made once per test run. */
  let crewMade = false;
  async function crew() {
    if (crewMade) return;
    const invite = await call("GET", "/api/me/invite", MARA);
    for (const friend of [LEA, JON]) {
      assert.equal((await call("POST", `/api/invites/${invite.body.token}/join`, friend)).status, 200);
    }
    crewMade = true;
  }

  /**
   * Mara plays in a fresh room: its PC registered, her booking claimed and
   * started, and her page seated with the ticket. Lea asks to watch and her page takes its seat.
   */
  async function scene() {
    await crew();
    const room = ROOMS[roomIndex++]!;
    assert.equal(
      (
        await call(
          "PUT",
          `/api/machines/${room}/availability`,
          undefined,
          { available: true, ...REPORT },
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
    assert.equal(
      (await call("POST", `/api/sessions/${claim.body.sessionId}/start`, undefined, {}, MACHINE_KEY)).status,
      200,
    );
    const player = await tracked();
    send(player, { type: "join", ticket: claim.body.ticket });
    await handled(player);
    const asked = await call("POST", `/api/crew-live/${claim.body.sessionId}/watch`, LEA);
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

  it("seats a viewer to wait for the player's yes, and tells the player who asks", async () => {
    const { player, viewer, watchId } = await scene();
    const watching = await heard(viewer, isWatching, "watching");
    assert.deepEqual(
      { ...watching, iceServers: undefined },
      // No Steam here, so nobody has a name.
      { type: "watching", watchId, state: "asking", player: null, playerHere: true, iceServers: undefined },
    );
    const watchers = await heard(player, isWatchers, "watchers");
    assert.deepEqual(watchers, {
      type: "watchers",
      sharing: false,
      watchers: [{ watchId, name: null, state: "asking", here: true }],
    });
  });

  it("carries nothing between the player and a viewer still asking", async () => {
    const { player, viewer, watchId } = await scene();
    send(player, { type: "offer", sdp: { type: "offer", sdp: "v=0 player" }, watchId });
    send(viewer, { type: "ice", candidate: { candidate: "candidate:viewer" } });
    await handled(player);
    await handled(viewer);
    assert.ok(!viewer.received.some((m) => m.type === "offer"));
    assert.ok(!player.received.some((m) => m.type === "ice"));
  });

  it("on the player's yes, carries the player's offer to the viewer and the viewer's answer back, never to the PC", async () => {
    const { host, player, viewer, watchId } = await accepted();
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
    send(viewer, { type: "ice", candidate: { candidate: "candidate:viewer" } });
    send(viewer, { type: "crew", data: { kind: "voice", inVoice: true, muted: false } });
    // Nothing else a viewer sends goes anywhere: no offer, no game-started, no input.
    send(viewer, { type: "offer", sdp: { type: "offer", sdp: "v=0 viewer" } });
    send(viewer, { type: "game-started", sessionId: "x" });
    await handled(viewer);
    await handled(player);
    assert.deepEqual(
      player.received.filter((m) => ["answer", "ice", "crew", "offer", "game-started"].includes(m.type)),
      [
        { type: "answer", sdp: { type: "answer", sdp: "v=0 viewer" }, watchId },
        { type: "ice", candidate: { candidate: "candidate:viewer" }, watchId },
        { type: "crew", data: { kind: "voice", inVoice: true, muted: false }, watchId },
      ],
    );
    // The PC never hears of the viewer, nor of anything the player says to them.
    assert.deepEqual(host.received.slice(before), []);
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

  it("stops a viewer who leaves the player's crew", async () => {
    const { viewer } = await accepted();
    // Lea leaves: her membership is hers to end.
    const mine = await call("GET", "/api/me/invite", LEA);
    const membership = mine.body.joined[0].id as string;
    const gone = closed(viewer);
    assert.equal((await call("POST", `/api/crew-members/${membership}/remove`, LEA)).status, 200);
    await gone;
    assert.equal(denial(viewer), "not-crew");
    crewMade = false;
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
