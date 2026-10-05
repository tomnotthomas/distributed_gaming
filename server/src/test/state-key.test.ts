// The state key (state-key.ts): the server's share of a rental-mode PC's state
// partition key, released only to the boot that just attested, refused to
// stale, replayed or other machines' certificates, withheld after a
// continuity gap or during a firmware cooldown, refused once revoked,
// rate-limited, sealed at rest, and never logged.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { accessFromEnv, mintHostCert, type Access } from "../access.js";
import { createApi } from "../api.js";
import {
  createAttestation,
  insecureDevVerifier,
  type Attestation,
  type AttestationVerifier,
  type PlatformFacts,
} from "../attestation.js";
import { RequestBudget } from "../budget.js";
import type { Platform } from "../platform.js";
import { migrate } from "../schema.js";
import {
  createStateKeys,
  databaseStateKeyStore,
  memoryStateKeyStore,
  STATE_KEY_BYTES,
  STATE_KEY_FRESH_SECONDS,
  stateKeySecretFromEnv,
  type StateKeys,
  type StateKeySecurityEvent,
  type StateKeyStore,
} from "../state-key.js";
import { testDatabase } from "./db.js";

const ROOM_SECRET = "a-secret-that-is-at-least-32-characters";
const STATE_SECRET = "the-state-key-secret-also-32-characters-long";
const KEY = "the-machine-key";
const HASH = createHash("sha256").update(KEY).digest("hex");
const ACCESS: Access = accessFromEnv({ ROOM_SECRET, MACHINE_KEYS: `pc-1:${HASH},pc-2:${HASH}` });
const GOOD: PlatformFacts = {
  uefi: true,
  secureBoot: true,
  tpm: "firmware",
  ekCertificate: true,
  iommu: true,
};

/** The dev verifier, with a cooldown the test sets. */
function verifier(cooldown: Set<string>): AttestationVerifier {
  return { ...insecureDevVerifier(ACCESS.machines), inCooldown: async (room) => cooldown.has(room) };
}

type Rig = {
  attestation: Attestation;
  stateKeys: StateKeys;
  store: StateKeyStore;
  events: StateKeySecurityEvent[];
  cooldown: Set<string>;
  /** A host certificate from attesting `room` at the boot `boot` counts (undefined: not counted). */
  attest(boot: number | undefined, room?: string, now?: number): Promise<string>;
  release(cert: string | null, room?: string, now?: number): ReturnType<StateKeys["release"]>;
  replace(cert: string | null, room?: string, now?: number): ReturnType<StateKeys["replace"]>;
};

function rig({
  store = memoryStateKeyStore(),
  secret = STATE_SECRET as string | null,
  budget,
}: { store?: StateKeyStore; secret?: string | null; budget?: RequestBudget } = {}): Rig {
  const events: StateKeySecurityEvent[] = [];
  const cooldown = new Set<string>();
  const v = verifier(cooldown);
  const stateKeys = createStateKeys({
    store,
    secret,
    verifier: v,
    securityLog: (event) => events.push(event),
    budget: budget ?? new RequestBudget({ burst: 100 }),
  });
  const attestation = createAttestation({
    access: ACCESS,
    verifier: v,
    attestedOnly: true,
    onAttested: stateKeys.observe,
  });
  return {
    attestation,
    stateKeys,
    store,
    events,
    cooldown,
    async attest(boot, room = "pc-1", now = Date.now()) {
      const challenge = attestation.challenge(room, now);
      assert.ok(challenge.ok, "challenge refused");
      const evidence = { machineKey: KEY, facts: GOOD, ...(boot === undefined ? {} : { resetCount: boot }) };
      const attested = await attestation.attest(room, challenge.grant.nonce, evidence, now);
      assert.ok(attested.ok, `attestation refused: ${JSON.stringify(!attested.ok && attested.body)}`);
      return attested.grant.hostCert;
    },
    release: (cert, room = "pc-1", now = Date.now()) =>
      stateKeys.release(room, attestation.credential(room, cert, now), now),
    replace: (cert, room = "pc-1", now = Date.now()) =>
      stateKeys.replace(room, attestation.credential(room, cert, now), now),
  };
}

/** The share a grant carries, failing the test when it is a refusal. */
function shareOf(result: Awaited<ReturnType<StateKeys["release"]>>, status: 200 | 201 = 200) {
  assert.ok(result.ok, `refused: ${JSON.stringify(!result.ok && result.body)}`);
  assert.equal(result.status, status);
  const share = Buffer.from(result.grant.share, "base64");
  assert.equal(share.length, STATE_KEY_BYTES);
  return { keyId: result.grant.keyId, share: result.grant.share };
}

function refusal(result: Awaited<ReturnType<StateKeys["release"]>>, status: number, error: string) {
  assert.ok(!result.ok, "released when it should have been refused");
  assert.equal(result.status, status);
  assert.deepEqual(result.body, { error });
}

/** A machine that has a share, made at boot `boot`. */
async function provisioned(r: Rig, boot = 7, room = "pc-1") {
  const cert = await r.attest(boot, room);
  refusal(await r.release(cert, room), 404, "no-state-key");
  return shareOf(await r.replace(cert, room), 201);
}

describe("state key release", () => {
  it("makes a share on first use and releases the same one to every later attested boot", async () => {
    const r = rig();
    const made = await provisioned(r, 7);
    // The next boot, and an attestation again within it, get the same share.
    assert.deepEqual(shareOf(await r.release(await r.attest(8))), made);
    assert.deepEqual(shareOf(await r.release(await r.attest(8))), made);
    assert.deepEqual(shareOf(await r.release(await r.attest(9))), made);
  });

  it("gives each machine a share of its own", async () => {
    const r = rig();
    const one = await provisioned(r, 3, "pc-1");
    const two = await provisioned(r, 3, "pc-2");
    assert.notEqual(one.share, two.share);
    assert.notEqual(one.keyId, two.keyId);
  });

  it("releases nothing without a host certificate from attestation", async () => {
    const r = rig();
    await provisioned(r);
    refusal(await r.release(null), 401, "bad-host-cert");
    refusal(await r.release("not-a-certificate"), 401, "bad-host-cert");
    // A certificate this server never signed.
    const forged = mintHostCert(`${ROOM_SECRET}-other`, "pc-1", "attested", 600, Date.now(), 8);
    refusal(await r.release(forged), 401, "bad-host-cert");
  });

  it("never releases to the machine key, even where it may host", async () => {
    const stateKeys = createStateKeys({ store: memoryStateKeyStore(), secret: STATE_SECRET });
    const optional = createAttestation({ access: ACCESS, attestedOnly: false });
    const credential = optional.credential("pc-1", KEY);
    assert.equal(credential?.hosting, "unattested");
    refusal(await stateKeys.release("pc-1", credential), 403, "attestation-required");
    refusal(await stateKeys.replace("pc-1", credential), 403, "attestation-required");
  });

  it("refuses another machine's certificate", async () => {
    const r = rig();
    await provisioned(r, 7, "pc-1");
    const theirs = await r.attest(8, "pc-2");
    refusal(await r.release(theirs, "pc-1"), 401, "bad-host-cert");
  });

  it("refuses a certificate for a machine no longer configured", async () => {
    const r = rig();
    const cert = mintHostCert(ROOM_SECRET, "pc-gone", "attested", 600, Date.now(), 1);
    refusal(await r.release(cert, "pc-gone"), 401, "bad-host-cert");
  });

  it("refuses a stale certificate: expired, or minted too long ago", async () => {
    const r = rig();
    await provisioned(r, 7);
    const at = Date.now();
    const cert = await r.attest(8, "pc-1", at);
    refusal(await r.release(cert, "pc-1", at + (STATE_KEY_FRESH_SECONDS + 1) * 1000), 401, "stale-host-cert");
    // Past its ten minutes it is no certificate at all.
    refusal(await r.release(cert, "pc-1", at + 11 * 60_000), 401, "bad-host-cert");
    // One that counts no boot is never the machine's latest.
    const uncounted = mintHostCert(ROOM_SECRET, "pc-1", "attested", 600);
    const payload = JSON.parse(Buffer.from(uncounted.split(".")[0]!, "base64url").toString());
    assert.equal(payload.boot, null);
    refusal(await r.release(uncounted), 401, "stale-host-cert");
  });

  it("refuses a replayed certificate: one share per attestation", async () => {
    const r = rig();
    await provisioned(r, 7);
    const cert = await r.attest(8);
    shareOf(await r.release(cert));
    refusal(await r.release(cert), 401, "stale-host-cert");
    refusal(await r.replace(cert), 401, "stale-host-cert");
  });

  it("refuses a certificate from an earlier boot once a later one has attested", async () => {
    const r = rig();
    await provisioned(r, 7);
    const earlier = await r.attest(8);
    await r.attest(9);
    refusal(await r.release(earlier), 401, "stale-host-cert");
  });

  it("refuses a certificate whose attestation was never recorded", async () => {
    const r = rig();
    await provisioned(r, 7);
    // Signed with the right secret, but no attestation of boot 8 was observed.
    const cert = mintHostCert(ROOM_SECRET, "pc-1", "attested", 600, Date.now(), 8);
    refusal(await r.release(cert), 401, "stale-host-cert");
  });
});

describe("continuity", () => {
  it("withholds the share after a gap in the boots, and only a new share opens rental mode again", async () => {
    const r = rig();
    const old = await provisioned(r, 7);
    // Boots 8 and 9 were something else's: the owner's Windows, a live USB.
    const cert = await r.attest(10);
    refusal(await r.release(cert), 409, "continuity-gap");
    assert.deepEqual(r.events.at(-1), {
      event: "state-key-withheld",
      machine: "pc-1",
      keyId: old.keyId,
      lastBoot: 7,
      boot: 10,
    });
    // Attesting again within the same boot does not bring the old share back.
    refusal(await r.release(await r.attest(10)), 409, "continuity-gap");
    // Nor does the next boot.
    refusal(await r.release(await r.attest(11)), 409, "continuity-gap");
    // A new share does, and the old one is never seen again.
    const replacement = await r.attest(11);
    const fresh = shareOf(await r.replace(replacement), 201);
    assert.notEqual(fresh.keyId, old.keyId);
    assert.notEqual(fresh.share, old.share);
    assert.deepEqual(shareOf(await r.release(await r.attest(12))), fresh);
  });

  it("counts a boot that went back (the TPM was cleared) as a gap", async () => {
    const r = rig();
    await provisioned(r, 40);
    refusal(await r.release(await r.attest(2)), 409, "continuity-gap");
  });

  it("counts a boot the verifier could not count as a gap", async () => {
    const r = rig();
    await provisioned(r, 7);
    refusal(await r.release(await r.attest(undefined)), 409, "continuity-gap");
  });

  it("keeps the share across a boot that attested but never asked for it", async () => {
    const r = rig();
    const made = await provisioned(r, 7);
    await r.attest(8); // the boot stopped before it asked
    assert.deepEqual(shareOf(await r.release(await r.attest(9))), made);
  });

  it("keeps the gap through a restart, in the database", async () => {
    const db = await testDatabase();
    try {
      await migrate(db);
      const first = rig({ store: databaseStateKeyStore(db) });
      const made = await provisioned(first, 7);
      // Sealed at rest: the row holds neither the share nor the secret.
      const { rows } = await db.query<{ sealed: string }>("SELECT sealed FROM machine_state_keys");
      const sealed = Buffer.from(rows[0]!.sealed, "base64");
      assert.ok(!sealed.includes(Buffer.from(made.share, "base64")));
      assert.ok(!rows[0]!.sealed.includes(made.share));

      const second = rig({ store: databaseStateKeyStore(db) });
      assert.deepEqual(shareOf(await second.release(await second.attest(8))), made);
      refusal(await second.release(await second.attest(11)), 409, "continuity-gap");
      const third = rig({ store: databaseStateKeyStore(db) });
      refusal(await third.release(await third.attest(11)), 409, "continuity-gap");
    } finally {
      await db.close();
    }
  });
});

describe("refusals for the machine's standing", () => {
  it("refuses a machine waiting out a firmware cooldown, release and replacement alike", async () => {
    const r = rig();
    await provisioned(r, 7);
    const cert = await r.attest(8);
    r.cooldown.add("pc-1");
    refusal(await r.release(cert), 403, "firmware-cooldown");
    refusal(await r.replace(cert), 403, "firmware-cooldown");
    r.cooldown.delete("pc-1");
    shareOf(await r.release(cert));
  });

  it("destroys a revoked machine's share and refuses it any until reinstated", async () => {
    const r = rig();
    const old = await provisioned(r, 7);
    await r.stateKeys.revoke("pc-1");
    const record = await r.store.get("pc-1");
    assert.equal(record?.sealed, null);
    assert.equal(record?.keyId, null);
    const cert = await r.attest(8);
    refusal(await r.release(cert), 403, "revoked");
    refusal(await r.replace(cert), 403, "revoked");
    assert.deepEqual(r.events.at(-1), { event: "state-key-revoked", machine: "pc-1", previous: old.keyId });

    await r.stateKeys.reinstate("pc-1");
    const again = await r.attest(9);
    refusal(await r.release(again), 404, "no-state-key");
    const fresh = shareOf(await r.replace(again), 201);
    assert.notEqual(fresh.share, old.share);
  });

  it("rate-limits each machine, with when to come back", async () => {
    let clock = Date.now();
    const r = rig({ budget: new RequestBudget({ burst: 2, refillMs: 30_000, now: () => clock }) });
    const cert = await r.attest(1);
    refusal(await r.release(cert), 404, "no-state-key");
    shareOf(await r.replace(cert), 201);
    const limited = await r.release(await r.attest(1));
    refusal(limited, 429, "rate-limited");
    assert.equal(!limited.ok && limited.retryAfterSeconds, 30);
    // Another machine has a budget of its own.
    refusal(await r.release(await r.attest(1, "pc-2"), "pc-2"), 404, "no-state-key");
    clock += 30_000;
    shareOf(await r.release(await r.attest(1)));
  });

  it("answers not-configured without STATE_KEY_SECRET", async () => {
    const r = rig({ secret: null });
    refusal(await r.release(await r.attest(1)), 503, "not-configured");
  });

  it("cannot unseal a share with another secret, or moved to another machine", async () => {
    const store = memoryStateKeyStore();
    const r = rig({ store });
    await provisioned(r, 7, "pc-1");
    await provisioned(r, 7, "pc-2");
    const other = rig({ store, secret: `${STATE_SECRET}-rotated` });
    refusal(await other.release(await other.attest(8)), 500, "internal-error");
    // pc-1's sealed share in pc-2's row opens nothing.
    const one = (await store.get("pc-1"))!;
    const two = (await store.get("pc-2"))!;
    await store.put("pc-2", { ...two, sealed: one.sealed });
    refusal(await r.release(await r.attest(8, "pc-2"), "pc-2"), 500, "internal-error");
  });

  it("mints no certificate when the boot cannot be recorded", async () => {
    const failing: StateKeyStore = {
      get: async () => null,
      put: async () => {
        throw new Error("the database is down");
      },
    };
    const stateKeys = createStateKeys({ store: failing, secret: STATE_SECRET });
    const attestation = createAttestation({
      access: ACCESS,
      verifier: insecureDevVerifier(ACCESS.machines),
      onAttested: stateKeys.observe,
    });
    const challenge = attestation.challenge("pc-1");
    assert.ok(challenge.ok);
    const errors = console.error;
    console.error = () => {};
    try {
      const attested = await attestation.attest("pc-1", challenge.grant.nonce, {
        machineKey: KEY,
        facts: GOOD,
        resetCount: 1,
      });
      assert.deepEqual(attested, { ok: false, status: 503, body: { error: "verifier-unavailable" } });
    } finally {
      console.error = errors;
    }
  });
});

describe("secrets", () => {
  it("never logs a share or the secret", async () => {
    const lines: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const saved = methods.map((name) => console[name]);
    for (const name of methods)
      console[name] = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    const shares: string[] = [];
    try {
      // The default security log, on stderr.
      const stateKeys = createStateKeys({ store: memoryStateKeyStore(), secret: STATE_SECRET });
      const attestation = createAttestation({
        access: ACCESS,
        verifier: insecureDevVerifier(ACCESS.machines),
        onAttested: stateKeys.observe,
      });
      const attest = async (boot: number) => {
        const challenge = attestation.challenge("pc-1");
        assert.ok(challenge.ok);
        const attested = await attestation.attest("pc-1", challenge.grant.nonce, {
          machineKey: KEY,
          facts: GOOD,
          resetCount: boot,
        });
        assert.ok(attested.ok);
        return attestation.credential("pc-1", attested.grant.hostCert);
      };
      const cert = await attest(1);
      const made = await stateKeys.replace("pc-1", cert);
      assert.ok(made.ok);
      shares.push(made.grant.share);
      const released = await stateKeys.release("pc-1", await attest(2));
      assert.ok(released.ok);
      await stateKeys.release("pc-1", await attest(5)); // withheld
      const replaced = await stateKeys.replace("pc-1", await attest(5));
      assert.ok(replaced.ok);
      shares.push(replaced.grant.share);
      await stateKeys.revoke("pc-1");
      await stateKeys.reinstate("pc-1");
    } finally {
      methods.forEach((name, i) => (console[name] = saved[i]!));
    }
    assert.ok(
      lines.some((line) => line.includes("state-key-replaced")),
      "security events are logged",
    );
    const output = lines.join("\n");
    for (const share of shares) {
      const bytes = Buffer.from(share, "base64");
      for (const form of [share, bytes.toString("hex"), bytes.toString("base64url")]) {
        assert.ok(!output.includes(form), "a share reached the log");
      }
    }
    assert.ok(!output.includes(STATE_SECRET), "the secret reached the log");
  });

  it("reads STATE_KEY_SECRET from the environment, refusing a short one", () => {
    assert.equal(stateKeySecretFromEnv({ STATE_KEY_SECRET: STATE_SECRET }).secret, STATE_SECRET);
    assert.equal(stateKeySecretFromEnv({}).secret, null);
    assert.equal(stateKeySecretFromEnv({ STATE_KEY_SECRET: "short" }).secret, null);
    const same = stateKeySecretFromEnv({ STATE_KEY_SECRET: ROOM_SECRET, ROOM_SECRET });
    assert.equal(same.secret, ROOM_SECRET);
    assert.match(same.warnings.join(), /ROOM_SECRET/);
  });
});

describe("the state key routes", () => {
  let server: Server;
  let origin: string;
  let r: Rig;

  before(async () => {
    server = createServer(async (req, res) => {
      const api = createApi({
        platform: {} as Platform,
        access: ACCESS,
        sessionSecret: null,
        publicOrigin: null,
        fallbackOrigin: "http://localhost",
        attestation: r.attestation,
        stateKeys: r.stateKeys,
      });
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (!(await api(req, res, path))) res.writeHead(418).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());
  beforeEach(() => {
    r = rig({ budget: new RequestBudget({ burst: 3, refillMs: 60_000 }) });
  });
  const call = async (method: string, path: string, bearer?: string) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };

  it("POST releases, PUT replaces, never cached", async () => {
    const cert = await r.attest(4);
    const missing = await call("POST", "/api/machines/pc-1/state-key", cert);
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: "no-state-key" });
    const made = await call("PUT", "/api/machines/pc-1/state-key", cert);
    assert.equal(made.status, 201);
    assert.equal(made.headers.get("cache-control"), "no-store");
    assert.equal(Buffer.from(made.body.share, "base64").length, STATE_KEY_BYTES);
    const released = await call("POST", "/api/machines/pc-1/state-key", await r.attest(5));
    assert.equal(released.status, 200);
    assert.deepEqual(released.body, made.body);
    assert.equal(released.headers.get("cache-control"), "no-store");
    // No CORS: a browser page has no business with it.
    assert.equal(released.headers.get("access-control-allow-origin"), null);
  });

  it("refuses the machine key and answers 429 with retry-after", async () => {
    const machineKey = await call("POST", "/api/machines/pc-1/state-key", KEY);
    assert.equal(machineKey.status, 403);
    assert.deepEqual(machineKey.body, { error: "attestation-required" });
    const cert = await r.attest(1);
    for (let i = 0; i < 3; i++) await call("POST", "/api/machines/pc-1/state-key", cert);
    const limited = await call("POST", "/api/machines/pc-1/state-key", cert);
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.body, { error: "rate-limited" });
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  });
});
