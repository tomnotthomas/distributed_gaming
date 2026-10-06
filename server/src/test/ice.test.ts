import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { sessionSpanMs } from "@swiff/rank";
import { relayFromEnv, sharedSecretCredential, type RelaySeat } from "../ice.js";
import { MAX_MINUTES } from "../platform.js";

const NOW = 1_800_000_000_000; // Unix ms
const NOW_S = NOW / 1000;
const SECRET = "turn-shared-secret-that-is-long-enough";
const URLS = "turn:relay.example:3478, turns:relay.example:443?transport=tcp";

/** A renter's seat in session s1, ending in 30 minutes. */
const seat = (over: Partial<RelaySeat> = {}): RelaySeat => ({
  id: "s1",
  side: "renter",
  expiresAt: NOW_S + 30 * 60,
  ...over,
});

/** What coturn computes for a TURN REST API username, worked out apart from ice.ts. */
const coturnPassword = (username: string) => createHmac("sha1", SECRET).update(username).digest("base64");

/** A fetch that answers from a script, recording what it was asked. */
function fakeFetch(answer: () => unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer() as Response;
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const ok = (body: unknown) => () =>
  ({ ok: true, status: 201, json: async () => body }) as unknown as Response;

const ENDPOINT = "https://rtc.live.cloudflare.com/v1/turn/keys/key-1/credentials/generate-ice-servers";

/** What Cloudflare answers, port 53 included as its docs warn it may be. */
const MINTED = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: "minted-user",
      credential: "minted-secret",
    },
  ],
};

describe("relayFromEnv", () => {
  it("runs no relay and says nothing when nothing is configured", async () => {
    const { relay, warnings } = relayFromEnv({});
    assert.deepEqual(warnings, []);
    assert.deepEqual(await relay.credentials(seat(), NOW), []);
  });

  // Each of these hands a peer nothing rather than a relay that cannot work,
  // or one whose credential would outlive its session.
  for (const [what, env, warning] of [
    ["a secret without urls", { TURN_SECRET: SECRET }, /TURN_SECRET is set without TURN_URLS/],
    ["a short secret", { TURN_SECRET: "short", TURN_URLS: URLS }, /shorter than 32/],
    [
      "both ways to mint",
      {
        TURN_SECRET: SECRET,
        TURN_URLS: URLS,
        TURN_CREDENTIAL_URL: "https://mint.example",
        TURN_CREDENTIAL_TOKEN: "t",
      },
      /both set/,
    ],
    ["urls with no way to mint", { TURN_URLS: URLS }, /without TURN_SECRET or TURN_CREDENTIAL_URL/],
    [
      "an endpoint without its token",
      { TURN_CREDENTIAL_URL: "https://mint.example" },
      /without TURN_CREDENTIAL_TOKEN/,
    ],
    [
      "an endpoint over http",
      { TURN_CREDENTIAL_URL: "http://mint.example", TURN_CREDENTIAL_TOKEN: "t" },
      /not https/,
    ],
  ] as const) {
    it(`runs no relay, and warns, on ${what}`, async () => {
      const { relay, warnings } = relayFromEnv(env);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, warning);
      assert.deepEqual(await relay.credentials(seat(), NOW), []);
    });
  }

  it("warns once about a static pair and ttl from before, and runs the shared-secret relay anyway", async () => {
    const { relay, warnings } = relayFromEnv({
      TURN_URLS: URLS,
      TURN_USERNAME: "u",
      TURN_CREDENTIAL: "p",
      TURN_TTL_SECONDS: "3600",
      TURN_SECRET: SECRET,
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /TURN_USERNAME, TURN_CREDENTIAL, TURN_TTL_SECONDS no longer configure TURN/);
    const [server] = await relay.credentials(seat(), NOW);
    assert.equal(server!.credential, coturnPassword(server!.username!));
  });

  it("keeps the old Cloudflare key's relay, minting from its generate-ice-servers", async () => {
    const { fetch, calls } = fakeFetch(ok(MINTED));
    const { relay, warnings } = relayFromEnv(
      { TURN_KEY_ID: "key/1", TURN_KEY_API_TOKEN: "old-token" },
      { fetch },
    );
    assert.deepEqual(warnings, []);
    assert.equal((await relay.credentials(seat(), NOW)).length, 1);
    assert.equal(
      calls[0]!.url,
      "https://rtc.live.cloudflare.com/v1/turn/keys/key%2F1/credentials/generate-ice-servers",
    );
    assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer old-token");
  });

  it("serves the URLs the old Cloudflare key answers, not a static fallback left from before", async () => {
    const { fetch } = fakeFetch(ok(MINTED));
    const { relay, warnings } = relayFromEnv(
      {
        TURN_KEY_ID: "key-1",
        TURN_KEY_API_TOKEN: "old-token",
        TURN_URLS: "turn:fallback.example:3478",
        TURN_USERNAME: "u",
        TURN_CREDENTIAL: "p",
      },
      { fetch },
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /TURN_USERNAME, TURN_CREDENTIAL, TURN_URLS no longer configure TURN/);
    assert.deepEqual(await relay.credentials(seat(), NOW), [
      {
        urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
        username: "minted-user",
        credential: "minted-secret",
      },
    ]);
  });

  it("ignores the old Cloudflare key, and says so, when TURN_SECRET mints", async () => {
    const { relay, warnings } = relayFromEnv({
      TURN_KEY_ID: "k",
      TURN_KEY_API_TOKEN: "t",
      TURN_SECRET: SECRET,
      TURN_URLS: URLS,
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /TURN_KEY_ID, TURN_KEY_API_TOKEN no longer configure TURN/);
    assert.equal((await relay.credentials(seat(), NOW)).length, 1);
  });

  it("does not mind the old variables left blank, as .env.example used to have them", () => {
    const { warnings } = relayFromEnv({
      TURN_KEY_ID: "",
      TURN_USERNAME: " ",
      TURN_SECRET: SECRET,
      TURN_URLS: URLS,
    });
    assert.deepEqual(warnings, []);
  });
});

describe("a relay with a shared secret", () => {
  const { relay } = relayFromEnv({ TURN_SECRET: SECRET, TURN_URLS: URLS });

  it("mints a credential for the seat that expires when it does, as coturn checks it", async () => {
    const [server] = await relay.credentials(seat(), NOW);
    assert.deepEqual(server!.urls, ["turn:relay.example:3478", "turns:relay.example:443?transport=tcp"]);
    assert.equal(server!.username, `${NOW_S + 30 * 60}:s1-renter`);
    assert.equal(server!.credential, coturnPassword(server!.username!));
  });

  it("gives each side of the seat a credential of its own", async () => {
    const [renter] = await relay.credentials(seat(), NOW);
    const [host] = await relay.credentials(seat({ side: "host" }), NOW);
    assert.equal(host!.username, `${NOW_S + 30 * 60}:s1-host`);
    assert.notEqual(host!.credential, renter!.credential);
  });

  it("never hands out the secret itself", async () => {
    const served = JSON.stringify(await relay.credentials(seat(), NOW));
    assert.ok(!served.includes(SECRET));
  });

  it("gives a seat at its last moment only what it has left, and one minted by hand at most the longest session", () => {
    const urls = ["turn:relay.example:3478"];
    const last = sharedSecretCredential(SECRET, urls, seat({ expiresAt: NOW_S + 5 }), NOW);
    assert.equal(last.username, `${NOW_S + 5}:s1-renter`);
    const longest = sessionSpanMs({ rentalMode: true }, MAX_MINUTES) / 1000;
    const long = sharedSecretCredential(SECRET, urls, seat({ expiresAt: NOW_S + 7 * 86_400 }), NOW);
    assert.equal(long.username, `${NOW_S + longest}:s1-renter`);
  });

  it("lets a seat in the longest booking on a rental-mode PC keep its credential to the very end", () => {
    const end = NOW_S + sessionSpanMs({ rentalMode: true }, MAX_MINUTES) / 1000;
    assert.ok(end > NOW_S + MAX_MINUTES * 60);
    const host = sharedSecretCredential(
      SECRET,
      ["turn:relay.example:3478"],
      seat({ side: "host", expiresAt: end }),
      NOW,
    );
    assert.equal(host.username, `${end}:s1-host`);
  });

  it("mints nothing for a seat that has already ended", async () => {
    assert.deepEqual(await relay.credentials(seat({ expiresAt: NOW_S }), NOW), []);
    assert.deepEqual(await relay.credentials(seat({ expiresAt: NOW_S - 30 }), NOW), []);
  });
});

describe("a relay with a credential endpoint", () => {
  it("serves what a real Cloudflare generate-ice-servers answer mints", async () => {
    const { fetch } = fakeFetch(() => new Response(JSON.stringify(MINTED), { status: 201 }));
    const { relay, warnings } = relayFromEnv(
      { TURN_CREDENTIAL_URL: ENDPOINT, TURN_CREDENTIAL_TOKEN: "super-secret" },
      { fetch },
    );
    assert.deepEqual(warnings, []);
    assert.deepEqual(await relay.credentials(seat({ side: "host" }), NOW), [
      {
        urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
        username: "minted-user",
        credential: "minted-secret",
      },
    ]);
  });

  const env = { TURN_CREDENTIAL_URL: ENDPOINT, TURN_CREDENTIAL_TOKEN: "super-secret" };

  it("asks for a credential that lives as long as the seat, and serves its TURN entry alone", async () => {
    const { fetch, calls } = fakeFetch(ok(MINTED));
    const { relay } = relayFromEnv(env, { fetch });

    const servers = await relay.credentials(seat(), NOW);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, ENDPOINT);
    assert.equal(calls[0]!.init.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { ttl: 30 * 60 });
    assert.ok(calls[0]!.init.signal, "the request has no timeout");
    // STUN the peers already have; port 53 browsers will not dial.
    assert.deepEqual(servers, [
      {
        urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
        username: "minted-user",
        credential: "minted-secret",
      },
    ]);
  });

  it("mints afresh for every seat", async () => {
    const { fetch, calls } = fakeFetch(ok(MINTED));
    const { relay } = relayFromEnv(env, { fetch });
    await relay.credentials(seat(), NOW);
    await relay.credentials(seat({ side: "host", expiresAt: NOW_S + 600 }), NOW);
    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { ttl: 600 });
  });

  it("asks for nothing, and serves nothing, for a seat that has already ended", async () => {
    const { fetch, calls } = fakeFetch(ok(MINTED));
    const { relay } = relayFromEnv(env, { fetch });
    assert.deepEqual(await relay.credentials(seat({ expiresAt: NOW_S }), NOW), []);
    assert.equal(calls.length, 0);
  });

  // The long-term secret goes in the header and nowhere else — not the URL,
  // where it would land in any proxy or access log between here and the provider.
  it("sends the token as a bearer header, never in the url", async () => {
    const { fetch, calls } = fakeFetch(ok(MINTED));
    const { relay } = relayFromEnv(env, { fetch });
    await relay.credentials(seat(), NOW);
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer super-secret");
    assert.ok(!calls[0]!.url.includes("super-secret"));
  });

  it("follows no redirect away from the endpoint it was given", async () => {
    const { fetch, calls } = fakeFetch(ok(MINTED));
    const { relay } = relayFromEnv(env, { fetch });
    await relay.credentials(seat(), NOW);
    assert.equal(calls[0]!.init.redirect, "error");
  });

  it("puts the minted credential on TURN_URLS when they are given", async () => {
    const { fetch } = fakeFetch(ok(MINTED));
    const { relay } = relayFromEnv({ ...env, TURN_URLS: "turns:relay.example:443" }, { fetch });
    assert.deepEqual(await relay.credentials(seat(), NOW), [
      { urls: ["turns:relay.example:443"], username: "minted-user", credential: "minted-secret" },
    ]);
  });

  // A relay that cannot be reached must not take the direct paths down with it.
  for (const [what, answer] of [
    ["refuses", () => ({ ok: false, status: 403 })],
    [
      "cannot be reached",
      () => {
        throw new Error("network down");
      },
    ],
    ["answers no TURN server", ok({ iceServers: { urls: "stun:stun.cloudflare.com:3478" } })],
  ] as const) {
    it(`serves nothing, and does not throw, when the endpoint ${what}`, async (t) => {
      t.mock.method(console, "warn", () => {});
      const { fetch } = fakeFetch(answer);
      const { relay } = relayFromEnv(env, { fetch });
      assert.deepEqual(await relay.credentials(seat(), NOW), []);
    });
  }

  it("never logs a body it cannot parse, which may carry a minted credential", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const garbled = "minted-user:minted-secret";
    const { fetch } = fakeFetch(() => new Response(garbled, { status: 201 }));
    const { relay } = relayFromEnv(env, { fetch });
    assert.deepEqual(await relay.credentials(seat(), NOW), []);
    const logged = JSON.stringify(warn.mock.calls.map((call) => call.arguments));
    assert.match(logged, /not JSON/);
    assert.ok(!logged.includes("minted"));
  });
});
