// Pairing a gaming PC with its owner's Steam account (pairing.ts): the host
// app makes its own machine key, the owner adds the PC signed in with Steam,
// and the app learns its machine id with the key. The paired PC is then a
// machine like any MACHINE_KEYS names: it offers itself with its key, and is
// its owner's.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { mintRenterSession, parseMachineKeys, parseMachineOwners, type Access } from "../access.js";
import { createApi } from "../api.js";
import type { Database } from "../db.js";
import { keyHashOf, MAX_PAIRED, openPairings, pairingCode, type Pairings } from "../pairing.js";
import { Platform } from "../platform.js";
import { SESSION_COOKIE } from "../signin.js";
import { emptyProfile } from "../steam.js";
import { testDatabase } from "./db.js";
import { REPORT } from "./report.js";

const SECRET = "test-room-secret-that-is-long-enough-to-pass";
const SESSION = "test-session-secret-that-is-long-enough-too";
/** A test's sign-in session lasts ten years, so the real clock never finds it expired. */
const SESSION_TTL_S = 10 * 365 * 24 * 3600;
/** Owns the PC being paired. */
const LENA = "76561198000000031";
/** Somebody else. */
const KAI = "76561198000000032";
/** The key a PC's app made, and another's. */
const KEY = "app-made-key-0123456789abcdefghijklmnopqrstu";
const OTHER_KEY = "app-made-key-of-another-pc-0123456789abcdefg";
/** A PC MACHINE_KEYS names, by hand. */
const HAND_KEY = "hand-minted-key";
const MACHINE_KEYS = `hand-pc:${keyHashOf(HAND_KEY)}:${KAI}`;

describe("pairing", () => {
  let database: Database;
  let platform: Platform;
  let access: Access;
  let pairings: Pairings;
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer(async (req, res) => {
      const api = createApi({
        platform,
        access,
        sessionSecret: SESSION,
        publicOrigin: "http://localhost",
        fallbackOrigin: "http://localhost",
        pairings,
        profile: async (steamId) => {
          if (steamId === KAI) throw new Error("Steam is down");
          return { ...emptyProfile(steamId), persona: steamId === LENA ? "Lena" : "" };
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
    database = await testDatabase();
    access = {
      secret: SECRET,
      machines: parseMachineKeys(MACHINE_KEYS),
      owners: parseMachineOwners(MACHINE_KEYS),
    };
    platform = await Platform.open({ database, owners: access.owners });
    pairings = await openPairings(database, access);
  });

  afterEach(() => platform.close());

  /** One JSON call, signed in as `steamId` when given one, with `key` as the bearer when given one. */
  async function call(
    method: string,
    path: string,
    { steamId, key, body }: { steamId?: string; key?: string; body?: unknown } = {},
  ) {
    const headers: Record<string, string> = {};
    if (steamId) headers.cookie = `${SESSION_COOKIE}=${mintRenterSession(SESSION, steamId, SESSION_TTL_S)}`;
    if (key) headers.authorization = `Bearer ${key}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${origin}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }

  const add = (steamId: string, key = KEY) =>
    call("POST", "/api/pairings", { steamId, body: { keyHash: keyHashOf(key) } });
  const mine = (key = KEY) => call("GET", "/api/pairings/mine", { key });

  it("pairs the PC with the signed-in owner, and the app learns its machine id with its key", async () => {
    assert.equal((await mine()).status, 404, "nobody has added it yet");
    const added = await add(LENA);
    assert.equal(added.status, 201);
    assert.match(added.body.machineId, /^pc-[0-9a-f]{12}$/);
    const asked = await mine();
    assert.deepEqual([asked.status, asked.body], [200, { machineId: added.body.machineId, owner: "Lena" }]);
    assert.equal(
      asked.headers.get("access-control-allow-origin"),
      "*",
      "the host app asks from its own origin",
    );
    assert.equal(access.owners.get(added.body.machineId), LENA, "it is Lena's: she is never matched to it");
  });

  it("lets the paired PC offer itself with its key, as one from MACHINE_KEYS does", async () => {
    const { machineId } = (await add(LENA)).body;
    const offered = await call("PUT", `/api/machines/${machineId}/availability`, {
      key: KEY,
      body: { available: true, ...REPORT },
    });
    assert.equal(offered.status, 200);
    const wrong = await call("PUT", `/api/machines/${machineId}/availability`, {
      key: OTHER_KEY,
      body: { available: true, ...REPORT },
    });
    assert.equal(wrong.status, 401);
  });

  it("answers the same machine id when the owner adds the PC again", async () => {
    const first = await add(LENA);
    const again = await add(LENA);
    assert.deepEqual([again.status, again.body], [200, first.body]);
  });

  it("answers the app whose PC it is by Steam id when Steam gives no persona", async () => {
    const { machineId } = (await add(KAI)).body;
    assert.deepEqual((await mine()).body, { machineId, owner: KAI });
  });

  it("refuses a PC paired with someone else's account", async () => {
    await add(LENA);
    const taken = await add(KAI);
    assert.deepEqual([taken.status, taken.body.code], [409, "paired-elsewhere"]);
  });

  it("asks the owner to sign in first", async () => {
    const res = await call("POST", "/api/pairings", { body: { keyHash: keyHashOf(KEY) } });
    assert.equal(res.status, 401);
    assert.equal((await mine()).status, 404);
  });

  it("takes only a key's SHA-256, never the key itself", async () => {
    for (const keyHash of [KEY, keyHashOf(KEY).toUpperCase(), "", 42]) {
      const res = await call("POST", "/api/pairings", { steamId: LENA, body: { keyHash } });
      assert.equal(res.status, 400, String(keyHash));
    }
  });

  it("answers the app with no key 401, and a key nobody added 404", async () => {
    assert.equal((await call("GET", "/api/pairings/mine")).status, 401);
    assert.equal((await mine(OTHER_KEY)).status, 404);
    // A hand-minted key is no pairing.
    assert.equal((await mine(HAND_KEY)).status, 404);
  });

  it(`stops at ${MAX_PAIRED} PCs per account`, async () => {
    for (let i = 0; i < MAX_PAIRED; i++) assert.equal((await add(LENA, `${KEY}-${i}`)).status, 201);
    const over = await add(LENA, `${KEY}-over`);
    assert.deepEqual([over.status, over.body.code], [409, "too-many"]);
    assert.equal((await add(KAI, `${KEY}-over`)).status, 201, "the cap is per account");
  });

  it("knows the paired PCs again after a restart, and one paired by another server once its app asks", async () => {
    const { machineId } = (await add(LENA)).body;
    // A restart: what MACHINE_KEYS names, and the pairings from the database.
    const restarted: Access = {
      secret: SECRET,
      machines: parseMachineKeys(MACHINE_KEYS),
      owners: parseMachineOwners(MACHINE_KEYS),
    };
    await openPairings(database, restarted);
    assert.equal(restarted.owners.get(machineId), LENA);
    assert.ok(restarted.machines.has(machineId));
    // A server that opened before the pairing learns of it when the app asks there.
    const stale: Access = { secret: SECRET, machines: new Map(), owners: new Map() };
    const early = await openPairings(database, stale);
    await pairings.pair(LENA, keyHashOf(OTHER_KEY));
    assert.equal(stale.machines.size, 1, "only the PC paired before it opened");
    const id = await early.pairedWith(OTHER_KEY);
    assert.ok(id && stale.machines.has(id) && stale.owners.get(id) === LENA);
  });

  it("never takes over a machine id MACHINE_KEYS names for another key", async () => {
    const { machineId } = (await add(LENA)).body;
    const clash: Access = {
      secret: SECRET,
      machines: parseMachineKeys(`${machineId}:${keyHashOf(HAND_KEY)}:${KAI}`),
      owners: parseMachineOwners(`${machineId}:${keyHashOf(HAND_KEY)}:${KAI}`),
    };
    const there = await openPairings(database, clash);
    assert.equal(clash.owners.get(machineId), KAI);
    assert.equal(await there.pairedWith(KEY), null);
  });

  it("shows the owner the same short code the app shows", () => {
    assert.equal(pairingCode("3f9a2c" + "0".repeat(58)), "3F9-A2C");
  });
});
