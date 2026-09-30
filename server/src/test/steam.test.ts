// Steam OpenID, without talking to Steam. The two things worth testing here are
// the URLs we build and the fact that a forged assertion is refused, because
// both are security-relevant and neither needs the network.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  LIBRARY_CAP,
  b64urlEncode,
  loginUrl,
  originFrom,
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

describe("verifyAssertion", () => {
  it("returns the steamid only when Steam says the assertion is valid", async () => {
    stubFetch("ns:http://specs.openid.net/auth/2.0\nis_valid:true\n");
    const params = new URLSearchParams({
      "openid.claimed_id": "https://steamcommunity.com/openid/id/76561198000000001",
      "openid.sig": "abc",
    });
    assert.equal(await verifyAssertion(params), "76561198000000001");
  });

  it("refuses a forged assertion", async () => {
    stubFetch("is_valid:false\n");
    const params = new URLSearchParams({
      "openid.claimed_id": "https://steamcommunity.com/openid/id/76561198000000001",
    });
    assert.equal(await verifyAssertion(params), null);
  });

  it("refuses a claimed_id that is not a Steam openid identity", async () => {
    stubFetch("is_valid:true\n");
    const params = new URLSearchParams({
      "openid.claimed_id": "https://evil.example/openid/id/76561198000000001",
    });
    assert.equal(await verifyAssertion(params), null);
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
  it("flags a denied sign-in on the page the player came from", async () => {
    stubFetch("is_valid:false\n");
    const url = await returnUrl({
      origin: ORIGIN,
      searchParams: new URLSearchParams({ to: "/" }),
      apiKey: "key",
    });
    assert.equal(url, `${ORIGIN}/#steam=denied`);
  });

  it("carries the profile home in the fragment, never the query", async () => {
    stubFetch("is_valid:true\n");
    const params = new URLSearchParams({
      to: "/",
      "openid.claimed_id": "https://steamcommunity.com/openid/id/76561198000000001",
    });
    const url = new URL(await returnUrl({ origin: ORIGIN, searchParams: params, apiKey: undefined }));
    assert.equal(url.search, "");
    assert.ok(url.hash.startsWith("#steam="));
    const json = Buffer.from(
      url.hash.slice("#steam=".length).replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    assert.equal(JSON.parse(json).id, "0001");
  });
});

describe("b64urlEncode", () => {
  it("emits fragment-safe base64", () => {
    const encoded = b64urlEncode({ persona: "kai?+/=nx" });
    assert.ok(!/[+/=]/.test(encoded));
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
