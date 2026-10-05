// The agent against the real server: its own API client and machine-key socket,
// a renter booking, claiming and leaving through the real booking API, and a
// streamer that registers with the session key it was handed. Only the machine
// itself is faked: the reboot and the hardware floor.
//
// The agent tests drive a platform kept in memory; this one makes sure the
// server and the agent still agree on the host API and the session-key contract.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintRenterSession } from "../../../server/src/access.ts";
import type { SignalMessage } from "../../../server/src/protocol.ts";
import { SESSION_COOKIE } from "../../../server/src/signin.ts";
import { REPORT } from "../../../server/src/test/report.ts";
import { createAgent, type Outcome } from "./agent.ts";
import { createHostApi } from "./api.ts";
import { fileResumeStore } from "./resume.ts";
import { openMachineSocket } from "./socket.ts";
import type { LaunchStreamer } from "./streamer.ts";

const PORT = 8900 + Math.floor(Math.random() * 400);
const SERVER_URL = `ws://127.0.0.1:${PORT}`;
const HTTP_URL = `http://127.0.0.1:${PORT}`;
const SECRET = "hostd-integration-room-secret-long-enough";
const SESSION_SECRET = "hostd-integration-session-secret-long-enough";
const RENTER_COOKIE = `${SESSION_COOKIE}=${mintRenterSession(SESSION_SECRET, "76561198000000001", 3600)}`;
const MACHINE_KEY = "hostd-integration-machine-key";
const MACHINE = "rental-pc-1";
const HOUR = 3_600_000;

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const SERVER_ENTRY = resolve(
  REPO_ROOT,
  "server",
  (JSON.parse(readFileSync(resolve(REPO_ROOT, "server/package.json"), "utf8")) as { main: string }).main,
);

let server: ChildProcess;

beforeAll(async () => {
  // `npm test` builds the server workspace before this one runs.
  expect(existsSync(SERVER_ENTRY), `the server is not built: run \`npm run build -w @swiff/server\``).toBe(
    true,
  );
  server = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: resolve(REPO_ROOT, "server"),
    env: {
      ...process.env,
      PORT: String(PORT),
      ROOM_SECRET: SECRET,
      SESSION_SECRET,
      MACHINE_KEYS: `${MACHINE}:${createHash("sha256").update(MACHINE_KEY).digest("hex")}`,
      DATABASE_URL: "",
      // Every game playable, so nothing here waits on or calls Steam (server/src/playable.ts).
      SWIFF_PLAYABILITY: "off",
    },
    stdio: "ignore",
  });
  // Without DATABASE_URL the server first boots an in-memory Postgres: slow on a loaded machine.
  const deadline = Date.now() + 80_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`the server exited with code ${server.exitCode}`);
    try {
      if ((await fetch(`${HTTP_URL}/api/ping`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("the server did not start");
});

afterAll(() => {
  server?.kill();
});

/** Signed in as the renter. */
const RENTER = { cookie: RENTER_COOKIE };
/** With a machine key or a join ticket. */
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const HOST = bearer(MACHINE_KEY);

async function call(method: string, path: string, auth: Record<string, string>, body?: unknown) {
  const res = await fetch(`${HTTP_URL}${path}`, {
    method,
    headers: { ...auth, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    body: res.status === 204 ? null : ((await res.json()) as Record<string, unknown>),
  };
}

/** A streamer as session-keys.md has it: registers with its key, exits when put out. */
function testStreamers() {
  const seen: { key: string; messages: SignalMessage["type"][] }[] = [];
  const launch: LaunchStreamer = (grant) => {
    const record = { key: grant.sessionKey, messages: [] as SignalMessage["type"][] };
    seen.push(record);
    const ws = new WebSocket(SERVER_URL);
    const exited = new Promise<void>((done) => ws.addEventListener("close", () => done()));
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ type: "register", hostId: MACHINE, sessionKey: grant.sessionKey })),
    );
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as SignalMessage;
      record.messages.push(msg.type);
      if (msg.type === "denied") ws.close();
    });
    return { exited, stop: async () => (ws.close(), exited) };
  };
  return { seen, launch };
}

async function bootAgent(stateDir: string, launch: LaunchStreamer, bootId: string) {
  const system = { reboots: 0, windows: 0 };
  const agent = createAgent({
    api: createHostApi({ serverUrl: SERVER_URL, machineId: MACHINE, machineKey: MACHINE_KEY }),
    openSocket: (onEvent) =>
      openMachineSocket({ url: SERVER_URL, hostId: MACHINE, machineKey: MACHINE_KEY, onEvent }),
    launchStreamer: launch,
    system: {
      reboot: async () => void system.reboots++,
      returnToWindows: async () => void system.windows++,
      unmetFloor: async () => [],
      bootId: async () => bootId,
    },
    resume: fileResumeStore(stateDir),
    ownerTakeover: "when-idle",
    log: () => {},
  });
  return { agent, system, running: agent.run() };
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const machine = async () => (await call("POST", `/api/machines/${MACHINE}/heartbeat`, HOST, {})).body!;

describe("swiff-hostd against the server", () => {
  it(
    "serves a renter with a session key, then takes the PC off offer and restarts it clean",
    { timeout: 60_000 },
    async () => {
      const stateDir = join(await mkdtemp(join(tmpdir(), "swiff-hostd-")), "state");
      const shareUntil = Date.now() + 2 * HOUR;
      // The owner started sharing from Windows before the PC rebooted into rental mode.
      const offered = await call("PUT", `/api/machines/${MACHINE}/availability`, HOST, {
        available: true,
        until: shareUntil,
        ...REPORT,
      });
      expect(offered.body).toMatchObject({ status: "available", until: shareUntil });

      const streamers = testStreamers();
      const first = await bootAgent(stateDir, streamers.launch, "boot-1");
      await until(() => first.agent.status().phase === "offered", "the offer");

      // A renter books and claims the PC.
      const booking = await call("POST", "/api/bookings", RENTER, { gameId: 730, minutes: 30 });
      expect(booking.body).toMatchObject({ status: "matched" });
      const claim = await call("POST", `/api/bookings/${booking.body!.bookingId}/claim`, RENTER);
      expect(claim.status).toBe(200);
      const sessionId = claim.body!.sessionId as string;

      await until(
        () => streamers.seen[0]?.messages.includes("registered") ?? false,
        "the streamer in the room",
      );
      expect(first.agent.status()).toMatchObject({ phase: "serving", sessionId });
      // The streamer holds the room on its session key; the machine key is kept out meanwhile.
      expect(streamers.seen[0]!.key).not.toBe(MACHINE_KEY);
      expect(await machine()).toMatchObject({ status: "in_session", session: { id: sessionId } });

      // The renter leaves: the server puts the streamer out, and the agent resets the PC.
      const left = await call(
        "POST",
        `/api/sessions/${sessionId}/leave`,
        bearer(claim.body!.ticket as string),
      );
      expect(left.status).toBe(200);
      expect(await first.running).toBe<Outcome>("reset");
      expect(streamers.seen[0]!.messages).toContain("denied");
      expect(first.system).toEqual({ reboots: 1, windows: 0 });
      // Off offer while it restarts, so no renter is matched to it; the owner's terms kept.
      expect(await machine()).toMatchObject({ status: "idle", until: shareUntil });
      const waiting = await call("POST", "/api/bookings", RENTER, { gameId: 730, minutes: 30 });
      expect(waiting.body).toMatchObject({ status: "queued" });

      // Back from the restart: offered again on the same terms, and the waiting renter is matched.
      const second = await bootAgent(stateDir, streamers.launch, "boot-2");
      await until(() => second.agent.status().phase === "offered", "the offer after the reset");
      expect(await machine()).toMatchObject({ until: shareUntil });
      await until(
        async () =>
          (await call("GET", `/api/bookings/${waiting.body!.bookingId}`, RENTER)).body!.status === "matched",
        "the waiting renter matched",
      );

      // The owner asks for the PC back while no session is live: off offer, into Windows.
      expect(await second.agent.requestReturnToWindows()).toEqual({ ok: true });
      expect(await second.running).toBe<Outcome>("windows");
      expect(second.system).toEqual({ reboots: 0, windows: 1 });
      expect(await machine()).toMatchObject({ status: "idle" });
      await call("POST", `/api/bookings/${waiting.body!.bookingId}/end`, RENTER);
    },
  );

  it(
    "holds a renter who claimed before a reset that never rebooted, and serves them after the restart",
    { timeout: 60_000 },
    async () => {
      const stateDir = join(await mkdtemp(join(tmpdir(), "swiff-hostd-")), "state");
      const shareUntil = Date.now() + 2 * HOUR;
      await call("PUT", `/api/machines/${MACHINE}/availability`, HOST, {
        available: true,
        until: shareUntil,
        ...REPORT,
      });
      const booking = await call("POST", "/api/bookings", RENTER, { gameId: 730, minutes: 30 });
      expect(booking.body).toMatchObject({ status: "matched" });
      const claim = await call("POST", `/api/bookings/${booking.body!.bookingId}/claim`, RENTER);
      expect(claim.status).toBe(200);
      const sessionId = claim.body!.sessionId as string;

      // A renter was served in this boot already: the agent resets again, as a reset hold.
      await fileResumeStore(stateDir).markServed({ bootId: "boot-3", sessionId: "earlier" });
      const streamers = testStreamers();
      const again = await bootAgent(stateDir, streamers.launch, "boot-3");
      expect(await again.running).toBe<Outcome>("reset");
      expect(streamers.seen).toHaveLength(0);
      const held = await machine();
      expect(held).toMatchObject({ status: "in_session", session: { id: sessionId }, until: shareUntil });
      expect(held.resetUntil).toBeGreaterThan(Date.now());

      // Back from the restart: the held renter is served, and the hold is over.
      const back = await bootAgent(stateDir, streamers.launch, "boot-4");
      await until(
        () => streamers.seen[0]?.messages.includes("registered") ?? false,
        "the streamer in the room",
      );
      expect(back.agent.status()).toMatchObject({ phase: "serving", sessionId });
      expect(await machine()).not.toHaveProperty("resetUntil");

      const left = await call(
        "POST",
        `/api/sessions/${sessionId}/leave`,
        bearer(claim.body!.ticket as string),
      );
      expect(left.status).toBe(200);
      expect(await back.running).toBe<Outcome>("reset");
      expect(await machine()).toMatchObject({ status: "idle", until: shareUntil });
    },
  );
});
