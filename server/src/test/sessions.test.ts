// Unit tests for session keys and the live-session store. The server tests
// cover how a room uses them; these cover the credentials themselves.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mintSessionKey, mintTicket, verifySessionKey, verifyTicket } from "../access.js";
import { createHostSessions } from "../sessions.js";

const SECRET = "a-secret-that-is-at-least-32-characters";

describe("session keys", () => {
  it("round-trips room, session and expiry", () => {
    const now = 1_700_000_000_000;
    const key = verifySessionKey(SECRET, mintSessionKey(SECRET, "pc-1", "s1", 300, now), now);
    assert.deepEqual(key, { room: "pc-1", session: "s1", exp: now / 1000 + 300 });
  });

  it("rejects an expired key", () => {
    const now = Date.now();
    const token = mintSessionKey(SECRET, "pc-1", "s1", 60, now);
    assert.ok(verifySessionKey(SECRET, token, now + 59_000));
    assert.equal(verifySessionKey(SECRET, token, now + 60_000), null);
  });

  it("rejects a key signed with another secret", () => {
    assert.equal(verifySessionKey(SECRET, mintSessionKey(`${SECRET}-other`, "pc-1", "s1", 300)), null);
  });

  it("is never a join ticket, and a join ticket is never a session key", () => {
    assert.equal(verifyTicket(SECRET, mintSessionKey(SECRET, "pc-1", "s1", 300)), null);
    assert.equal(verifySessionKey(SECRET, mintTicket(SECRET, "pc-1", 300)), null);
  });

  it("rejects anything that is not a key", () => {
    for (const token of [undefined, null, 42, "", "a", "a.b", "a.b.c"]) {
      assert.equal(verifySessionKey(SECRET, token), null, `accepted ${String(token)}`);
    }
  });
});

describe("host sessions", () => {
  it("accepts a key only while its session is live", () => {
    const sessions = createHostSessions(SECRET);
    const grant = sessions.start("pc-1");
    assert.ok(grant);
    assert.equal(sessions.verify(grant.sessionKey)?.room, "pc-1");
    assert.equal(sessions.end("pc-1"), grant.sessionId);
    assert.equal(sessions.verify(grant.sessionKey), null, "revoked key still accepted");
  });

  it("refuses a second start while a session is live", () => {
    const sessions = createHostSessions(SECRET);
    assert.ok(sessions.start("pc-1"));
    assert.equal(sessions.start("pc-1"), null);
    assert.ok(sessions.start("pc-2"), "other rooms are unaffected");
  });

  it("does not revive a key from an earlier session of the same room", () => {
    const sessions = createHostSessions(SECRET);
    const first = sessions.start("pc-1")!;
    sessions.end("pc-1");
    const second = sessions.start("pc-1")!;
    assert.equal(sessions.verify(first.sessionKey), null);
    assert.ok(sessions.verify(second.sessionKey));
  });

  it("renews with a fresh key for the same session, and only while live", () => {
    const sessions = createHostSessions(SECRET, 60);
    const now = Date.now();
    const grant = sessions.start("pc-1", now)!;
    const later = now + 120_000;
    assert.equal(sessions.verify(grant.sessionKey, later), null, "the first key expired");
    const renewed = sessions.renew("pc-1", later)!;
    assert.equal(renewed.sessionId, grant.sessionId);
    assert.ok(sessions.verify(renewed.sessionKey, later));
    sessions.end("pc-1");
    assert.equal(sessions.renew("pc-1"), null);
  });

  it("treats ending a room with no session as done", () => {
    assert.equal(createHostSessions(SECRET).end("pc-1"), null);
  });
});
