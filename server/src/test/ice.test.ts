import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createIceSource, turnServersFromEnv } from "../ice.js";

describe("turnServersFromEnv", () => {
  it("returns nothing when TURN_URLS is unset, so the server sends no iceServers", () => {
    assert.deepEqual(turnServersFromEnv({}), []);
    assert.deepEqual(turnServersFromEnv({ TURN_URLS: " , " }), []);
  });

  it("splits and trims the urls into one server entry with its credentials", () => {
    const servers = turnServersFromEnv({
      TURN_URLS: "turn:t.example:3478, turns:t.example:443?transport=tcp",
      TURN_USERNAME: "u",
      TURN_CREDENTIAL: "p",
    });
    assert.deepEqual(servers, [
      { urls: ["turn:t.example:3478", "turns:t.example:443?transport=tcp"], username: "u", credential: "p" },
    ]);
  });
});

/** A fetch that answers from a script, recording what it was asked. */
function fakeFetch(steps: (() => unknown)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let n = 0;
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const step = steps[Math.min(n, steps.length - 1)]!;
    n += 1;
    return step() as Response;
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const ok = (body: unknown) => () =>
  ({ ok: true, status: 201, json: async () => body }) as unknown as Response;

const MINTED = {
  iceServers: {
    urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478?transport=udp"],
    username: "minted-user",
    credential: "minted-secret",
  },
};

describe("createIceSource", () => {
  it("serves the static pair unchanged when there is no key to mint from", async () => {
    const source = createIceSource({ TURN_URLS: "turn:t.example:3478", TURN_USERNAME: "u" });
    await source.start();

    assert.deepEqual(source.servers(), [{ urls: ["turn:t.example:3478"], username: "u" }]);
    source.stop();
  });

  it("serves nothing at all when neither a key nor urls are configured", async () => {
    const source = createIceSource({});
    await source.start();

    assert.deepEqual(source.servers(), []);
    source.stop();
  });

  it("mints credentials from the key and serves those", async () => {
    const { fetch, calls } = fakeFetch([ok(MINTED)]);
    const source = createIceSource(
      { TURN_KEY_ID: "key-1", TURN_KEY_API_TOKEN: "tok", TURN_TTL_SECONDS: "3600" },
      { fetch, setTimeout: (() => 0) as never },
    );

    await source.start();

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.match(call.url, /\/v1\/turn\/keys\/key-1\/credentials\/generate-ice-servers$/);
    assert.equal(call.init.method, "POST");
    assert.deepEqual(JSON.parse(String(call.init.body)), { ttl: 3600 });
    assert.deepEqual(source.servers(), [MINTED.iceServers]);
    source.stop();
  });

  // The long-term secret goes in the header and nowhere else — not the URL,
  // where it would land in any proxy or access log between here and Cloudflare.
  it("sends the api token as a bearer header, never in the url", async () => {
    const { fetch, calls } = fakeFetch([ok(MINTED)]);
    const source = createIceSource(
      { TURN_KEY_ID: "key-1", TURN_KEY_API_TOKEN: "super-secret" },
      { fetch, setTimeout: (() => 0) as never },
    );

    await source.start();

    const call = calls[0]!;
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer super-secret");
    assert.ok(!call.url.includes("super-secret"));
    source.stop();
  });

  // A relay that cannot be reached must not take the LAN case down with it.
  it("keeps serving and does not throw when minting fails", async () => {
    const { fetch } = fakeFetch([() => ({ ok: false, status: 403 }) as unknown as Response]);
    const source = createIceSource(
      { TURN_KEY_ID: "key-1", TURN_KEY_API_TOKEN: "tok" },
      { fetch, setTimeout: (() => 0) as never },
    );

    await source.start();

    assert.deepEqual(source.servers(), []);
    source.stop();
  });

  it("falls back to a hand-supplied pair when the first mint fails", async () => {
    const { fetch } = fakeFetch([
      () => {
        throw new Error("network down");
      },
    ]);
    const source = createIceSource(
      {
        TURN_KEY_ID: "key-1",
        TURN_KEY_API_TOKEN: "tok",
        TURN_URLS: "turn:fallback.example:3478",
      },
      { fetch, setTimeout: (() => 0) as never },
    );

    await source.start();

    assert.deepEqual(source.servers(), [{ urls: ["turn:fallback.example:3478"] }]);
    source.stop();
  });

  it("refreshes before the credentials expire, and stops when told to", async () => {
    const { fetch, calls } = fakeFetch([ok(MINTED)]);
    let scheduled: (() => void) | undefined;
    let delay = 0;
    let cleared = false;

    const source = createIceSource(
      { TURN_KEY_ID: "key-1", TURN_KEY_API_TOKEN: "tok", TURN_TTL_SECONDS: "1000" },
      {
        fetch,
        setTimeout: ((fn: () => void, ms: number) => {
          scheduled = fn;
          delay = ms;
          return 1;
        }) as never,
        clearTimeout: (() => {
          cleared = true;
        }) as never,
      },
    );

    await source.start();

    // 80% of 1000s, with a fifth of the lifetime still in hand to retry.
    assert.equal(delay, 800_000);
    assert.ok(scheduled, "no refresh was scheduled");

    scheduled!();
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 2, "the scheduled refresh did not mint again");

    source.stop();
    assert.ok(cleared, "stop() left the refresh timer running");
  });

  it("does not mint again after stop", async () => {
    const { fetch, calls } = fakeFetch([ok(MINTED)]);
    const source = createIceSource(
      { TURN_KEY_ID: "key-1", TURN_KEY_API_TOKEN: "tok" },
      { fetch, setTimeout: (() => 0) as never },
    );

    source.stop();
    await source.start();

    assert.equal(calls.length, 0);
  });
});
