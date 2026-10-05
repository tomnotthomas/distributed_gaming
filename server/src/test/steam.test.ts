// Steam OpenID, without talking to Steam. The two things worth testing here are
// the URLs we build and the fact that a forged assertion is refused, because
// both are security-relevant and neither needs the network.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  LIBRARY_CANDIDATES,
  PROFILE_REFRESH_MIN_MS,
  PROFILE_TTL_MS,
  cachedProfiles,
  emptyProfile,
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
      ...Array.from({ length: LIBRARY_CANDIDATES + 6 }, (_, i) => ({
        appid: 900000 + i,
        name: `Game ${i}`,
        playtime_forever: (LIBRARY_CANDIDATES + 6 - i) * 60,
      })),
    ];
    stubFetch({ response: { games, players: [{ personaname: "kai_nx" }] } });

    const profile = await readProfile("key", "76561198000000001");
    assert.deepEqual(profile.owned, [[730, 300]]);
    assert.equal(profile.games.length, LIBRARY_CANDIDATES);
    // Most played first, and no curated title duplicated into the library.
    assert.equal(profile.games[0]![1], "Game 0");
    assert.ok(!profile.games.some(([appid]) => appid === 730));
    assert.equal(profile.size, games.length);
  });

  it("gives up on a Steam that does not answer in time", async () => {
    globalThis.fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
      )) as typeof fetch;
    // AbortSignal.timeout does not hold the event loop open on its own.
    const alive = setInterval(() => {}, 1_000);
    try {
      await assert.rejects(readProfile("key", "76561198000000001", 20));
    } finally {
      clearInterval(alive);
    }
  });
});

describe("cachedProfiles", () => {
  const ID = "76561198000000001";

  /** A read that counts its calls and answers `result` (a rejection when it is an Error). */
  function counted(result: () => Promise<ReturnType<typeof emptyProfile>>) {
    const read = async (steamId: string) => {
      read.calls.push(steamId);
      return result();
    };
    read.calls = [] as string[];
    return read;
  }

  it("serves a profile again within the ttl without asking Steam, and reads again after", async () => {
    let now = 0;
    const read = counted(async () => ({ ...emptyProfile(ID), persona: "kai_nx" }));
    const profile = cachedProfiles(read, { now: () => now });

    assert.equal((await profile(ID)).persona, "kai_nx");
    now += PROFILE_TTL_MS - 1;
    await profile(ID);
    assert.equal(read.calls.length, 1);

    now += 1;
    await profile(ID);
    assert.equal(read.calls.length, 2);
  });

  it("asks Steam again on a fresh read, but not twice within the refresh floor", async () => {
    let now = 0;
    let persona = "private";
    const read = counted(async () => ({ ...emptyProfile(ID), persona }));
    const profile = cachedProfiles(read, { now: () => now });

    await profile(ID);
    persona = "public";
    now += PROFILE_REFRESH_MIN_MS - 1;
    assert.equal((await profile(ID, { fresh: true })).persona, "private");
    assert.equal(read.calls.length, 1);

    now += 1;
    assert.equal((await profile(ID, { fresh: true })).persona, "public");
    assert.equal(read.calls.length, 2);
    // The fresh read is what later page loads are served.
    assert.equal((await profile(ID)).persona, "public");
    assert.equal(read.calls.length, 2);
  });

  it("shares one Steam read between concurrent fresh lookups, and reads again once it settles", async () => {
    let release!: () => void;
    const read = counted(
      () => new Promise((resolve) => (release = () => resolve({ ...emptyProfile(ID), persona: "kai_nx" }))),
    );
    const profile = cachedProfiles(read, { refreshMinMs: 0 });

    const both = Promise.all([profile(ID, { fresh: true }), profile(ID, { fresh: true })]);
    release();
    assert.deepEqual(
      (await both).map((p) => p.persona),
      ["kai_nx", "kai_nx"],
    );
    assert.equal(read.calls.length, 1);

    const again = profile(ID, { fresh: true });
    release();
    await again;
    assert.equal(read.calls.length, 2);
  });

  it("lets a lookup after a failed shared read ask Steam again once the refresh floor passes", async () => {
    let now = 0;
    let fail = true;
    const read = counted(async () => {
      if (fail) throw new Error("steam down");
      return emptyProfile(ID);
    });
    const profile = cachedProfiles(read, { now: () => now });
    await Promise.all([assert.rejects(profile(ID)), assert.rejects(profile(ID))]);
    assert.equal(read.calls.length, 1);
    fail = false;
    now += PROFILE_REFRESH_MIN_MS;
    await profile(ID);
    assert.equal(read.calls.length, 2);
  });

  it("does not remember a failed read", async () => {
    let now = 0;
    let fail = true;
    const read = counted(async () => {
      if (fail) throw new Error("steam down");
      return emptyProfile(ID);
    });
    const profile = cachedProfiles(read, { now: () => now });

    await assert.rejects(profile(ID));
    fail = false;
    now += PROFILE_REFRESH_MIN_MS;
    await profile(ID);
    await profile(ID);
    assert.equal(read.calls.length, 2);
  });

  it("does not ask a failing Steam again within the refresh floor, however often the renter refreshes", async () => {
    let now = 0;
    let fail = false;
    const read = counted(async () => {
      if (fail) throw new Error("steam down");
      return { ...emptyProfile(ID), persona: "kai_nx" };
    });
    const profile = cachedProfiles(read, { now: () => now });

    // No good profile yet: repeated refreshes reject without reaching Steam.
    fail = true;
    await assert.rejects(profile(ID, { fresh: true }));
    for (let i = 0; i < 5; i++) await assert.rejects(profile(ID, { fresh: true }));
    assert.equal(read.calls.length, 1);

    // Once a read succeeds, a later failure leaves the renter on their last good profile.
    fail = false;
    now += PROFILE_REFRESH_MIN_MS;
    await profile(ID);
    fail = true;
    now += PROFILE_REFRESH_MIN_MS;
    await assert.rejects(profile(ID, { fresh: true }));
    for (let i = 0; i < 5; i++) assert.equal((await profile(ID, { fresh: true })).persona, "kai_nx");
    assert.equal(read.calls.length, 3);

    now += PROFILE_REFRESH_MIN_MS;
    fail = false;
    await profile(ID, { fresh: true });
    assert.equal(read.calls.length, 4);
  });

  it("holds at most max profiles, dropping the oldest", async () => {
    const read = counted(async () => emptyProfile(ID));
    const profile = cachedProfiles(read, { max: 2 });
    for (const id of ["a", "b", "c", "b", "a"]) await profile(id);
    assert.deepEqual(read.calls, ["a", "b", "c", "a"]);
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
