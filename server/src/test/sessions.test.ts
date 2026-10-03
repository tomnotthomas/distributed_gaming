// Unit tests for session keys and the live-session store. The server tests
// cover how a room uses them; these cover the credentials themselves.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mintSessionKey, mintTicket, verifySessionKey, verifyTicket } from "../access.js";
import { createHostSessions } from "../sessions.js";

const SECRET = "a-secret-that-is-at-least-32-characters";
const S1 = { room: "pc-1", session: "s1", grant: "g1" };

describe("session keys", () => {
  it("round-trips room, session and expiry", () => {
    const now = 1_700_000_000_000;
    const key = verifySessionKey(SECRET, mintSessionKey(SECRET, S1, 300, now), now);
    assert.deepEqual(key, { ...S1, exp: now / 1000 + 300 });
  });

  it("rejects an expired key", () => {
    const now = Date.now();
    const token = mintSessionKey(SECRET, S1, 60, now);
    assert.ok(verifySessionKey(SECRET, token, now + 59_000));
    assert.equal(verifySessionKey(SECRET, token, now + 60_000), null);
  });

  it("rejects a key signed with another secret", () => {
    assert.equal(verifySessionKey(SECRET, mintSessionKey(`${SECRET}-other`, S1, 300)), null);
  });

  it("is never a join ticket, and a join ticket is never a session key", () => {
    assert.equal(verifyTicket(SECRET, mintSessionKey(SECRET, S1, 300)), null);
    assert.equal(verifySessionKey(SECRET, mintTicket(SECRET, "pc-1", 300)), null);
  });

  it("rejects anything that is not a key", () => {
    // A key from before grants existed has none, and opens nothing.
    const grantless = mintSessionKey(SECRET, { room: "pc-1", session: "s1" } as typeof S1, 300);
    for (const token of [undefined, null, 42, "", "a", "a.b", "a.b.c", grantless]) {
      assert.equal(verifySessionKey(SECRET, token), null, `accepted ${String(token)}`);
    }
  });
});

describe("host sessions", () => {
  it("accepts a key only while its session is live", async () => {
    const sessions = createHostSessions(SECRET);
    const grant = await sessions.start("pc-1", "s1");
    assert.ok(grant);
    assert.equal((await sessions.verify(grant.sessionKey))?.room, "pc-1");
    assert.equal(await sessions.end("pc-1"), grant.sessionId);
    assert.equal(await sessions.verify(grant.sessionKey), null, "revoked key still accepted");
  });

  it("refuses a second start while a session is live", async () => {
    const sessions = createHostSessions(SECRET);
    assert.ok(await sessions.start("pc-1", "s1"));
    assert.equal(await sessions.start("pc-1", "s1"), null);
    assert.ok(await sessions.start("pc-2", "s2"), "other rooms are unaffected");
  });

  it("does not revive a key from an earlier session of the same room", async () => {
    const sessions = createHostSessions(SECRET);
    const first = (await sessions.start("pc-1", "s1"))!;
    await sessions.end("pc-1");
    const second = (await sessions.start("pc-1", "s2"))!;
    assert.equal(await sessions.verify(first.sessionKey), null);
    assert.ok(await sessions.verify(second.sessionKey));
  });

  it("does not revive an ended key when the same session starts again", async () => {
    const sessions = createHostSessions(SECRET);
    const first = (await sessions.start("pc-1", "s1"))!;
    await sessions.end("pc-1");
    const again = (await sessions.start("pc-1", "s1"))!;
    assert.equal(again.sessionId, "s1", "the session keeps its id");
    assert.equal(await sessions.verify(first.sessionKey), null, "a key from before the end still accepted");
    assert.ok(await sessions.verify(again.sessionKey));
  });

  it("grants the session id it was asked for", async () => {
    assert.equal(
      (await createHostSessions(SECRET).start("pc-1", "platform-session"))?.sessionId,
      "platform-session",
    );
  });

  it("treats ending a room with no session as done", async () => {
    assert.equal(await createHostSessions(SECRET).end("pc-1"), null);
  });
});
