// Unit tests for the hosting-requires-attestation seam: which credential may
// host, how a machine earns a host certificate, and the D3 hardware floor.
// hosting.test.ts covers a server enforcing it end to end.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  accessFromEnv,
  mintChallenge,
  mintHostCert,
  mintSessionKey,
  mintTicket,
  verifyHostCert,
  type Access,
} from "../access.js";
import {
  attestationFromEnv,
  CHALLENGE_TTL_SECONDS,
  createAttestation,
  HARDWARE_FLOOR,
  HOST_CERT_TTL_SECONDS,
  insecureDevVerifier,
  MAX_ATTEMPTS_PER_MINUTE,
  tierFor,
  type AttestationVerifier,
  type PlatformFacts,
} from "../attestation.js";

const SECRET = "a-secret-that-is-at-least-32-characters";
const KEY = "the-machine-key";
const HASH = createHash("sha256").update(KEY).digest("hex");
const ACCESS: Access = accessFromEnv({ ROOM_SECRET: SECRET, MACHINE_KEYS: `pc-1:${HASH},pc-2:${HASH}` });

/** A machine that meets the floor with a firmware TPM. */
const GOOD: PlatformFacts = {
  uefi: true,
  secureBoot: true,
  tpm: "firmware",
  ekCertificate: true,
  iommu: true,
};
const evidence = (facts: PlatformFacts = GOOD) => ({ facts });

/** Attestation that hosts only with a host certificate, judged by the dev stub. */
const required = (verifier: AttestationVerifier | null = insecureDevVerifier) =>
  createAttestation({ access: ACCESS, verifier, attestedOnly: true });

/** A challenge for `room` from `attestation`, failing the test if it is refused. */
function nonceFor(
  attestation: ReturnType<typeof createAttestation>,
  room = "pc-1",
  now = Date.now(),
): string {
  const challenge = attestation.challenge(room, now);
  assert.ok(challenge.ok, "challenge refused");
  return challenge.grant.nonce;
}

describe("the hardware floor (D3)", () => {
  it("hosts a firmware TPM at the top tier and a discrete one at the lower tier", () => {
    assert.equal(tierFor(GOOD), "attested");
    assert.equal(tierFor({ ...GOOD, tpm: "discrete" }), "attested-discrete-tpm");
  });

  it("refuses a machine missing any part of the floor", () => {
    assert.equal(tierFor({ ...GOOD, tpm: null }), null);
    for (const part of ["uefi", "secureBoot", "ekCertificate", "iommu"] as const) {
      assert.equal(tierFor({ ...GOOD, [part]: false }), null, part);
    }
  });

  it("is one setting: a floor that refuses discrete TPMs refuses them", () => {
    assert.equal(tierFor({ ...GOOD, tpm: "discrete" }, { ...HARDWARE_FLOOR, discreteTpm: "refused" }), null);
    assert.equal(tierFor({ ...GOOD, iommu: false }, { ...HARDWARE_FLOOR, iommu: false }), "attested");
  });
});

describe("attestation config", () => {
  it("lets the machine key host by default, with no verifier", () => {
    const config = attestationFromEnv({});
    assert.equal(config.attestedOnly, false);
    assert.equal(config.verifier, null);
  });

  it("requires attestation when told to, and for anything it does not recognise", () => {
    assert.equal(attestationFromEnv({ HOSTING_ATTESTATION: "required" }).attestedOnly, true);
    assert.equal(attestationFromEnv({ HOSTING_ATTESTATION: " Required " }).attestedOnly, true);
    const typo = attestationFromEnv({ HOSTING_ATTESTATION: "optinal" });
    assert.equal(typo.attestedOnly, true);
    assert.ok(typo.warnings.some((w) => w.includes("HOSTING_ATTESTATION")));
  });

  it("knows only the insecure dev verifier, and warns whenever it is set", () => {
    const dev = attestationFromEnv({ ATTESTATION_VERIFIER: "insecure-dev" });
    assert.equal(dev.verifier, insecureDevVerifier);
    assert.ok(dev.warnings.some((w) => w.includes("insecure-dev")));
    const unknown = attestationFromEnv({ ATTESTATION_VERIFIER: "keylime" });
    assert.equal(unknown.verifier, null);
    assert.ok(unknown.warnings.some((w) => w.includes("keylime")));
  });

  it("warns that no PC can host when attestation is required with no verifier", () => {
    const { warnings } = attestationFromEnv({ HOSTING_ATTESTATION: "required" });
    assert.ok(warnings.some((w) => w.includes("no PC can host")));
  });
});

describe("credentials", () => {
  it("lets the machine key host, unattested, while attestation is optional", () => {
    const attestation = createAttestation({ access: ACCESS });
    assert.deepEqual(attestation.credential("pc-1", KEY), { kind: "machine-key", hosting: "unattested" });
  });

  it("keeps the machine key for control only while attestation is required", () => {
    assert.deepEqual(required().credential("pc-1", KEY), { kind: "machine-key", hosting: null });
  });

  it("lets a host certificate host its own room at its tier, under either policy", () => {
    const cert = mintHostCert(SECRET, "pc-1", "attested-discrete-tpm", 600);
    const { id, exp } = verifyHostCert(SECRET, cert)!;
    for (const attestation of [required(), createAttestation({ access: ACCESS })]) {
      assert.deepEqual(attestation.credential("pc-1", cert), {
        kind: "host-cert",
        hosting: "attested-discrete-tpm",
        id,
        exp,
        spent: false,
      });
      assert.equal(attestation.credential("pc-2", cert), null, "another room");
    }
  });

  it("refuses an expired, forged or foreign certificate, and other tokens", () => {
    const now = Date.now();
    const attestation = required();
    const cert = mintHostCert(SECRET, "pc-1", "attested", 60, now);
    assert.ok(attestation.credential("pc-1", cert, now + 59_000));
    assert.equal(attestation.credential("pc-1", cert, now + 60_000), null);
    assert.equal(
      attestation.credential("pc-1", mintHostCert(`${SECRET}-other`, "pc-1", "attested", 60)),
      null,
    );
    assert.equal(attestation.credential("pc-1", mintTicket(SECRET, "pc-1", 60)), null);
    const sessionKey = mintSessionKey(SECRET, { room: "pc-1", session: "s", grant: "g" }, 60);
    assert.equal(attestation.credential("pc-1", sessionKey), null);
    assert.equal(attestation.credential("pc-1", mintChallenge(SECRET, "pc-1", 60)), null);
    assert.equal(attestation.credential("pc-1", "wrong-key"), null);
    assert.equal(attestation.credential("pc-1", undefined), null);
  });

  it("refuses a certificate for a machine no longer in MACHINE_KEYS", () => {
    const cert = mintHostCert(SECRET, "pc-gone", "attested", 600);
    assert.equal(required().credential("pc-gone", cert), null);
  });
});

describe("spending a host certificate", () => {
  it("starts one host session per certificate", () => {
    const attestation = required();
    const cert = mintHostCert(SECRET, "pc-1", "attested", 600);
    const fresh = attestation.credential("pc-1", cert)!;
    assert.equal(attestation.spend(fresh), true);
    assert.equal(attestation.spend(fresh), false, "a second start on it");
    assert.deepEqual(attestation.credential("pc-1", cert), { ...fresh, spent: true });
    const other = attestation.credential("pc-1", mintHostCert(SECRET, "pc-1", "attested", 600))!;
    assert.equal(attestation.spend(other), true, "another certificate is its own");
  });

  it("never spends the machine key", () => {
    const attestation = createAttestation({ access: ACCESS });
    const key = attestation.credential("pc-1", KEY)!;
    assert.equal(attestation.spend(key), true);
    assert.equal(attestation.spend(key), true);
  });
});

describe("attesting", () => {
  it("mints a host certificate for evidence that passes, at the floor's tier", async () => {
    const now = Date.now();
    const attestation = required();
    const challenge = attestation.challenge("pc-1", now);
    assert.ok(challenge.ok);
    assert.equal(challenge.grant.expiresAt, Math.floor(now / 1000) + CHALLENGE_TTL_SECONDS);

    const attested = await attestation.attest("pc-1", challenge.grant.nonce, evidence(), now);
    assert.ok(attested.ok);
    assert.equal(attested.grant.tier, "attested");
    assert.equal(attested.grant.expiresAt, Math.floor(now / 1000) + HOST_CERT_TTL_SECONDS);
    const cert = verifyHostCert(SECRET, attested.grant.hostCert, now);
    assert.deepEqual(cert, { room: "pc-1", tier: "attested", id: cert?.id, exp: attested.grant.expiresAt });
    assert.ok(cert?.id, "every certificate has an id of its own");

    const discrete = await attestation.attest(
      "pc-1",
      nonceFor(attestation),
      evidence({ ...GOOD, tpm: "discrete" }),
    );
    assert.ok(discrete.ok);
    assert.equal(discrete.grant.tier, "attested-discrete-tpm");
  });

  it("hands the verifier the machine, the nonce and the evidence as sent", async () => {
    const seen: unknown[] = [];
    const attestation = required({
      name: "spy",
      verify: async (input) => {
        seen.push(input);
        return { ok: true, facts: GOOD };
      },
    });
    const nonce = nonceFor(attestation);
    assert.ok((await attestation.attest("pc-1", nonce, { quote: "q" })).ok);
    assert.deepEqual(seen, [{ room: "pc-1", nonce, evidence: { quote: "q" } }]);
  });

  it("refuses evidence the verifier rejects, and a machine below the floor", async () => {
    const attestation = required();
    assert.deepEqual(await attestation.attest("pc-1", nonceFor(attestation), { quote: "not facts" }), {
      ok: false,
      status: 403,
      body: { error: "attestation-refused", reason: "evidence-rejected" },
    });
    assert.deepEqual(
      await attestation.attest("pc-1", nonceFor(attestation), evidence({ ...GOOD, secureBoot: false })),
      {
        ok: false,
        status: 403,
        body: { error: "attestation-refused", reason: "below-hardware-floor" },
      },
    );
  });

  it("takes each challenge once, whatever the first attempt's outcome", async () => {
    const attestation = required();
    const nonce = nonceFor(attestation);
    assert.equal((await attestation.attest("pc-1", nonce, { quote: "bad" })).ok, false);
    assert.deepEqual(await attestation.attest("pc-1", nonce, evidence()), {
      ok: false,
      status: 401,
      body: { error: "bad-nonce" },
    });
  });

  it("refuses a challenge that is expired, forged, or another machine's", async () => {
    const now = Date.now();
    const attestation = required();
    const badNonce = { ok: false, status: 401, body: { error: "bad-nonce" } };
    const expired = nonceFor(attestation, "pc-1", now);
    assert.deepEqual(
      await attestation.attest("pc-1", expired, evidence(), now + CHALLENGE_TTL_SECONDS * 1000),
      badNonce,
    );
    assert.deepEqual(
      await attestation.attest("pc-1", mintChallenge(`${SECRET}-other`, "pc-1", 60), evidence()),
      badNonce,
    );
    assert.deepEqual(await attestation.attest("pc-1", nonceFor(attestation, "pc-2"), evidence()), badNonce);
    assert.deepEqual(await attestation.attest("pc-1", mintTicket(SECRET, "pc-1", 60), evidence()), badNonce);
  });

  it("answers a verifier that fails with a documented refusal, the challenge spent", async () => {
    const attestation = required({
      name: "down",
      verify: async () => {
        throw new Error("keylime unreachable");
      },
    });
    const nonce = nonceFor(attestation);
    assert.deepEqual(await attestation.attest("pc-1", nonce, evidence()), {
      ok: false,
      status: 503,
      body: { error: "verifier-unavailable" },
    });
    assert.equal((await attestation.attest("pc-1", nonce, evidence())).ok, false, "spent");
  });

  it("keeps at most MAX_ATTEMPTS_PER_MINUTE live spent challenges per machine", async () => {
    const now = Date.now();
    const attestation = required();
    for (let i = 0; i < MAX_ATTEMPTS_PER_MINUTE; i++) {
      assert.equal((await attestation.attest("pc-1", nonceFor(attestation, "pc-1", now), {}, now)).ok, false);
    }
    assert.deepEqual(await attestation.attest("pc-1", nonceFor(attestation, "pc-1", now), evidence(), now), {
      ok: false,
      status: 429,
      body: { error: "too-many-attempts" },
    });
    assert.ok(
      (await attestation.attest("pc-2", nonceFor(attestation, "pc-2", now), evidence(), now)).ok,
      "another machine",
    );
    // Once the spent ones expire, the machine attests again.
    const later = now + CHALLENGE_TTL_SECONDS * 1000;
    assert.ok((await attestation.attest("pc-1", nonceFor(attestation, "pc-1", later), evidence(), later)).ok);
  });

  it("answers a malformed request, an unknown machine and a server with no verifier", async () => {
    const attestation = required();
    assert.deepEqual(await attestation.attest("pc-1", 42, evidence()), {
      ok: false,
      status: 400,
      body: { error: "bad-request" },
    });
    assert.deepEqual(await attestation.attest("pc-1", nonceFor(attestation), undefined), {
      ok: false,
      status: 400,
      body: { error: "bad-request" },
    });
    assert.deepEqual(attestation.challenge("pc-9"), { ok: false, status: 404, body: { error: "not-found" } });
    const unconfigured = required(null);
    assert.deepEqual(unconfigured.challenge("pc-1"), {
      ok: false,
      status: 503,
      body: { error: "not-configured" },
    });
    assert.deepEqual(await unconfigured.attest("pc-1", mintChallenge(SECRET, "pc-1", 60), evidence()), {
      ok: false,
      status: 503,
      body: { error: "not-configured" },
    });
  });
});
