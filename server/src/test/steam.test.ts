// Steam OpenID, without talking to Steam. The two things worth testing here are
// the URLs we build and the fact that a forged assertion is refused, because
// both are security-relevant and neither needs the network.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  LIBRARY_CAP,
  loginUrl,
  originFrom,
  publicOriginFromEnv,
  readProfile,
  returnUrl,
  verifyAssertion,
} from "../steam.js";

const ORIGIN = "https://swiff.example";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer every fetch with one body, and record what was asked. */
function stubFetch(body: string | object) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    calls.push(String(input));
    return {
      ok: true,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    };
  }) as typeof fetch;
  return calls;
}

describe("loginUrl", () => {
  it("asks Steam for identifier_select and comes back to our own return route", () => {
    const url = new URL(loginUrl({ origin: ORIGIN, returnTo: "/" }));
    assert.equal(url.origin + url.pathname, "https://steamcommunity.com/openid/login");
    assert.equal(url.searchParams.get("openid.mode"), "checkid_setup");
    assert.equal(url.searchParams.get("openid.realm"), ORIGIN);
    assert.equal(url.searchParams.get("openid.return_to"), `${ORIGIN}/auth/steam/return?to=%2F`);
  });

  it("refuses an absolute returnTo, so this is not an open redirector", () => {
    const url = new URL(loginUrl({ origin: ORIGIN, returnTo: "https://evil.example/steal" }));
    const back = new URL(url.searchParams.get("openid.return_to")!);
    assert.equal(back.origin, ORIGIN);
    assert.equal(back.searchParams.get("to"), "/");
  });
});

/** An assertion Steam made for this site's return route, with overrides. */
function assertion(overrides: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    "openid.op_endpoint": "https://steamcommunity.com/openid/login",
    "openid.return_to": `${ORIGIN}/auth/steam/return?to=%2F`,
    "openid.claimed_id": "https://steamcommunity.com/openid/id/76561198000000001",
    "openid.sig": "abc",
    ...overrides,
  });
}

describe("verifyAssertion", () => {
  it("returns the steamid only when Steam says the assertion is valid", async () => {
    stubFetch("ns:http://specs.openid.net/auth/2.0\nis_valid:true\n");
    assert.equal(await verifyAssertion(assertion(), ORIGIN), "76561198000000001");
  });

  it("refuses a forged assertion", async () => {
    stubFetch("is_valid:false\n");
    assert.equal(await verifyAssertion(assertion(), ORIGIN), null);
  });

  it("refuses a claimed_id that is not a Steam openid identity", async () => {
    stubFetch("is_valid:true\n");
    const params = assertion({ "openid.claimed_id": "https://evil.example/openid/id/76561198000000001" });
    assert.equal(await verifyAssertion(params, ORIGIN), null);
  });

  it("refuses a genuine assertion Steam made for another site", async () => {
    // Steam would vouch for it: the signature is real, only the audience is wrong.
    const calls = stubFetch("is_valid:true\n");
    for (const returnTo of [
      "https://other.example/auth/steam/return",
      `${ORIGIN}.evil.example/auth/steam/return`,
      `${ORIGIN}/auth/steam/returned`,
      "not a url",
    ]) {
      assert.equal(await verifyAssertion(assertion({ "openid.return_to": returnTo }), ORIGIN), null);
    }
    const missing = assertion();
    missing.delete("openid.return_to");
    assert.equal(await verifyAssertion(missing, ORIGIN), null);
    assert.deepEqual(calls, []);
  });

  it("refuses an assertion from any provider but Steam", async () => {
    const calls = stubFetch("is_valid:true\n");
    for (const endpoint of ["https://evil.example/openid/login", "http://steamcommunity.com/openid/login"]) {
      assert.equal(await verifyAssertion(assertion({ "openid.op_endpoint": endpoint }), ORIGIN), null);
    }
    const missing = assertion();
    missing.delete("openid.op_endpoint");
    assert.equal(await verifyAssertion(missing, ORIGIN), null);
    assert.deepEqual(calls, []);
  });
});

describe("readProfile", () => {
  it("returns an empty profile without an API key, rather than throwing", async () => {
    const profile = await readProfile(undefined, "76561198000000001");
    assert.equal(profile.lib, false);
    assert.equal(profile.id, "0001");
    assert.deepEqual(profile.games, []);
  });

  it("splits the curated wall titles from the rest and caps the library", async () => {
    const games = [
      { appid: 730, name: "Counter-Strike 2", playtime_forever: 18000 },
      ...Array.from({ length: LIBRARY_CAP + 6 }, (_, i) => ({
        appid: 900000 + i,
        name: `Game ${i}`,
        playtime_forever: (LIBRARY_CAP + 6 - i) * 60,
      })),
    ];
    stubFetch({ response: { games, players: [{ personaname: "kai_nx" }] } });

    const profile = await readProfile("key", "76561198000000001");
    assert.deepEqual(profile.owned, [[730, 300]]);
    assert.equal(profile.games.length, LIBRARY_CAP);
    // Most played first, and no curated title duplicated into the library.
    assert.equal(profile.games[0]![1], "Game 0");
    assert.ok(!profile.games.some(([appid]) => appid === 730));
    assert.equal(profile.size, games.length);
  });
});

describe("returnUrl", () => {
  it("flags a denied sign-in on the page the player came from, naming nobody", async () => {
    stubFetch("is_valid:false\n");
    const back = await returnUrl({ origin: ORIGIN, searchParams: new URLSearchParams({ to: "/" }) });
    assert.deepEqual(back, { location: `${ORIGIN}/#steam=denied`, steamId: null });
  });

  it("names the Steam id Steam vouched for and carries no profile in the URL", async () => {
    stubFetch("is_valid:true\n");
    const params = assertion({ to: "/games" });
    const back = await returnUrl({ origin: ORIGIN, searchParams: params });
    assert.equal(back.steamId, "76561198000000001");
    assert.equal(back.location, `${ORIGIN}/games#steam=ok`);
  });

  it("denies an assertion made for another site's return route", async () => {
    stubFetch("is_valid:true\n");
    const params = assertion({ to: "/games", "openid.return_to": "https://other.example/auth/steam/return" });
    const back = await returnUrl({ origin: ORIGIN, searchParams: params });
    assert.deepEqual(back, { location: `${ORIGIN}/games#steam=denied`, steamId: null });
  });
});

describe("originFrom", () => {
  it("keeps loopback on http, in every form it arrives as", () => {
    // Guessing https here builds an openid.realm Steam cannot reach.
    for (const host of ["localhost:8080", "127.0.0.1:8099", "[::1]:8080", "app.localhost"]) {
      assert.equal(originFrom({ host }, "http://fallback"), `http://${host}`);
    }
  });

  it("assumes https for a real host", () => {
    assert.equal(originFrom({ host: "swiff.example" }, "http://fallback"), "https://swiff.example");
  });

  it("trusts a proxy's forwarded proto and host over the guess", () => {
    assert.equal(
      originFrom(
        { host: "internal:8080", "x-forwarded-host": "swiff.example", "x-forwarded-proto": "https" },
        "http://fallback",
      ),
      "https://swiff.example",
    );
  });

  it("falls back when there is no host header at all", () => {
    assert.equal(originFrom({}, "http://fallback"), "http://fallback");
  });
});

describe("publicOriginFromEnv", () => {
  it("takes PUBLIC_ORIGIN as an origin, whatever the environment", () => {
    const env = { PUBLIC_ORIGIN: " https://swiff.example/ ", NODE_ENV: "production" };
    assert.equal(publicOriginFromEnv(env, 8080), ORIGIN);
  });

  it("defaults to plain-http localhost only outside production", () => {
    assert.equal(publicOriginFromEnv({}, 8080), "http://localhost:8080");
    assert.equal(publicOriginFromEnv({ NODE_ENV: "production" }, 8080), null);
  });

  it("refuses a PUBLIC_ORIGIN that is not an http(s) URL", () => {
    for (const PUBLIC_ORIGIN of ["swiff.example", "ftp://swiff.example"])
      assert.equal(publicOriginFromEnv({ PUBLIC_ORIGIN }, 8080), null);
  });
});
