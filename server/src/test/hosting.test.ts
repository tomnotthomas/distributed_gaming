// A server where hosting requires attestation (HOSTING_ATTESTATION=required),
// judged by the insecure dev verifier: the machine key keeps its control rights
// and loses every hosting one, and a host certificate from attestation hosts.
// The default policy, where the machine key hosts too, is what every other
// server test runs under.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { mintHostCert, mintRenterSession } from "../access.js";
import type { PlatformFacts } from "../attestation.js";
import { sessionPath, type HostCertGrant, type SessionGrant, type SignalMessage } from "../protocol.js";
import { SESSION_COOKIE } from "../signin.js";
import { serverDatabase, type ServerDatabase } from "./db.js";
import { REPORT } from "./report.js";

const SERVER = fileURLToPath(new URL("../index.js", import.meta.url));
const PORT = 9900 + Math.floor(Math.random() * 300);
const HTTP = `http://localhost:${PORT}`;
const SECRET = "test-room-secret-that-is-long-enough-to-pass";
const SESSION_SECRET = "test-session-secret-that-is-long-enough-too";
/** A signed-in renter, who alone may book and claim. */
const RENTER_COOKIE = `${SESSION_COOKIE}=${mintRenterSession(SESSION_SECRET, "76561198000000001", 3600)}`;
const MACHINE_KEY = "test-machine-key";
const HASH = createHash("sha256").update(MACHINE_KEY).digest("hex");
const ROOMS = ["pc-1", "pc-2", "pc-3", "pc-4", "pc-5", "pc-6", "pc-7"];
const TURN = "turn:turn.example.test:3478";
/** What the dev verifier is told about a machine that meets the hardware floor. */
const FACTS: PlatformFacts = {
  uefi: true,
  secureBoot: true,
  tpm: "firmware",
  ekCertificate: true,
  iommu: true,
};

let database: ServerDatabase;
let server: ChildProcess | undefined;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One JSON call as the signed-in renter, with `credential` as bearer when given one. */
async function call(method: string, path: string, body?: unknown, credential?: string) {
  const res = await fetch(`${HTTP}${path}`, {
    method,
    headers: {
      cookie: RENTER_COOKIE,
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

/** Attest `room` as swiff-hostd would, with the dev verifier's evidence, and return its grant. */
async function attest(room: string, facts: PlatformFacts = FACTS): Promise<HostCertGrant> {
  const challenge = await call("POST", `/api/machines/${room}/attest-challenge`);
  assert.equal(challenge.status, 200);
  const attested = await call("POST", `/api/machines/${room}/attest`, {
    nonce: challenge.body.nonce,
    evidence: { machineKey: MACHINE_KEY, facts },
  });
  // The status only: the body carries the host certificate.
  assert.equal(attested.status, 200, `attest answered ${attested.status}`);
  return attested.body as HostCertGrant;
}

/** A socket registered on `room` with `credential`, recording what it hears. */
async function host(room: string, credential: Record<string, string>) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const received: SignalMessage[] = [];
  const closed = new Promise<number>((resolve) => ws.once("close", resolve));
  ws.on("message", (raw) => received.push(JSON.parse(String(raw)) as SignalMessage));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "register", hostId: room, ...credential }));
  // The first answer is registered or denied.
  for (let i = 0; i < 200 && !received.length; i++) await wait(25);
  return { ws, received, closed };
}

/** A renter books and claims `room`, the only machine on offer. Returns the claimed session's id. */
async function claimRoom(room: string): Promise<string> {
  const offered = await call(
    "PUT",
    `/api/machines/${room}/availability`,
    { available: true, ...REPORT },
    MACHINE_KEY,
  );
  assert.equal(offered.status, 200, "the machine key still sets availability");
  const booking = await call("POST", "/api/bookings", { gameId: 730, minutes: 30 });
  const claim = await call("POST", `/api/bookings/${booking.body.bookingId}/claim`);
  assert.equal(claim.status, 200, `claim answered ${claim.status}`);
  assert.equal(claim.body.roomId, room);
  return claim.body.sessionId as string;
}

before(async () => {
  database = await serverDatabase();
  server = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ROOM_SECRET: SECRET,
      SESSION_SECRET,
      MACHINE_KEYS: ROOMS.map((room) => `${room}:${HASH}`).join(","),
      DATABASE_URL: database.url,
      HOSTING_ATTESTATION: "required",
      ATTESTATION_VERIFIER: "insecure-dev",
      TURN_URLS: TURN,
      TURN_USERNAME: "user",
      TURN_CREDENTIAL: "pass",
    },
    stdio: "ignore",
  });
  // Up to 15 s: the server opens its database before it listens, slower under a full test run.
  for (let i = 0; i < 150; i++) {
    try {
      await fetch(`${HTTP}/api/bookings/none`);
      return;
    } catch {
      await wait(100);
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

describe("hosting requires attestation", () => {
  it("refuses the machine key's socket: it would hear claims and get TURN", async () => {
    const { received, closed } = await host("pc-1", { key: MACHINE_KEY });
    assert.equal(await closed, 4003);
    assert.deepEqual(received, [{ type: "denied", reason: "attestation-required" }]);
  });

  it("serves a renter end to end on a host certificate, the machine key keeping control", async () => {
    const room = "pc-2";
    const grant = await attest(room);
    assert.equal(grant.tier, "attested");

    const service = await host(room, { hostCert: grant.hostCert });
    const registered = service.received[0];
    assert.equal(registered?.type, "registered");
    assert.deepEqual(registered.type === "registered" && registered.iceServers?.[0]?.urls, [TURN]);

    // The claim reaches the attested socket at once.
    const sessionId = await claimRoom(room);
    await wait(100);
    assert.deepEqual(
      service.received.filter((m) => m.type === "session-claimed"),
      [{ type: "session-claimed", sessionId, appid: 730, minutes: 30 }],
    );

    // The machine key may not mint session keys, nor report the renter in.
    assert.deepEqual(await call("POST", sessionPath(room), { sessionId }, MACHINE_KEY), {
      status: 403,
      body: { error: "attestation-required" },
    });
    assert.deepEqual(await call("POST", `/api/sessions/${sessionId}/start`, {}, MACHINE_KEY), {
      status: 403,
      body: { error: "attestation-required" },
    });
    // The host certificate may, and the streamer serves on its session key.
    const started = await call("POST", sessionPath(room), { sessionId }, grant.hostCert);
    assert.equal(started.status, 201, `start answered ${started.status}`);
    const sessionKey = (started.body as SessionGrant).sessionKey;
    assert.equal(service.received.at(-1)?.type, "denied", "the service's socket is put out for the session");
    const streamer = await host(room, { sessionKey });
    assert.equal(streamer.received[0]?.type, "registered");
    assert.equal((await call("POST", `/api/sessions/${sessionId}/start`, {}, grant.hostCert)).status, 200);

    // Control stays with the machine key: heartbeat, and the owner's end-early.
    assert.equal((await call("POST", `/api/machines/${room}/heartbeat`, {}, MACHINE_KEY)).status, 200);
    assert.equal((await call("POST", `/api/machines/${room}/heartbeat`, {}, grant.hostCert)).status, 200);
    assert.equal((await call("DELETE", sessionPath(room), undefined, MACHINE_KEY)).status, 204);
    assert.equal(await streamer.closed, 4003);
    assert.deepEqual(streamer.received.at(-1), { type: "denied", reason: "session-ended" });

    // That certificate started its session: the next start, and a register, need a fresh one.
    assert.deepEqual(await call("POST", sessionPath(room), { sessionId }, grant.hostCert), {
      status: 401,
      body: { error: "bad-host-cert" },
    });
    const spent = await host(room, { hostCert: grant.hostCert });
    assert.equal(await spent.closed, 4003);
    assert.deepEqual(spent.received, [{ type: "denied", reason: "bad-host-cert" }]);
    const again = await call("POST", sessionPath(room), { sessionId }, (await attest(room)).hostCert);
    assert.equal(again.status, 201, `start answered ${again.status}`);
    await call("POST", `/api/sessions/${sessionId}/end`, {}, MACHINE_KEY);
  });

  it("refuses a host certificate for another room, or a machine key sent as one", async () => {
    const other = mintHostCert(SECRET, "pc-4", "attested", 600);
    for (const hostCert of [other, MACHINE_KEY]) {
      const { received, closed } = await host("pc-3", { hostCert });
      assert.equal(await closed, 4003);
      assert.deepEqual(received, [{ type: "denied", reason: "bad-host-cert" }]);
    }
    assert.deepEqual(await call("POST", sessionPath("pc-3"), { sessionId: "x" }, other), {
      status: 401,
      body: { error: "bad-host-cert" },
    });
    assert.equal(
      (await call("PUT", "/api/machines/pc-3/availability", { available: false }, other)).status,
      401,
    );
  });

  it("refuses a register with no credential, or more than one, and registers nothing", async () => {
    const cert = mintHostCert(SECRET, "pc-3", "attested", 600);
    const cases: [Record<string, unknown>, string][] = [
      [{}, "bad-machine-key"],
      [{ key: 42 }, "bad-machine-key"],
      [{ key: MACHINE_KEY, hostCert: cert }, "bad-host-cert"],
      [{ hostCert: cert, sessionKey: "x" }, "bad-host-cert"],
      [{ key: MACHINE_KEY, sessionKey: "x" }, "bad-session-key"],
    ];
    for (const [credential, reason] of cases) {
      const { received, closed } = await host("pc-3", credential as Record<string, string>);
      assert.equal(await closed, 4003);
      assert.deepEqual(received, [{ type: "denied", reason }], JSON.stringify(Object.keys(credential)));
    }
    // The same certificate on its own still registers: nothing above spent or seated it.
    const alone = await host("pc-3", { hostCert: cert });
    assert.equal(alone.received[0]?.type, "registered");
    alone.ws.close();
  });

  it("answers attestation refusals with their reasons", async () => {
    const challenge = await call("POST", "/api/machines/pc-3/attest-challenge");
    const below = await call("POST", "/api/machines/pc-3/attest", {
      nonce: challenge.body.nonce,
      evidence: { machineKey: MACHINE_KEY, facts: { ...FACTS, iommu: false } },
    });
    assert.deepEqual(below, {
      status: 403,
      body: { error: "attestation-refused", reason: "below-hardware-floor" },
    });
    const again = await call("POST", "/api/machines/pc-3/attest", {
      nonce: challenge.body.nonce,
      evidence: { machineKey: MACHINE_KEY, facts: FACTS },
    });
    assert.equal(again.status, 200, "a failed attempt does not use its challenge up");
    const used = await call("POST", "/api/machines/pc-3/attest", {
      nonce: challenge.body.nonce,
      evidence: { machineKey: MACHINE_KEY, facts: FACTS },
    });
    assert.deepEqual(used, { status: 401, body: { error: "bad-nonce" } });
    const garbled = await fetch(`${HTTP}/api/machines/pc-3/attest`, { method: "POST", body: "{not json" });
    assert.deepEqual(
      { status: garbled.status, body: await garbled.json() },
      {
        status: 400,
        body: { error: "bad-request" },
      },
    );
    assert.deepEqual(await call("POST", "/api/machines/pc-9/attest-challenge"), {
      status: 404,
      body: { error: "not-found" },
    });
    assert.equal((await attest("pc-3", { ...FACTS, tpm: "discrete" })).tier, "attested-discrete-tpm");
  });

  it("keeps a machine the machine key offers off the market until an attested socket is open", async () => {
    const room = "pc-5";
    const offered = await call(
      "PUT",
      `/api/machines/${room}/availability`,
      { available: true, ...REPORT },
      MACHINE_KEY,
    );
    assert.equal(offered.status, 200);
    assert.equal((await call("POST", `/api/machines/${room}/heartbeat`, {}, MACHINE_KEY)).status, 200);
    const booking = await call("POST", "/api/bookings", { gameId: 730, minutes: 30 });
    assert.equal(booking.body.status, "queued", "nothing can serve it, so nothing is matched");

    const service = await host(room, { hostCert: (await attest(room)).hostCert });
    assert.equal(service.received[0]?.type, "registered");
    const matched = await call("GET", `/api/bookings/${booking.body.bookingId}`);
    assert.equal(matched.body.status, "matched");
    assert.equal(matched.body.machine?.id, room);
    assert.equal((await call("POST", `/api/bookings/${booking.body.bookingId}/end`)).status, 200);
    service.ws.close();
  });

  it("says rentalMode on the claim of a machine offered with an attested host certificate, not the machine key", async () => {
    const room = "pc-7";
    const grant = await attest(room);
    const service = await host(room, { hostCert: grant.hostCert });
    assert.equal(service.received[0]?.type, "registered");

    const claimOffered = async (credential: string) => {
      const offered = await call(
        "PUT",
        `/api/machines/${room}/availability`,
        { available: true, ...REPORT },
        credential,
      );
      assert.equal(offered.status, 200, `availability answered ${offered.status}`);
      const booking = await call("POST", "/api/bookings", { gameId: 730, minutes: 30 });
      const claim = await call("POST", `/api/bookings/${booking.body.bookingId}/claim`);
      assert.equal(claim.status, 200, `claim answered ${claim.status}`);
      assert.equal(claim.body.roomId, room);
      const ticket = await call("POST", `/api/bookings/${booking.body.bookingId}/ticket`);
      assert.equal(ticket.status, 200, `ticket answered ${ticket.status}`);
      assert.equal((await call("POST", `/api/bookings/${booking.body.bookingId}/end`)).status, 200);
      return [claim.body.rentalMode, ticket.body.rentalMode];
    };

    assert.deepEqual(await claimOffered(MACHINE_KEY), [false, false]);
    assert.deepEqual(await claimOffered(grant.hostCert), [true, true]);
    assert.deepEqual(await claimOffered(MACHINE_KEY), [false, false]);
    service.ws.close();
  });

  it("puts out a socket whose host certificate expires, so it hears no claim", async () => {
    const room = "pc-6";
    const service = await host(room, { hostCert: mintHostCert(SECRET, room, "attested", 2) });
    assert.equal(service.received[0]?.type, "registered");
    assert.equal(await service.closed, 4003);
    assert.deepEqual(service.received.at(-1), { type: "denied", reason: "bad-host-cert" });
  });
});
